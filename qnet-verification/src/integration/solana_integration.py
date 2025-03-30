#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: solana_integration.py
Implements direct integration with Solana blockchain for QNet token verification.
"""

import os
import time
import json
import logging
import threading
import requests
import hashlib
import base64
import sqlite3
from typing import Dict, List, Optional, Tuple, Union
import base58

# Configure logging
logging.basicConfig(level=logging.INFO,
                   format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

class SolanaIntegration:
    """
    Provides direct integration with Solana blockchain for QNet token verification.
    """
    
    def __init__(self, config_file='config.ini', test_mode=True):
        """
        Initialize the Solana integration.
        
        Args:
            config_file: Path to configuration file
            test_mode: Whether to use test mode (mock) or production mode
        """
        import configparser
        
        self.config = configparser.ConfigParser()
        self.config.read(config_file)
        
        # Extract configuration
        self.test_mode = test_mode or self.config.getboolean('Solana', 'test_mode', fallback=True)
        self.rpc_url = self.config.get('Solana', 'rpc_url', fallback='https://api.mainnet-beta.solana.com')
        self.token_mint = self.config.get('Solana', 'token_mint', fallback='')
        self.min_balance = self.config.getint('Solana', 'min_balance', fallback=10000)
        self.check_interval = self.config.getint('Solana', 'check_interval', fallback=86400)  # 24 hours
        self.grace_period = self.config.getint('Solana', 'grace_period', fallback=172800)  # 48 hours
        
        # Database path
        self.db_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "node_registry.db")
        
        # Initialize database
        self._init_db()
        
        # Start background services
        self.running = True
        if not self.test_mode:
            self._start_background_tasks()
            
        logger.info(f"Solana integration initialized (test_mode={self.test_mode})")
    
    def _init_db(self):
        """Initialize SQLite database for node tracking"""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            # Table for tracking node registrations
            cursor.execute('''
            CREATE TABLE IF NOT EXISTS node_registry (
                node_id TEXT PRIMARY KEY,
                wallet_address TEXT UNIQUE,
                token_balance INTEGER,
                registration_time REAL,
                last_check_time REAL,
                grace_period_start REAL,
                status TEXT
            )
            ''')
            
            # Table for verification logs
            cursor.execute('''
            CREATE TABLE IF NOT EXISTS verification_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                node_id TEXT,
                wallet_address TEXT,
                check_time REAL,
                balance INTEGER,
                status TEXT,
                message TEXT
            )
            ''')
            
            conn.commit()
            conn.close()
            
        except Exception as e:
            logger.error(f"Error initializing database: {e}")
            raise
    
    def _start_background_tasks(self):
        """Start background tasks for checking balances"""
        self.balance_check_thread = threading.Thread(target=self._balance_check_loop, daemon=True)
        self.balance_check_thread.start()
    
    def _balance_check_loop(self):
        """Background task that periodically checks token balances"""
        while self.running:
            try:
                self._check_all_nodes()
            except Exception as e:
                logger.error(f"Error in balance check loop: {e}")
            
            # Sleep for a random time within 10% of the check interval
            import random
            jitter = self.check_interval * 0.1
            sleep_time = self.check_interval + (jitter * (2 * (0.5 - random.random())))
            time.sleep(max(1, sleep_time))
    
    def _check_all_nodes(self):
        """Check balances for all registered nodes"""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            # Get all active nodes
            cursor.execute("SELECT node_id, wallet_address FROM node_registry WHERE status='active'")
            nodes = cursor.fetchall()
            
            for node_id, wallet_address in nodes:
                # Check balance for each node
                balance, is_valid = self.check_token_balance(wallet_address)
                now = time.time()
                
                if is_valid:
                    # Node has sufficient balance, update status
                    cursor.execute('''
                    UPDATE node_registry
                    SET token_balance=?, last_check_time=?, grace_period_start=NULL, status='active'
                    WHERE node_id=?
                    ''', (balance, now, node_id))
                    
                    # Log the check
                    cursor.execute('''
                    INSERT INTO verification_logs (node_id, wallet_address, check_time, balance, status, message)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ''', (node_id, wallet_address, now, balance, 'valid', f"Sufficient balance: {balance}"))
                    
                else:
                    # Insufficient balance, check if in grace period
                    cursor.execute("SELECT grace_period_start FROM node_registry WHERE node_id=?", (node_id,))
                    result = cursor.fetchone()
                    grace_period_start = result[0] if result and result[0] else None
                    
                    if grace_period_start is None:
                        # Start grace period
                        cursor.execute('''
                        UPDATE node_registry
                        SET token_balance=?, last_check_time=?, grace_period_start=?, status='grace'
                        WHERE node_id=?
                        ''', (balance, now, now, node_id))
                        
                        # Log the check
                        cursor.execute('''
                        INSERT INTO verification_logs (node_id, wallet_address, check_time, balance, status, message)
                        VALUES (?, ?, ?, ?, ?, ?)
                        ''', (node_id, wallet_address, now, balance, 'grace', 
                             f"Insufficient balance: {balance}. Grace period started."))
                        
                    elif now - grace_period_start > self.grace_period:
                        # Grace period expired, exclude node
                        cursor.execute('''
                        UPDATE node_registry
                        SET token_balance=?, last_check_time=?, status='excluded'
                        WHERE node_id=?
                        ''', (balance, now, node_id))
                        
                        # Log the check
                        cursor.execute('''
                        INSERT INTO verification_logs (node_id, wallet_address, check_time, balance, status, message)
                        VALUES (?, ?, ?, ?, ?, ?)
                        ''', (node_id, wallet_address, now, balance, 'excluded', 
                             f"Insufficient balance: {balance}. Grace period expired. Node excluded."))
                    else:
                        # Still in grace period
                        cursor.execute('''
                        UPDATE node_registry
                        SET token_balance=?, last_check_time=?, status='grace'
                        WHERE node_id=?
                        ''', (balance, now, node_id))
                        
                        # Log the check
                        remaining = self.grace_period - (now - grace_period_start)
                        cursor.execute('''
                        INSERT INTO verification_logs (node_id, wallet_address, check_time, balance, status, message)
                        VALUES (?, ?, ?, ?, ?, ?)
                        ''', (node_id, wallet_address, now, balance, 'grace', 
                             f"Insufficient balance: {balance}. Grace period remaining: {remaining/3600:.1f} hours"))
            
            conn.commit()
            conn.close()
            
        except Exception as e:
            logger.error(f"Error checking all nodes: {e}")
            raise
    
    def check_token_balance(self, wallet_address: str) -> Tuple[int, bool]:
        """
        Check token balance for a wallet address.
        
        Args:
            wallet_address: Solana wallet address
            
        Returns:
            Tuple of (balance, is_valid): Balance in tokens, whether it meets minimum requirement
        """
        if self.test_mode:
            # In test mode, use mock data
            return self._check_mock_balance(wallet_address)
        else:
            # In production mode, query Solana blockchain directly
            return self._check_real_balance(wallet_address)
    
    def _check_mock_balance(self, wallet_address: str) -> Tuple[int, bool]:
        """Get token balance from mock data for testing"""
        try:
            # Read mock data from file
            mock_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mock_balances.json")
            
            if not os.path.exists(mock_file):
                # Create default mock data
                default_data = {
                    "valid_wallet1": 15000,
                    "valid_wallet2": 20000,
                    "grace_wallet": 9000,
                    "excluded_wallet": 5000
                }
                
                with open(mock_file, 'w') as f:
                    json.dump(default_data, f, indent=2)
            
            # Read from file
            with open(mock_file, 'r') as f:
                mock_data = json.load(f)
            
            # Get balance
            balance = mock_data.get(wallet_address, 0)
            
            # Check if valid
            is_valid = balance >= self.min_balance
            
            return balance, is_valid
            
        except Exception as e:
            logger.error(f"Error checking mock balance: {e}")
            return 0, False
    
    def _check_real_balance(self, wallet_address: str) -> Tuple[int, bool]:
        """Get token balance directly from Solana blockchain"""
        try:
            # Prepare the RPC request
            payload = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "getTokenAccountsByOwner",
                "params": [
                    wallet_address,
                    {
                        "mint": self.token_mint
                    },
                    {
                        "encoding": "jsonParsed"
                    }
                ]
            }
            
            # Send request to Solana RPC
            response = requests.post(self.rpc_url, json=payload, timeout=10)
            
            if response.status_code == 200:
                data = response.json()
                
                # Check for errors
                if "error" in data:
                    logger.error(f"Solana RPC error: {data['error']}")
                    return 0, False
                
                # Get token accounts
                accounts = data.get("result", {}).get("value", [])
                
                # Sum balances from all token accounts for this mint
                total_balance = 0
                for account in accounts:
                    account_info = account.get("account", {}).get("data", {}).get("parsed", {}).get("info", {})
                    token_amount = account_info.get("tokenAmount", {})
                    
                    # Get amount and handle decimals
                    amount = int(token_amount.get("amount", "0"))
                    decimals = int(token_amount.get("decimals", 0))
                    
                    # Convert to actual token amount
                    actual_amount = amount / (10 ** decimals)
                    total_balance += actual_amount
                
                # Check if valid
                is_valid = total_balance >= self.min_balance
                
                return int(total_balance), is_valid
            else:
                logger.error(f"Error from Solana RPC: {response.status_code} - {response.text}")
                return 0, False
                
        except Exception as e:
            logger.error(f"Error checking real balance: {e}")
            return 0, False
    
    def verify_wallet_signature(self, wallet_address: str, message: str, signature: str) -> bool:
        """
        Verify that a signature was created by the wallet address.
        
        Args:
            wallet_address: Solana wallet address
            message: Message that was signed
            signature: The signature to verify
            
        Returns:
            bool: Whether the signature is valid
        """
        if self.test_mode:
            # In test mode, accept specific test signatures
            return self._verify_mock_signature(wallet_address, message, signature)
        else:
            # In production mode, verify using Solana
            return self._verify_real_signature(wallet_address, message, signature)
    
    def _verify_mock_signature(self, wallet_address: str, message: str, signature: str) -> bool:
        """Verify signature using mock data for testing"""
        # For testing, accept signatures that are hash of wallet+message
        expected_signature = hashlib.sha256(f"{wallet_address}:{message}".encode()).hexdigest()
        return signature == expected_signature
    
    def _verify_real_signature(self, wallet_address: str, message: str, signature: str) -> bool:
        """Verify signature using Solana signature verification"""
        try:
            # Convert signature from base58 or hex to bytes
            try:
                if len(signature) == 64 or len(signature) == 128:  # Likely hex format
                    sig_bytes = bytes.fromhex(signature)
                else:  # Assume base58
                    sig_bytes = base58.b58decode(signature)
            except Exception:
                logger.error(f"Invalid signature format: {signature}")
                return False
            
            # Convert the message to the format Solana would sign
            message_bytes = message.encode('utf-8')
            
            # The following is a simplified version of Solana verification
            # In practice, you would use a proper Solana library like solana-py
            
            import nacl.signing
            
            # Convert the wallet address to public key bytes
            try:
                pubkey_bytes = base58.b58decode(wallet_address)
            except Exception:
                logger.error(f"Invalid wallet address format: {wallet_address}")
                return False
            
            # Verify the signature
            try:
                verify_key = nacl.signing.VerifyKey(pubkey_bytes)
                verify_key.verify(message_bytes, sig_bytes)
                return True
            except Exception as e:
                logger.error(f"Signature verification failed: {e}")
                return False
                
        except Exception as e:
            logger.error(f"Error verifying real signature: {e}")
            return False
    
    def register_node(self, node_id: str, wallet_address: str) -> Tuple[bool, str]:
        """
        Register a new node with wallet address.
        
        Args:
            node_id: Unique ID of the node
            wallet_address: Solana wallet address
            
        Returns:
            Tuple of (success, message): Whether registration was successful, message
        """
        try:
            # Check if wallet is already registered
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute("SELECT node_id FROM node_registry WHERE wallet_address=?", (wallet_address,))
            existing_wallet = cursor.fetchone()
            
            if existing_wallet:
                conn.close()
                return False, f"Wallet {wallet_address} is already registered to node {existing_wallet[0]}"
            
            cursor.execute("SELECT wallet_address FROM node_registry WHERE node_id=?", (node_id,))
            existing_node = cursor.fetchone()
            
            if existing_node:
                conn.close()
                return False, f"Node {node_id} is already registered with wallet {existing_node[0]}"
            
            # Check token balance
            balance, is_valid = self.check_token_balance(wallet_address)
            
            if not is_valid:
                conn.close()
                return False, f"Insufficient token balance: {balance}. Minimum required: {self.min_balance}"
            
            # Register node
            now = time.time()
            cursor.execute('''
            INSERT INTO node_registry 
            (node_id, wallet_address, token_balance, registration_time, last_check_time, status)
            VALUES (?, ?, ?, ?, ?, ?)
            ''', (node_id, wallet_address, balance, now, now, 'active'))
            
            # Log registration
            cursor.execute('''
            INSERT INTO verification_logs 
            (node_id, wallet_address, check_time, balance, status, message)
            VALUES (?, ?, ?, ?, ?, ?)
            ''', (node_id, wallet_address, now, balance, 'registered', 
                 f"Node registered with balance: {balance}"))
                 
            conn.commit()
            conn.close()
            
            return True, f"Node {node_id} registered successfully with wallet {wallet_address}"
            
        except Exception as e:
            logger.error(f"Error registering node: {e}")
            return False, f"Error registering node: {str(e)}"
    
    def unregister_node(self, node_id: str, wallet_address: str, signature: str) -> Tuple[bool, str]:
        """
        Unregister a node (requires signature from wallet owner).
        
        Args:
            node_id: Unique ID of the node
            wallet_address: Solana wallet address
            signature: Signature of the message "unregister:{node_id}:{timestamp}"
            
        Returns:
            Tuple of (success, message): Whether unregistration was successful, message
        """
        try:
            # Check if node exists and is owned by wallet
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute("SELECT wallet_address FROM node_registry WHERE node_id=?", (node_id,))
            result = cursor.fetchone()
            
            if not result:
                conn.close()
                return False, f"Node {node_id} not found"
                
            stored_wallet = result[0]
            
            if stored_wallet != wallet_address:
                conn.close()
                return False, f"Node {node_id} is not registered to wallet {wallet_address}"
            
            # Verify signature
            timestamp = int(time.time())
            message = f"unregister:{node_id}:{timestamp}"
            
            if not self.verify_wallet_signature(wallet_address, message, signature):
                conn.close()
                return False, "Invalid signature"
            
            # Unregister node
            cursor.execute("DELETE FROM node_registry WHERE node_id=?", (node_id,))
            
            # Log unregistration
            cursor.execute('''
            INSERT INTO verification_logs 
            (node_id, wallet_address, check_time, balance, status, message)
            VALUES (?, ?, ?, ?, ?, ?)
            ''', (node_id, wallet_address, time.time(), 0, 'unregistered', 
                 f"Node unregistered by wallet owner"))
                 
            conn.commit()
            conn.close()
            
            return True, f"Node {node_id} unregistered successfully"
            
        except Exception as e:
            logger.error(f"Error unregistering node: {e}")
            return False, f"Error unregistering node: {str(e)}"
    
    def get_node_status(self, node_id: str) -> Dict:
        """
        Get status information for a node.
        
        Args:
            node_id: Unique ID of the node
            
        Returns:
            Dict with node status information
        """
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
            SELECT node_id, wallet_address, token_balance, registration_time, 
                   last_check_time, grace_period_start, status
            FROM node_registry WHERE node_id=?
            ''', (node_id,))
            
            result = cursor.fetchone()
            
            if not result:
                conn.close()
                return {"error": f"Node {node_id} not found"}
                
            node_data = {
                "node_id": result[0],
                "wallet_address": result[1],
                "token_balance": result[2],
                "registration_time": result[3],
                "last_check_time": result[4],
                "grace_period_start": result[5],
                "status": result[6]
            }
            
            # Add additional info for grace period
            if node_data["status"] == "grace" and node_data["grace_period_start"]:
                elapsed = time.time() - node_data["grace_period_start"]
                remaining = max(0, self.grace_period - elapsed)
                node_data["grace_period_remaining"] = remaining
                node_data["grace_period_hours_remaining"] = remaining / 3600
            
            conn.close()
            return node_data
            
        except Exception as e:
            logger.error(f"Error getting node status: {e}")
            return {"error": f"Error getting node status: {str(e)}"}
    
    def get_verification_logs(self, node_id: str, limit: int = 10) -> List[Dict]:
        """
        Get verification logs for a node.
        
        Args:
            node_id: Unique ID of the node
            limit: Maximum number of logs to return
            
        Returns:
            List of log entries
        """
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
            SELECT node_id, wallet_address, check_time, balance, status, message
            FROM verification_logs 
            WHERE node_id=?
            ORDER BY check_time DESC
            LIMIT ?
            ''', (node_id, limit))
            
            results = cursor.fetchall()
            
            logs = []
            for row in results:
                logs.append({
                    "node_id": row[0],
                    "wallet_address": row[1],
                    "check_time": row[2],
                    "check_time_formatted": time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(row[2])),
                    "balance": row[3],
                    "status": row[4],
                    "message": row[5]
                })
            
            conn.close()
            return logs
            
        except Exception as e:
            logger.error(f"Error getting verification logs: {e}")
            return []
    
    def stop(self):
        """Stop background tasks"""
        self.running = False
        if hasattr(self, 'balance_check_thread') and self.balance_check_thread.is_alive():
            self.balance_check_thread.join(timeout=2)
            
# Example configuration for Solana integration
def create_solana_config():
    """Creates a sample Solana configuration section"""
    import configparser
    
    # Load existing config if available
    config = configparser.ConfigParser()
    config_file = 'config.ini'
    
    if os.path.exists(config_file):
        config.read(config_file)
    
    # Add Solana section if not exists
    if 'Solana' not in config:
        config['Solana'] = {}
        
    # Set default values
    config['Solana']['rpc_url'] = 'https://api.mainnet-beta.solana.com'
    config['Solana']['token_mint'] = '7JR6pEX9v97AfsS9V4JSwYNtJbv8skPGo3zHFN7oLn2D'  # Example token mint address
    config['Solana']['min_balance'] = '10000'
    config['Solana']['check_interval'] = '86400'  # 24 hours
    config['Solana']['grace_period'] = '172800'   # 48 hours
    config['Solana']['test_mode'] = 'true'
    
    # Write the updated config
    with open(config_file, 'w') as f:
        config.write(f)
        
    print(f"Created Solana configuration in {config_file}")

# Test function
def test_solana_integration():
    """Test the Solana integration"""
    # Make sure config exists
    create_solana_config()
    
    # Create integration in test mode
    integration = SolanaIntegration(test_mode=True)
    
    # Test balance check
    wallet = "5jQMvx5JdSxYsQNnU6R7Xr6zMtXHYnWFZLN3iFs3j2Wm"  # Example wallet
    balance, is_valid = integration.check_token_balance(wallet)
    print(f"Wallet {wallet} balance: {balance}, valid: {is_valid}")
    
    # Test node registration
    node_id = f"node_{int(time.time())}"
    success, message = integration.register_node(node_id, wallet)
    print(f"Registration result: {success}, {message}")
    
    # Test status check
    status = integration.get_node_status(node_id)
    print(f"Node status: {status}")
    
    # Test logs
    logs = integration.get_verification_logs(node_id)
    print(f"Verification logs: {logs}")
    
    # Test unregistration
    test_signature = hashlib.sha256(f"{wallet}:unregister:{node_id}:{int(time.time())}".encode()).hexdigest()
    success, message = integration.unregister_node(node_id, wallet, test_signature)
    print(f"Unregistration result: {success}, {message}")

if __name__ == "__main__":
    # Run test
    test_solana_integration()