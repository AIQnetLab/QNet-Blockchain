#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: node_startup_integration.py
Handles the node startup process with activation code verification and transfer capabilities.
"""

import os
import json
import time
import logging
import sys
import hashlib
import getpass
import socket
import requests
import uuid
import sqlite3
from datetime import datetime, timedelta
import threading
from functools import wraps

# Configure logging
logging.basicConfig(level=logging.INFO,
                   format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

# Constants
CONFIG_DIR = os.path.join(os.path.expanduser('~'), '.qnet')
ACTIVATION_FILE = os.path.join(CONFIG_DIR, 'activation.json')
CACHE_DIR = os.path.join(CONFIG_DIR, 'cache')
GRACE_PERIOD = 172800  # 48 hours in seconds
MAX_OFFLINE_TIME = 259200  # 3 days - max time node can operate offline
HEARTBEAT_INTERVAL = 3600  # 1 hour - how often to send heartbeat
DEFAULT_VERIFICATION_ENDPOINT = "http://localhost:8000/api/v1/token/verify_code"
DEFAULT_HEARTBEAT_ENDPOINT = "http://localhost:8000/api/v1/token/heartbeat"

# Ensure directories exist
os.makedirs(CONFIG_DIR, exist_ok=True)
os.makedirs(CACHE_DIR, exist_ok=True)

class RetryWithBackoff:
    """Retry decorator with exponential backoff"""
    
    def __init__(self, max_retries=3, initial_delay=1, backoff_factor=2, exceptions=(Exception,)):
        self.max_retries = max_retries
        self.initial_delay = initial_delay
        self.backoff_factor = backoff_factor
        self.exceptions = exceptions
    
    def __call__(self, func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            delay = self.initial_delay
            
            for retry in range(self.max_retries):
                try:
                    return func(*args, **kwargs)
                except self.exceptions as e:
                    if retry == self.max_retries - 1:
                        # Last retry failed, re-raise exception
                        raise
                    
                    logger.warning(f"Retry {retry+1}/{self.max_retries} after error: {e}. Retrying in {delay}s")
                    time.sleep(delay)
                    delay *= self.backoff_factor
        
        return wrapper

class NodeCacheManager:
    """Manages cache for offline operation"""
    
    def __init__(self, cache_dir=CACHE_DIR):
        self.cache_dir = cache_dir
        self.verification_cache_file = os.path.join(cache_dir, 'verification_cache.json')
        self.cache_lock = threading.RLock()
        
        # Ensure cache directory exists
        os.makedirs(cache_dir, exist_ok=True)
        
        # Initialize cache if it doesn't exist
        if not os.path.exists(self.verification_cache_file):
            self._save_cache({
                'last_successful_verification': 0,
                'remaining_offline_allowance': MAX_OFFLINE_TIME,
                'verification_history': []
            })
    
    def _load_cache(self):
        """Load cache from file"""
        with self.cache_lock:
            try:
                if os.path.exists(self.verification_cache_file):
                    with open(self.verification_cache_file, 'r') as f:
                        return json.load(f)
                return {}
            except Exception as e:
                logger.error(f"Error loading cache: {e}")
                return {}
    
    def _save_cache(self, cache_data):
        """Save cache to file"""
        with self.cache_lock:
            try:
                with open(self.verification_cache_file, 'w') as f:
                    json.dump(cache_data, f, indent=2)
                return True
            except Exception as e:
                logger.error(f"Error saving cache: {e}")
                return False
    
    def update_verification_cache(self, success, timestamp=None):
        """Update verification cache after an attempt"""
        if timestamp is None:
            timestamp = time.time()
            
        with self.cache_lock:
            cache = self._load_cache()
            
            # Add to history (keep last 10 entries)
            history = cache.get('verification_history', [])
            history.append({'success': success, 'timestamp': timestamp})
            if len(history) > 10:
                history = history[-10:]
            
            if success:
                # Update last successful verification
                cache['last_successful_verification'] = timestamp
                
                # Reset offline allowance
                cache['remaining_offline_allowance'] = MAX_OFFLINE_TIME
            else:
                # Reduce offline allowance
                remaining = cache.get('remaining_offline_allowance', MAX_OFFLINE_TIME)
                last_success = cache.get('last_successful_verification', 0)
                
                # Only reduce if we've tried recently
                if timestamp - last_success < GRACE_PERIOD:
                    # Reduce by time since last check
                    last_check = history[-2]['timestamp'] if len(history) > 1 else last_success
                    reduction = timestamp - last_check
                    remaining = max(0, remaining - reduction)
                    cache['remaining_offline_allowance'] = remaining
            
            cache['verification_history'] = history
            return self._save_cache(cache)
    
    def can_operate_offline(self):
        """Check if node can operate in offline mode"""
        with self.cache_lock:
            cache = self._load_cache()
            
            # Get values
            remaining = cache.get('remaining_offline_allowance', 0)
            last_success = cache.get('last_successful_verification', 0)
            
            # Check remaining allowance
            if remaining <= 0:
                return False
            
            # Check last successful verification within grace period
            now = time.time()
            time_since_success = now - last_success
            
            logger.info(f"Offline operation check: Time since last success: {time_since_success}s, Remaining allowance: {remaining}s")
            
            if time_since_success > GRACE_PERIOD:
                # Additional grace period check
                if time_since_success > GRACE_PERIOD + remaining:
                    return False
            
            return True
    
    def get_cache_status(self):
        """Get cache status information"""
        with self.cache_lock:
            cache = self._load_cache()
            
            now = time.time()
            last_success = cache.get('last_successful_verification', 0)
            remaining = cache.get('remaining_offline_allowance', 0)
            history = cache.get('verification_history', [])
            
            return {
                'last_successful': datetime.fromtimestamp(last_success).strftime('%Y-%m-%d %H:%M:%S') if last_success else 'Never',
                'time_since_success': now - last_success if last_success else float('inf'),
                'remaining_offline_allowance': remaining,
                'can_operate_offline': self.can_operate_offline(),
                'verification_history': [
                    {
                        'success': entry['success'],
                        'timestamp': datetime.fromtimestamp(entry['timestamp']).strftime('%Y-%m-%d %H:%M:%S')
                    }
                    for entry in history
                ]
            }

class LocalTransferManager:
    """Manages node transfer from the node perspective"""
    
    def __init__(self, data_dir=CONFIG_DIR):
        """Initialize transfer manager"""
        self.data_dir = data_dir
        self.transfer_file = os.path.join(data_dir, 'transfer.json')
    
    def initiate_transfer(self, activation_code, transfer_code, wallet_address):
        """
        Initiate node transfer to move to a new device
        
        Args:
            activation_code: Current activation code
            transfer_code: Code received from API
            wallet_address: Associated wallet address
            
        Returns:
            bool: Success status
        """
        try:
            transfer_data = {
                'activation_code': activation_code,
                'transfer_code': transfer_code,
                'wallet_address': wallet_address,
                'initiated_at': time.time(),
                'status': 'pending'
            }
            
            with open(self.transfer_file, 'w') as f:
                json.dump(transfer_data, f, indent=2)
            
            # Set permissions
            os.chmod(self.transfer_file, 0o600)
            
            return True
        except Exception as e:
            logger.error(f"Error initiating transfer: {e}")
            return False
    
    def get_transfer_status(self):
        """
        Get current transfer status
        
        Returns:
            dict: Transfer status information or None if no transfer
        """
        if not os.path.exists(self.transfer_file):
            return None
            
        try:
            with open(self.transfer_file, 'r') as f:
                transfer_data = json.load(f)
            
            # Add formatted timestamps
            initiated_at = transfer_data.get('initiated_at', 0)
            transfer_data['initiated_at_formatted'] = datetime.fromtimestamp(
                initiated_at).strftime('%Y-%m-%d %H:%M:%S')
            
            return transfer_data
        except Exception as e:
            logger.error(f"Error getting transfer status: {e}")
            return None
    
    def complete_transfer(self, success=True, message=None):
        """
        Mark transfer as complete
        
        Args:
            success: Whether transfer completed successfully
            message: Optional message about transfer result
            
        Returns:
            bool: Operation success
        """
        if not os.path.exists(self.transfer_file):
            return False
            
        try:
            with open(self.transfer_file, 'r') as f:
                transfer_data = json.load(f)
            
            transfer_data['status'] = 'completed' if success else 'failed'
            transfer_data['completed_at'] = time.time()
            if message:
                transfer_data['message'] = message
            
            with open(self.transfer_file, 'w') as f:
                json.dump(transfer_data, f, indent=2)
            
            return True
        except Exception as e:
            logger.error(f"Error completing transfer: {e}")
            return False
    
    def cancel_transfer(self):
        """
        Cancel in-progress transfer
        
        Returns:
            bool: Operation success
        """
        if not os.path.exists(self.transfer_file):
            return False
            
        try:
            with open(self.transfer_file, 'r') as f:
                transfer_data = json.load(f)
            
            transfer_data['status'] = 'cancelled'
            transfer_data['cancelled_at'] = time.time()
            
            with open(self.transfer_file, 'w') as f:
                json.dump(transfer_data, f, indent=2)
            
            return True
        except Exception as e:
            logger.error(f"Error cancelling transfer: {e}")
            return False
    
    def import_transfer(self, transfer_file_path):
        """
        Import transfer data from file
        
        Args:
            transfer_file_path: Path to transfer file
            
        Returns:
            dict: Transfer data or None if failed
        """
        if not os.path.exists(transfer_file_path):
            logger.error(f"Transfer file not found: {transfer_file_path}")
            return None
            
        try:
            with open(transfer_file_path, 'r') as f:
                transfer_data = json.load(f)
            
            # Verify data format
            required_fields = ['activation_code', 'transfer_code', 'wallet_address']
            if not all(field in transfer_data for field in required_fields):
                logger.error("Invalid transfer file format")
                return None
            
            # Save to local transfer file
            with open(self.transfer_file, 'w') as f:
                json.dump(transfer_data, f, indent=2)
            
            # Set permissions
            os.chmod(self.transfer_file, 0o600)
            
            return transfer_data
        except Exception as e:
            logger.error(f"Error importing transfer: {e}")
            return None

class NodeActivation:
    """Handles node activation using verification codes with enhanced security and transfer support"""
    
    def __init__(self, config_file=None):
        """
        Initialize the node activation handler
        
        Args:
            config_file: Path to the configuration file
        """
        self.config_file = config_file
        self.config = self._load_config()
        self.activation_data = self._load_activation_data()
        self.node_id = self._generate_node_id()
        self.cache_manager = NodeCacheManager()
        self.transfer_manager = LocalTransferManager()
        self.heartbeat_thread = None
        self.running = False
        
        # API endpoints
        self.verification_endpoint = self.config.get('verification_endpoint', DEFAULT_VERIFICATION_ENDPOINT)
        self.heartbeat_endpoint = self.config.get('heartbeat_endpoint', DEFAULT_HEARTBEAT_ENDPOINT)
        
        # Ensure config directory exists
        os.makedirs(CONFIG_DIR, exist_ok=True)
    
    def _load_config(self):
        """Load configuration from file"""
        if not self.config_file:
            return {}
            
        try:
            import configparser
            config = configparser.ConfigParser()
            config.read(self.config_file)
            
            result = {}
            
            if 'Authentication' in config:
                auth_config = config['Authentication']
                result['verification_enabled'] = auth_config.getboolean('verification_enabled', True)
                result['test_mode'] = auth_config.getboolean('test_mode', False)
            
            if 'PumpFun' in config:
                pump_config = config['PumpFun']
                result['check_interval'] = pump_config.getint('check_interval', 86400)
                result['grace_period'] = pump_config.getint('grace_period', 172800)
                
            if 'API' in config:
                api_config = config['API']
                result['verification_endpoint'] = api_config.get('verification_endpoint', DEFAULT_VERIFICATION_ENDPOINT)
                result['heartbeat_endpoint'] = api_config.get('heartbeat_endpoint', DEFAULT_HEARTBEAT_ENDPOINT)
                result['offline_allowance'] = api_config.getint('offline_allowance', MAX_OFFLINE_TIME)
            
            return result
        except Exception as e:
            logger.error(f"Error loading config: {e}")
            return {}
    
    def _load_activation_data(self):
        """Load activation data from file"""
        if os.path.exists(ACTIVATION_FILE):
            try:
                with open(ACTIVATION_FILE, 'r') as f:
                    return json.load(f)
            except Exception as e:
                logger.error(f"Error loading activation data: {e}")
        
        return {
            "activation_code": None,
            "wallet_address": None,
            "activated_at": None,
            "last_verified": None,
            "node_id": None,
            "signature_key": None
        }
    
    def _save_activation_data(self):
        """Save activation data to file"""
        try:
            # Ensure directory exists
            os.makedirs(os.path.dirname(ACTIVATION_FILE), exist_ok=True)
            
            with open(ACTIVATION_FILE, 'w') as f:
                json.dump(self.activation_data, f, indent=2)
                
            # Set restrictive permissions
            os.chmod(ACTIVATION_FILE, 0o600)
            
            return True
        except Exception as e:
            logger.error(f"Error saving activation data: {e}")
            return False
    
    def _generate_node_id(self):
        """Generate a unique node ID based on hardware and network information"""
        # Check if we already have a node ID
        if self.activation_data.get('node_id'):
            return self.activation_data['node_id']
            
        # Get hardware information
        try:
            # Try to get machine-id
            machine_id = ""
            if os.path.exists("/etc/machine-id"):
                with open("/etc/machine-id", "r") as f:
                    machine_id = f.read().strip()
            
            # Get MAC address
            mac = hex(uuid.getnode())[2:]
            
            # Get hostname
            hostname = socket.gethostname()
            
            # Combine and hash
            combined = f"{machine_id}:{mac}:{hostname}"
            node_id = hashlib.sha256(combined.encode()).hexdigest()
            
            return node_id
        except Exception as e:
            logger.error(f"Error generating node ID: {e}")
            # Fallback to random ID
            return str(uuid.uuid4())
    
    def is_activation_required(self):
        """Check if activation is required"""
        # Check if verification is enabled
        if not self.config.get('verification_enabled', True):
            logger.info("Node verification is disabled in config")
            return False
        
        # If no activation data, activation is required
        if not self.activation_data.get('activation_code'):
            return True
        
        # Check if verification has expired
        last_verified = self.activation_data.get('last_verified')
        if not last_verified:
            return True
            
        # Check if within grace period or can operate offline
        now = time.time()
        grace_period = self.config.get('grace_period', GRACE_PERIOD)
        
        if now - last_verified > grace_period:
            # Check if we can operate offline
            if self.cache_manager.can_operate_offline():
                logger.warning(f"Verification expired but offline operation allowed. Last verified: {datetime.fromtimestamp(last_verified).strftime('%Y-%m-%d %H:%M:%S')}")
                return False
            else:
                logger.warning(f"Verification expired. Last verified: {datetime.fromtimestamp(last_verified).strftime('%Y-%m-%d %H:%M:%S')}")
                return True
        
        return False
    
    @RetryWithBackoff(max_retries=3, initial_delay=1, backoff_factor=2, 
                    exceptions=(requests.RequestException,))
    def _verify_with_api(self, code, node_id, node_address, signature=None):
        """
        Verify activation code with API
        
        Args:
            code: Activation code
            node_id: Node ID
            node_address: Node address
            signature: Signature for verification
            
        Returns:
            dict: Response data or None if failed
        """
        try:
            # Prepare data
            verification_data = {
                "activation_code": code,
                "node_id": node_id,
                "node_address": node_address
            }
            
            if signature:
                verification_data["signature"] = signature
            
            # Make API request
            response = requests.post(
                self.verification_endpoint,
                json=verification_data,
                timeout=10
            )
            
            # Handle response
            if response.status_code == 200:
                return response.json()
            else:
                error = response.json().get("error", "Unknown error")
                logger.error(f"Verification API error: {error}")
                return None
                
        except requests.RequestException as e:
            logger.error(f"Verification API request failed: {e}")
            raise  # Let RetryWithBackoff handle retries
        except Exception as e:
            logger.error(f"Unexpected error during verification: {e}")
            return None
    
    def _generate_signature(self, message):
        """
        Generate signature for API requests
        
        Args:
            message: Message to sign
            
        Returns:
            str: Signature
        """
        signature_key = self.activation_data.get('signature_key')
        if not signature_key:
            return None
            
        try:
            # Create signature using key
            signature = hashlib.sha256(f"{message}:{signature_key}".encode()).hexdigest()
            return signature
        except Exception as e:
            logger.error(f"Error generating signature: {e}")
            return None
    
    def activate_node(self, activation_code=None, transfer_code=None):
        """
        Activate the node using an activation code
        
        Args:
            activation_code: The activation code (prompt if None)
            transfer_code: Transfer code for device migration
            
        Returns:
            bool: True if activation was successful, False otherwise
        """
        # Check for active transfer
        transfer_status = self.transfer_manager.get_transfer_status()
        if transfer_status and transfer_status.get('status') == 'pending':
            logger.info("Using pending transfer data")
            activation_code = transfer_status.get('activation_code')
            transfer_code = transfer_status.get('transfer_code')
            
        # If code not provided, use saved code or prompt
        if not activation_code:
            activation_code = self.activation_data.get('activation_code')
            
        if not activation_code:
            print("\n=== QNet Node Activation ===")
            print("To run a QNet node, you need an activation code.")
            print("Get your code by purchasing QNetAccess tokens and visiting our website.")
            print("If you already have a code, enter it below.\n")
            
            activation_code = input("Enter your activation code: ").strip()
        
        if not activation_code:
            logger.error("No activation code provided")
            return False
        
        # In test mode, allow special test code
        if self.config.get('test_mode', False) and activation_code == "QNET-TEST-TEST-TEST":
            logger.info("Using test activation code")
            self.activation_data = {
                "activation_code": activation_code,
                "wallet_address": "test_wallet1",
                "activated_at": time.time(),
                "last_verified": time.time(),
                "node_id": self.node_id,
                "signature_key": "test_signature_key"
            }
            self.cache_manager.update_verification_cache(True)
            return self._save_activation_data()
        
        # Get node address
        node_address = self._get_node_address()
        
        # Prepare signature for transfer
        signature = transfer_code if transfer_code else None
        
        # Try to verify with API
        try:
            api_result = self._verify_with_api(
                activation_code, self.node_id, node_address, signature
            )
            
            if not api_result:
                logger.error("Activation failed: API verification returned no data")
                print("\nActivation Error: Failed to verify code with server")
                
                # Update cache
                self.cache_manager.update_verification_cache(False)
                
                # If transfer was in progress, mark as failed
                if transfer_status:
                    self.transfer_manager.complete_transfer(False, "API verification failed")
                
                return False
            
            # Check if success
            if not api_result.get('success', False):
                error_message = api_result.get('error', 'Unknown error')
                logger.error(f"Activation failed: {error_message}")
                print(f"\nActivation Error: {error_message}")
                
                # Update cache
                self.cache_manager.update_verification_cache(False)
                
                # If transfer was in progress, mark as failed
                if transfer_status:
                    self.transfer_manager.complete_transfer(False, error_message)
                
                return False
            
            # Check for signature key (returned on first activation)
            signature_key = api_result.get('signature_key', None)
            
            # Activation successful
            self.activation_data = {
                "activation_code": activation_code,
                "wallet_address": api_result.get('wallet_address', 'unknown'),
                "activated_at": time.time(),
                "last_verified": time.time(),
                "node_id": self.node_id,
                "signature_key": signature_key or self.activation_data.get('signature_key')
            }
            
            # Update cache
            self.cache_manager.update_verification_cache(True)
            
            # Save activation data
            success = self._save_activation_data()
            
            if success:
                logger.info("Node activated successfully")
                print("\nNode activated successfully! Starting QNet node...")
                
                # If transfer was in progress, mark as completed
                if transfer_status:
                    self.transfer_manager.complete_transfer(True, "Transfer completed successfully")
                
                # Start heartbeat thread
                self.start_heartbeat_thread()
            
            return success
            
        except Exception as e:
            logger.error(f"Error during activation: {e}")
            print(f"\nActivation Error: {str(e)}")
            
            # Update cache with failure
            self.cache_manager.update_verification_cache(False)
            
            # If transfer was in progress, mark as failed
            if transfer_status:
                self.transfer_manager.complete_transfer(False, str(e))
            
            return False
    
    def verify_activation(self):
        """
        Verify the existing activation
        
        Returns:
            bool: True if verification was successful, False otherwise
        """
        activation_code = self.activation_data.get('activation_code')
        
        if not activation_code:
            logger.error("No activation code found")
            return False
        
        try:
            # Get node address
            node_address = self._get_node_address()
            
            # Generate signature if we have a key
            now = int(time.time())
            message = f"{self.node_id}:{activation_code}:{int(now/1000)}"
            signature = self._generate_signature(message)
            
            # Try API verification
            api_result = self._verify_with_api(
                activation_code, self.node_id, node_address, signature
            )
            
            if not api_result or not api_result.get('success', False):
                # API verification failed, check if we can operate offline
                logger.warning("Verification failed but checking offline operation")
                self.cache_manager.update_verification_cache(False)
                
                if self.cache_manager.can_operate_offline():
                    logger.warning("Continuing in offline mode")
                    return True
                
                return False
            
            # Verification successful
            self.activation_data['last_verified'] = time.time()
            self.cache_manager.update_verification_cache(True)
            return self._save_activation_data()
            
        except Exception as e:
            logger.error(f"Error during verification: {e}")
            
            # Update cache
            self.cache_manager.update_verification_cache(False)
            
            # Check if we can operate offline
            if self.cache_manager.can_operate_offline():
                logger.warning(f"Verification error but operating offline: {e}")
                return True
                
            return False
    
    def _get_node_address(self):
        """Get the node's network address"""
        try:
            # Try to get from environment
            env_ip = os.environ.get("QNET_EXTERNAL_IP")
            port = os.environ.get("QNET_PORT", "8000")
            
            if env_ip and env_ip.lower() != "auto":
                return f"{env_ip}:{port}"
            
            # Try to get public IP
            response = requests.get("https://api.ipify.org", timeout=5)
            ip = response.text.strip()
            
            return f"{ip}:{port}"
        except Exception as e:
            logger.error(f"Error getting node address: {e}")
            # Fallback to localhost
            return f"127.0.0.1:{port}"
    
    def start_heartbeat_thread(self):
        """Start background thread for periodic heartbeats"""
        if self.heartbeat_thread and self.heartbeat_thread.is_alive():
            logger.info("Heartbeat thread already running")
            return
            
        self.running = True
        self.heartbeat_thread = threading.Thread(target=self._heartbeat_loop, daemon=True)
        self.heartbeat_thread.start()
        logger.info("Heartbeat thread started")
    
    def stop_heartbeat_thread(self):
        """Stop the heartbeat thread"""
        self.running = False
        if self.heartbeat_thread:
            self.heartbeat_thread.join(timeout=2)
            logger.info("Heartbeat thread stopped")
    
    def _heartbeat_loop(self):
        """Background thread for sending periodic heartbeats"""
        while self.running:
            try:
                # Send heartbeat
                self.send_heartbeat()
                
                # Sleep until next heartbeat
                time.sleep(HEARTBEAT_INTERVAL)
            except Exception as e:
                logger.error(f"Error in heartbeat loop: {e}")
                time.sleep(60)  # Sleep for a minute before retrying
    
    @RetryWithBackoff(max_retries=3, initial_delay=1, backoff_factor=2, 
                     exceptions=(requests.RequestException,))
    def send_heartbeat(self):
        """Send heartbeat to server"""
        activation_code = self.activation_data.get('activation_code')
        node_id = self.activation_data.get('node_id')
        
        if not activation_code or not node_id:
            logger.error("Cannot send heartbeat: missing activation code or node ID")
            return False
        
        try:
            # Generate signature
            now = int(time.time())
            message = f"{node_id}:{activation_code}:{int(now/1000)}"
            signature = self._generate_signature(message)
            
            # Send heartbeat
            response = requests.post(
                self.heartbeat_endpoint,
                json={
                    "node_id": node_id,
                    "activation_code": activation_code,
                    "signature": signature
                },
                timeout=10
            )
            
            if response.status_code == 200:
                data = response.json()
                if data.get('success', False):
                    logger.info("Heartbeat sent successfully")
                    return True
                else:
                    error = data.get('error', 'Unknown error')
                    logger.error(f"Heartbeat error: {error}")
            else:
                logger.error(f"Heartbeat failed with status code {response.status_code}")
            
            return False
        except requests.RequestException as e:
            logger.error(f"Heartbeat request failed: {e}")
            raise  # Let RetryWithBackoff handle retries
        except Exception as e:
            logger.error(f"Unexpected error sending heartbeat: {e}")
            return False
    
    def initiate_transfer(self):
        """
        Initiate node transfer to allow using on another device
        
        Returns:
            (bool, str): (success, transfer_code or error message)
        """
        activation_code = self.activation_data.get('activation_code')
        wallet_address = self.activation_data.get('wallet_address')
        
        if not activation_code or not wallet_address:
            return False, "Missing activation code or wallet address"
        
        try:
            # Call API to initiate transfer
            response = requests.post(
                self.verification_endpoint.replace('/verify_code', '/initiate_transfer'),
                json={
                    "activation_code": activation_code,
                    "wallet_address": wallet_address
                },
                timeout=10
            )
            
            if response.status_code != 200:
                error = response.json().get('error', 'Unknown error')
                return False, f"API error: {error}"
            
            data = response.json()
            if not data.get('success', False):
                error = data.get('error', 'Unknown error')
                return False, f"Transfer failed: {error}"
            
            # Get transfer code
            transfer_code = data.get('transfer_code')
            if not transfer_code:
                return False, "No transfer code received"
            
            # Save transfer data
            self.transfer_manager.initiate_transfer(
                activation_code, transfer_code, wallet_address
            )
            
            return True, transfer_code
        except Exception as e:
            logger.error(f"Error initiating transfer: {e}")
            return False, str(e)
    
    def cancel_transfer(self):
        """
        Cancel in-progress transfer
        
        Returns:
            bool: Success status
        """
        # Check if transfer is in progress
        transfer_status = self.transfer_manager.get_transfer_status()
        if not transfer_status or transfer_status.get('status') != 'pending':
            return False
        
        try:
            # Call API to cancel transfer
            activation_code = transfer_status.get('activation_code')
            wallet_address = transfer_status.get('wallet_address')
            
            response = requests.post(
                self.verification_endpoint.replace('/verify_code', '/cancel_transfer'),
                json={
                    "activation_code": activation_code,
                    "wallet_address": wallet_address
                },
                timeout=10
            )
            
            # Update local status regardless of API response
            self.transfer_manager.cancel_transfer()
            
            if response.status_code != 200:
                logger.warning(f"Transfer cancelled locally but API returned error: {response.status_code}")
                return True  # Still consider cancelled locally
            
            return True
        except Exception as e:
            logger.error(f"Error cancelling transfer: {e}")
            # Still mark cancelled locally
            self.transfer_manager.cancel_transfer()
            return True

def verify_node_startup(config_file=None):
    """
    Verify that the node has permission to start
    
    Args:
        config_file: Path to the configuration file
        
    Returns:
        bool: True if the node can start, False otherwise
    """
    # Initialize activation handler
    activation = NodeActivation(config_file)
    
    # Check if activation is required
    if activation.is_activation_required():
        logger.info("Node activation required")
        
        # Try to verify existing activation first
        if activation.activation_data.get('activation_code'):
            if activation.verify_activation():
                logger.info("Existing activation verified successfully")
                # Start heartbeat thread
                activation.start_heartbeat_thread()
                return True
            else:
                logger.warning("Existing activation verification failed, prompting for new code")
        
        # Prompt for activation code
        if not activation.activate_node():
            logger.error("Node activation failed")
            return False
    else:
        # Start heartbeat thread for existing activation
        activation.start_heartbeat_thread()
    
    return True

# If run directly, perform verification
if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="QNet Node Activation")
    parser.add_argument('--config', help='Path to the configuration file')
    parser.add_argument('--activate', action='store_true', help='Activate the node')
    parser.add_argument('--code', help='Activation code')
    parser.add_argument('--transfer', action='store_true', help='Initiate node transfer')
    parser.add_argument('--import-transfer', help='Import transfer data from file')
    args = parser.parse_args()
    
    activation = NodeActivation(args.config)
    
    if args.activate:
        success = activation.activate_node(args.code)
        sys.exit(0 if success else 1)
    elif args.transfer:
        success, result = activation.initiate_transfer()
        if success:
            print(f"Transfer initiated successfully. Transfer code: {result}")
            print("Use this code on your new device to complete the transfer.")
            sys.exit(0)
        else:
            print(f"Transfer failed: {result}")
            sys.exit(1)
    elif args.import_transfer:
        transfer_data = activation.transfer_manager.import_transfer(args.import_transfer)
        if transfer_data:
            print("Transfer data imported successfully.")
            print(f"Activation code: {transfer_data['activation_code']}")
            print(f"Transfer code: {transfer_data['transfer_code']}")
            print("Run with --activate to complete the transfer.")
            sys.exit(0)
        else:
            print("Failed to import transfer data.")
            sys.exit(1)
    else:
        success = verify_node_startup(args.config)
        sys.exit(0 if success else 1)