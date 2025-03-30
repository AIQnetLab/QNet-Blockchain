#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: token_verification_api.py
Enhanced API for token verification including activation codes with improved security.
"""

import os
import json
import time
import hashlib
import logging
import secrets
import re
import sqlite3
import shutil
import threading
import base64
import uuid
from datetime import datetime, timedelta
from functools import wraps
from flask import request, jsonify, Blueprint, g

# Try to import cryptography for encryption
try:
    from cryptography.fernet import Fernet
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    ENCRYPTION_AVAILABLE = True
except ImportError:
    ENCRYPTION_AVAILABLE = False
    logging.warning("Cryptography package not installed. Database encryption unavailable.")

# Try to import Solana libraries
try:
    from solana.rpc.api import Client
    SOLANA_AVAILABLE = True
except ImportError:
    SOLANA_AVAILABLE = False
    logging.warning("Solana libraries not installed. Using mock implementation.")

# Initialize logger
logging.basicConfig(level=logging.INFO,
                    format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

# Create a Blueprint for token verification endpoints
token_verification_bp = Blueprint('token_verification', __name__, url_prefix='/api/v1/token')

# Database paths
DB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
DB_PATH = os.path.join(DB_DIR, "activation_codes.db")
BACKUP_DIR = os.path.join(DB_DIR, "backups")

# Ensure directories exist
os.makedirs(DB_DIR, exist_ok=True)
os.makedirs(BACKUP_DIR, exist_ok=True)

# Configuration constants
DEFAULT_CONFIG = {
    'token_contract': 'test_contract',
    'min_balance': 10000,
    'check_interval': 86400,  # 24 hours
    'grace_period': 172800,   # 48 hours
    'activation_code_expiry': 604800,  # 7 days
    'test_mode': True,
    'verification_enabled': True,
    'wallet_address': 'test_wallet1',
    'heartbeat_timeout': 86400,  # 24 hours
    'transfer_cooldown': 3600,   # 1 hour
    'database_key': None,        # Set in init_integration()
    'backup_interval': 86400,    # 24 hours
    'max_offline_time': 259200,  # 3 days - max time node can operate offline
    'solana_network': 'testnet', # Solana network to use
    'receiver_address': None,    # Address to receive token payments
}

# Global variables
_config = DEFAULT_CONFIG.copy()
_activation_manager = None
_db_encryption = None

class DatabaseEncryption:
    """Handles database encryption and decryption"""
    
    def __init__(self, key=None):
        """Initialize with encryption key"""
        self.key = key
        self.enabled = ENCRYPTION_AVAILABLE and key is not None
        
    def generate_key(self, password, salt=None):
        """Generate encryption key from password"""
        if not ENCRYPTION_AVAILABLE:
            return None
            
        if salt is None:
            salt = os.urandom(16)
            
        kdf = PBKDF2HMAC(
            algorithm=hashes.SHA256(),
            length=32,
            salt=salt,
            iterations=100000
        )
        
        key = base64.urlsafe_b64encode(kdf.derive(password.encode()))
        self.key = key
        self.enabled = True
        return key, salt
    
    def encrypt_db(self, db_path):
        """Encrypt database file"""
        if not self.enabled:
            logger.warning("Encryption not available or key not set")
            return False
            
        try:
            # Read original database
            with open(db_path, 'rb') as f:
                db_data = f.read()
                
            # Encrypt
            f = Fernet(self.key)
            encrypted_data = f.encrypt(db_data)
            
            # Write encrypted file
            encrypted_path = db_path + '.enc'
            with open(encrypted_path, 'wb') as f:
                f.write(encrypted_data)
                
            # Backup original and replace with encrypted
            shutil.move(db_path, db_path + '.bak')
            shutil.move(encrypted_path, db_path)
            
            return True
        except Exception as e:
            logger.error(f"Error encrypting database: {e}")
            return False
    
    def decrypt_db(self, db_path, output_path=None):
        """Decrypt database file"""
        if not self.enabled:
            logger.warning("Encryption not available or key not set")
            return False
            
        if output_path is None:
            output_path = db_path + '.dec'
            
        try:
            # Read encrypted database
            with open(db_path, 'rb') as f:
                encrypted_data = f.read()
                
            # Decrypt
            f = Fernet(self.key)
            decrypted_data = f.decrypt(encrypted_data)
            
            # Write decrypted file
            with open(output_path, 'wb') as f:
                f.write(decrypted_data)
                
            return True
        except Exception as e:
            logger.error(f"Error decrypting database: {e}")
            return False

class OptimizedDBManager:
    """Optimized database manager with connection pooling and query caching"""
    
    def __init__(self, db_path, max_connections=5, cache_ttl=60):
        self.db_path = db_path
        self.max_connections = max_connections
        self.cache_ttl = cache_ttl
        self.connection_pool = []
        self.connection_lock = threading.RLock()
        self.query_cache = {}
        self.cache_lock = threading.RLock()
        
    def get_connection(self):
        """Get connection from pool or create new one"""
        with self.connection_lock:
            if self.connection_pool:
                return self.connection_pool.pop()
            else:
                conn = sqlite3.connect(self.db_path)
                # Enable foreign keys
                conn.execute("PRAGMA foreign_keys = ON")
                # Enable write-ahead logging for better concurrency
                conn.execute("PRAGMA journal_mode = WAL")
                return conn
    
    def release_connection(self, conn):
        """Return connection to pool"""
        with self.connection_lock:
            if len(self.connection_pool) < self.max_connections:
                self.connection_pool.append(conn)
            else:
                conn.close()
    
    def execute_query(self, query, params=(), fetchone=False, fetchall=False, 
                     modify=False, use_cache=False):
        """Execute SQL query with caching for read operations"""
        start_time = time.time()
        
        try:
            if use_cache and not modify:
                # Try to get from cache for read-only operations
                cache_key = (query, str(params))
                with self.cache_lock:
                    cached = self.query_cache.get(cache_key)
                    if cached and time.time() - cached[0] < self.cache_ttl:
                        return cached[1]
            
            conn = self.get_connection()
            try:
                cursor = conn.cursor()
                cursor.execute(query, params)
                
                if modify:
                    conn.commit()
                    return cursor.rowcount
                elif fetchone:
                    result = cursor.fetchone()
                elif fetchall:
                    result = cursor.fetchall()
                else:
                    result = None
                    
                # Cache result for read operations if requested
                if use_cache and not modify:
                    with self.cache_lock:
                        self.query_cache[cache_key] = (time.time(), result)
                
                return result
            finally:
                self.release_connection(conn)
        finally:
            # Record metrics for monitoring
            duration = time.time() - start_time
            query_type = "write" if modify else "read"
            try:
                from monitoring import prometheus_monitoring
                prometheus_monitoring.record_db_query(query_type, duration)
            except (ImportError, AttributeError):
                pass
    
    def execute_script(self, script):
        """Execute SQL script with multiple statements"""
        conn = self.get_connection()
        try:
            conn.executescript(script)
            conn.commit()
        finally:
            self.release_connection(conn)
    
    def clear_cache(self):
        """Clear query cache"""
        with self.cache_lock:
            self.query_cache.clear()

class ActivationCodeManager:
    """Manages activation codes for node access with enhanced security"""
    
    def __init__(self, db_path=DB_PATH, encryption_key=None):
        """Initialize the activation code manager"""
        self.db_path = db_path
        self.encryption = DatabaseEncryption(encryption_key)
        self.last_backup = 0
        self.db_manager = OptimizedDBManager(db_path)
        self._init_db()
        
        # Start backup thread
        self.backup_thread = threading.Thread(target=self._backup_loop, daemon=True)
        self.backup_thread.start()
    
    def _init_db(self):
        """Initialize the database with required tables"""
        try:
            init_script = '''
            CREATE TABLE IF NOT EXISTS activation_codes (
                code TEXT PRIMARY KEY,
                wallet_address TEXT NOT NULL,
                transaction_id TEXT,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                used_at INTEGER,
                node_id TEXT,
                node_address TEXT,
                is_active BOOLEAN DEFAULT 1,
                is_transferable BOOLEAN DEFAULT 1,
                transfer_code TEXT,
                transfer_expires_at INTEGER
            );
            
            CREATE TABLE IF NOT EXISTS nodes (
                node_id TEXT PRIMARY KEY,
                node_address TEXT UNIQUE,
                activation_code TEXT,
                wallet_address TEXT,
                last_verified INTEGER,
                last_heartbeat INTEGER,
                first_seen INTEGER,
                is_active BOOLEAN DEFAULT 1,
                signature_key TEXT,
                offline_allowance INTEGER DEFAULT 259200,
                FOREIGN KEY (activation_code) REFERENCES activation_codes (code)
            );
            
            CREATE TABLE IF NOT EXISTS node_transfers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                activation_code TEXT NOT NULL,
                old_node_id TEXT,
                new_node_id TEXT,
                transfer_time INTEGER,
                wallet_address TEXT,
                transfer_code TEXT,
                is_completed BOOLEAN DEFAULT 0,
                FOREIGN KEY (activation_code) REFERENCES activation_codes (code)
            );
            
            CREATE TABLE IF NOT EXISTS db_info (
                key TEXT PRIMARY KEY,
                value TEXT
            );
            
            INSERT OR REPLACE INTO db_info (key, value) VALUES ('version', '1.1');
            
            INSERT OR REPLACE INTO db_info (key, value) VALUES ('encrypted', '0');
            '''
            
            self.db_manager.execute_script(init_script)
            
            # Check if database should be encrypted
            if self.encryption.enabled and self.encryption.key:
                # Check if database is already encrypted
                encrypted = self.db_manager.execute_query(
                    "SELECT value FROM db_info WHERE key = 'encrypted'",
                    fetchone=True,
                    use_cache=False
                )
                
                if encrypted and encrypted[0] == '0':
                    # Encrypt database
                    if self.encryption.encrypt_db(self.db_path):
                        # Update encryption status
                        self.db_manager.execute_query(
                            "UPDATE db_info SET value = '1' WHERE key = 'encrypted'",
                            modify=True
                        )
                        logger.info("Database encrypted successfully")
                    else:
                        logger.error("Failed to encrypt database")
            
        except Exception as e:
            logger.error(f"Error initializing database: {e}")
            
    def _backup_loop(self):
        """Background thread for automatic database backups"""
        while True:
            try:
                time.sleep(3600)  # Check every hour
                
                now = time.time()
                backup_interval = DEFAULT_CONFIG['backup_interval']
                
                # Time for backup?
                if now - self.last_backup > backup_interval:
                    self.backup_database()
                    self.last_backup = now
            except Exception as e:
                logger.error(f"Error in backup loop: {e}")
    
    def backup_database(self):
        """Create a backup of the database"""
        try:
            # Create timestamp for backup filename
            timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
            backup_path = os.path.join(BACKUP_DIR, f"activation_codes_{timestamp}.db")
            
            # Copy the database file
            shutil.copy2(self.db_path, backup_path)
            
            # Remove old backups (keep last 7)
            backups = sorted([os.path.join(BACKUP_DIR, f) for f in os.listdir(BACKUP_DIR)
                             if f.startswith('activation_codes_') and f.endswith('.db')])
            
            if len(backups) > 7:
                for old_backup in backups[:-7]:
                    os.remove(old_backup)
            
            logger.info(f"Database backup created: {backup_path}")
            return True
        except Exception as e:
            logger.error(f"Error backing up database: {e}")
            return False
    
    def restore_database(self, backup_path):
        """Restore database from backup"""
        try:
            if not os.path.exists(backup_path):
                logger.error(f"Backup file not found: {backup_path}")
                return False
            
            # Create a backup of current database before restoring
            timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
            pre_restore_backup = os.path.join(BACKUP_DIR, f"pre_restore_{timestamp}.db")
            shutil.copy2(self.db_path, pre_restore_backup)
            
            # Restore from backup
            shutil.copy2(backup_path, self.db_path)
            
            # Clear connection pool and cache
            self.db_manager.clear_cache()
            
            # Re-initialize the database
            self._init_db()
            
            logger.info(f"Database restored from: {backup_path}")
            return True
        except Exception as e:
            logger.error(f"Error restoring database: {e}")
            return False
    
    def verify_solana_transaction(self, transaction_id, required_token=None, required_amount=None):
        """
        Verify that a transaction on Solana network is valid and contains payment for node access
        
        Args:
            transaction_id: Transaction signature from Solana
            required_token: Required token address
            required_amount: Required amount of tokens
            
        Returns:
            (bool, str, str): (is_valid, wallet_address, error_message)
        """
        if not SOLANA_AVAILABLE:
            logger.warning("Solana libraries not available, using mock verification")
            # In test mode, mock transaction verification
            if _config['test_mode']:
                # Simple mock for test mode
                if transaction_id and transaction_id.startswith("mock_tx_"):
                    return True, "test_wallet1", ""
                return False, "", "Invalid mock transaction ID"
        
        try:
            # Connect to Solana testnet or mainnet depending on configuration
            network = _config.get('solana_network', 'testnet')
            solana_client = Client(f"https://api.{network}.solana.com")
            
            # Get transaction details
            tx_response = solana_client.get_transaction(transaction_id)
            if not tx_response or "result" not in tx_response or not tx_response["result"]:
                return False, "", "Transaction not found"
            
            tx_data = tx_response["result"]
            
            # Check if transaction was successful
            if not tx_data.get("meta", {}).get("successful", False):
                return False, "", "Transaction was not successful"
            
            # Get the sender's wallet address
            if "message" in tx_data["transaction"] and "accountKeys" in tx_data["transaction"]["message"]:
                sender = tx_data["transaction"]["message"]["accountKeys"][0]
            else:
                return False, "", "Could not determine sender"
            
            # Check receiver
            receiver_address = _config.get('receiver_address')
            if not receiver_address:
                logger.warning("No receiver address configured for verification")
                # In test mode, skip receiver check
                if _config['test_mode']:
                    return True, sender, ""
                return False, "", "No receiver address configured"
            
            # For SPL token transfers, we need to parse the instruction data
            # This is simplified and would need to be expanded for production use
            if "instructions" in tx_data["transaction"]["message"]:
                for instruction in tx_data["transaction"]["message"]["instructions"]:
                    # Verify this is a token transfer to our receiver
                    # In a real implementation, this would parse program IDs and data
                    # to ensure it's an SPL token transfer of the correct type and amount
                    pass
            
            # If verification passes, return success and the sender's wallet
            return True, sender, ""
        except Exception as e:
            logger.error(f"Error verifying Solana transaction: {e}")
            return False, "", f"Verification error: {str(e)}"
    
    def generate_activation_code(self, wallet_address, transaction_id=None, expiry_days=7):
        """
        Generate a new activation code
        
        Args:
            wallet_address: Wallet address of the user
            transaction_id: Transaction ID of the payment (optional)
            expiry_days: Number of days until code expires
            
        Returns:
            The generated activation code
        """
        # Generate a secure random code with format QNET-XXXX-XXXX-XXXX
        code_bytes = secrets.token_bytes(12)
        code_hash = hashlib.sha256(code_bytes).hexdigest()
        
        # Format as QNET-XXXX-XXXX-XXXX
        formatted_code = f"QNET-{code_hash[:4].upper()}-{code_hash[4:8].upper()}-{code_hash[8:12].upper()}"
        
        # Calculate expiry time
        now = int(time.time())
        expires_at = now + (expiry_days * 86400)
        
        # Store in database
        try:
            self.db_manager.execute_query(
                "INSERT INTO activation_codes (code, wallet_address, transaction_id, created_at, expires_at, is_active, is_transferable) "
                "VALUES (?, ?, ?, ?, ?, 1, 1)",
                (formatted_code, wallet_address, transaction_id, now, expires_at),
                modify=True
            )
            
            logger.info(f"Generated activation code {formatted_code} for wallet {wallet_address}")
            
            # Update metrics
            try:
                from monitoring import prometheus_monitoring
                prometheus_monitoring.record_code_generation()
            except (ImportError, AttributeError):
                pass
                
            return formatted_code
        except Exception as e:
            logger.error(f"Error generating activation code: {e}")
            return None
    
    def verify_activation_code(self, code, node_id=None, node_address=None, signature=None):
        """
        Verify if an activation code is valid
        
        Args:
            code: The activation code to verify
            node_id: The ID of the node (optional)
            node_address: The address of the node (optional)
            signature: Node signature for verification (optional)
            
        Returns:
            (bool, str): (is_valid, message)
        """
        if not code:
            return False, "No activation code provided"
        
        # Validate format (QNET-XXXX-XXXX-XXXX)
        if not re.match(r'^QNET-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$', code):
            return False, "Invalid activation code format"
        
        try:
            # Get activation code data
            result = self.db_manager.execute_query(
                "SELECT wallet_address, expires_at, used_at, node_id, is_active, is_transferable, transfer_code, transfer_expires_at "
                "FROM activation_codes WHERE code = ?",
                (code,),
                fetchone=True
            )
            
            if not result:
                return False, "Activation code not found"
                
            wallet_address, expires_at, used_at, existing_node_id, is_active, is_transferable, transfer_code, transfer_expires_at = result
            
            # Check if code is active
            if not is_active:
                return False, "Activation code has been deactivated"
            
            # Check if code has expired
            now = int(time.time())
            if now > expires_at:
                return False, "Activation code has expired"
            
            # Handle node transfers
            if transfer_code and transfer_expires_at:
                # There's an active transfer in progress
                if now > transfer_expires_at:
                    # Transfer expired, reset transfer info
                    self.db_manager.execute_query(
                        "UPDATE activation_codes SET transfer_code = NULL, transfer_expires_at = NULL WHERE code = ?",
                        (code,),
                        modify=True
                    )
                elif node_id and node_id != existing_node_id:
                    # This is a new node trying to use the code during a transfer
                    # Check if we received the correct transfer code
                    if signature == transfer_code:
                        # Complete the transfer
                        self.db_manager.execute_query(
                            "INSERT INTO node_transfers (activation_code, old_node_id, new_node_id, transfer_time, wallet_address, transfer_code, is_completed) "
                            "VALUES (?, ?, ?, ?, ?, ?, 1)",
                            (code, existing_node_id, node_id, now, wallet_address, transfer_code),
                            modify=True
                        )
                        
                        # Update activation code to point to new node
                        self.db_manager.execute_query(
                            "UPDATE activation_codes SET node_id = ?, node_address = ?, transfer_code = NULL, transfer_expires_at = NULL WHERE code = ?",
                            (node_id, node_address, code),
                            modify=True
                        )
                        
                        # Deactivate old node
                        self.db_manager.execute_query(
                            "UPDATE nodes SET is_active = 0 WHERE node_id = ?",
                            (existing_node_id,),
                            modify=True
                        )
                        
                        logger.info(f"Node transfer completed: {existing_node_id} -> {node_id}")
                        return True, f"Node transfer completed"
                    else:
                        return False, "Invalid transfer code"
            
            # If code was already used, check if it's the same node
            if used_at and existing_node_id:
                if node_id and existing_node_id != node_id:
                    if is_transferable:
                        return False, "Activation code already used by another node. Initiate transfer to use on this device."
                    else:
                        return False, "Activation code already used by another node and is not transferable."
            
            # Verify signature if provided
            if signature and node_id:
                # Get node's signature key
                key_row = self.db_manager.execute_query(
                    "SELECT signature_key FROM nodes WHERE node_id = ?",
                    (node_id,),
                    fetchone=True
                )
                
                if key_row and key_row[0]:
                    # Verify the signature
                    message = f"{node_id}:{code}:{int(now/1000)}"
                    expected_signature = hashlib.sha256(f"{message}:{key_row[0]}".encode()).hexdigest()
                    
                    if signature != expected_signature:
                        return False, "Invalid node signature"
            
            # If this is first use or revalidation by same node, update the usage info
            if node_id and node_address:
                if not used_at or not existing_node_id:
                    # First use
                    self.db_manager.execute_query(
                        "UPDATE activation_codes SET used_at = ?, node_id = ?, node_address = ? WHERE code = ?",
                        (now, node_id, node_address, code),
                        modify=True
                    )
                    
                    # Generate signature key for node
                    signature_key = secrets.token_hex(16)
                    
                    # Register node
                    self.db_manager.execute_query(
                        "INSERT OR REPLACE INTO nodes (node_id, node_address, activation_code, wallet_address, last_verified, last_heartbeat, first_seen, is_active, signature_key) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)",
                        (node_id, node_address, code, wallet_address, now, now, now if not existing_node_id else None, signature_key),
                        modify=True
                    )
                    
                    # Return the signature key to the node
                    return True, signature_key
                else:
                    # Update last verified time
                    self.db_manager.execute_query(
                        "UPDATE nodes SET last_verified = ?, is_active = 1 WHERE node_id = ?",
                        (now, node_id),
                        modify=True
                    )
                    return True, f"Activation code valid for wallet {wallet_address}"
            
            # If just checking validity without activating
            return True, f"Activation code valid for wallet {wallet_address}"
            
        except Exception as e:
            logger.error(f"Error verifying activation code: {e}")
            return False, f"Error verifying activation code: {str(e)}"
    
    def update_node_heartbeat(self, node_id, activation_code, signature=None):
        """
        Update node heartbeat timestamp
        
        Args:
            node_id: Node ID
            activation_code: Activation code
            signature: Node signature for verification
            
        Returns:
            (bool, str): (success, message)
        """
        if not node_id or not activation_code:
            return False, "Missing node_id or activation_code"
        
        try:
            # Get node data
            result = self.db_manager.execute_query(
                "SELECT n.signature_key, a.wallet_address, n.last_heartbeat FROM nodes n "
                "JOIN activation_codes a ON n.activation_code = a.code "
                "WHERE n.node_id = ? AND n.activation_code = ?",
                (node_id, activation_code),
                fetchone=True
            )
            
            if not result:
                return False, "Node not found or activation code mismatch"
            
            signature_key, wallet_address, last_heartbeat = result
            
            # Verify signature if provided
            if signature and signature_key:
                now = int(time.time())
                message = f"{node_id}:{activation_code}:{int(now/1000)}"
                expected_signature = hashlib.sha256(f"{message}:{signature_key}".encode()).hexdigest()
                
                if signature != expected_signature:
                    return False, "Invalid signature"
            
            # Update heartbeat
            now = int(time.time())
            self.db_manager.execute_query(
                "UPDATE nodes SET last_heartbeat = ? WHERE node_id = ?",
                (now, node_id),
                modify=True
            )
            
            # Update metrics
            try:
                from monitoring import prometheus_monitoring
                prometheus_monitoring.record_heartbeat(node_id, last_heartbeat)
            except (ImportError, AttributeError):
                pass
                
            return True, "Heartbeat updated"
            
        except Exception as e:
            logger.error(f"Error updating node heartbeat: {e}")
            return False, f"Error updating heartbeat: {str(e)}"
    
    def initiate_node_transfer(self, activation_code, wallet_address, expiry_hours=24):
        """
        Initiate a node transfer to allow code to be used on a new device
        
        Args:
            activation_code: The activation code
            wallet_address: Wallet address for verification
            expiry_hours: Hours until transfer expires
            
        Returns:
            (bool, str, str): (success, message, transfer_code)
        """
        if not activation_code or not wallet_address:
            return False, "Missing activation_code or wallet_address", None
        
        try:
            # Verify code exists and belongs to this wallet
            result = self.db_manager.execute_query(
                "SELECT node_id, is_active, is_transferable, wallet_address FROM activation_codes "
                "WHERE code = ?",
                (activation_code,),
                fetchone=True
            )
            
            if not result:
                return False, "Activation code not found", None
                
            node_id, is_active, is_transferable, code_wallet = result
            
            # Verify wallet ownership
            if code_wallet != wallet_address:
                return False, "Activation code does not belong to this wallet", None
            
            # Check if code is active
            if not is_active:
                return False, "Activation code is not active", None
            
            # Check if transferable
            if not is_transferable:
                return False, "Activation code is not transferable", None
            
            # Generate transfer code
            transfer_code = secrets.token_hex(12)
            
            # Calculate expiry time
            now = int(time.time())
            transfer_expires_at = now + (expiry_hours * 3600)
            
            # Save transfer details
            self.db_manager.execute_query(
                "UPDATE activation_codes SET transfer_code = ?, transfer_expires_at = ? WHERE code = ?",
                (transfer_code, transfer_expires_at, activation_code),
                modify=True
            )
            
            # Log transfer initiation
            self.db_manager.execute_query(
                "INSERT INTO node_transfers (activation_code, old_node_id, wallet_address, transfer_time, transfer_code) "
                "VALUES (?, ?, ?, ?, ?)",
                (activation_code, node_id, wallet_address, now, transfer_code),
                modify=True
            )
            
            return True, f"Transfer initiated, expires in {expiry_hours} hours", transfer_code
            
        except Exception as e:
            logger.error(f"Error initiating node transfer: {e}")
            return False, f"Error initiating transfer: {str(e)}", None
    
    def cancel_node_transfer(self, activation_code, wallet_address):
        """
        Cancel an in-progress node transfer
        
        Args:
            activation_code: The activation code
            wallet_address: Wallet address for verification
            
        Returns:
            (bool, str): (success, message)
        """
        if not activation_code or not wallet_address:
            return False, "Missing activation_code or wallet_address"
        
        try:
            # Verify code exists and belongs to this wallet
            result = self.db_manager.execute_query(
                "SELECT wallet_address, transfer_code FROM activation_codes "
                "WHERE code = ?",
                (activation_code,),
                fetchone=True
            )
            
            if not result:
                return False, "Activation code not found"
                
            code_wallet, transfer_code = result
            
            # Verify wallet ownership
            if code_wallet != wallet_address:
                return False, "Activation code does not belong to this wallet"
            
            # Check if transfer is in progress
            if not transfer_code:
                return False, "No transfer in progress"
            
            # Cancel transfer
            self.db_manager.execute_query(
                "UPDATE activation_codes SET transfer_code = NULL, transfer_expires_at = NULL WHERE code = ?",
                (activation_code,),
                modify=True
            )
            
            # Update transfer record
            self.db_manager.execute_query(
                "UPDATE node_transfers SET is_completed = 2 WHERE activation_code = ? AND is_completed = 0",
                (activation_code,),
                modify=True
            )
            
            return True, "Transfer cancelled"
            
        except Exception as e:
            logger.error(f"Error cancelling node transfer: {e}")
            return False, f"Error cancelling transfer: {str(e)}"
    
    def get_codes_for_wallet(self, wallet_address):
        """
        Get all activation codes for a wallet with enhanced information
        
        Args:
            wallet_address: The wallet address to check
            
        Returns:
            list: List of activation codes and their status
        """
        if not wallet_address:
            return []
        
        try:
            results = self.db_manager.execute_query(
                "SELECT a.code, a.created_at, a.expires_at, a.used_at, a.node_id, a.node_address, a.is_active, "
                "n.last_heartbeat, n.last_verified, n.is_active as node_active, a.is_transferable, "
                "a.transfer_code IS NOT NULL as transfer_in_progress "
                "FROM activation_codes a LEFT JOIN nodes n ON a.node_id = n.node_id "
                "WHERE a.wallet_address = ? ORDER BY a.created_at DESC",
                (wallet_address,),
                fetchall=True,
                use_cache=True
            )
            
            codes = []
            
            for row in results:
                code, created_at, expires_at, used_at, node_id, node_address, is_active, last_heartbeat, last_verified, node_active, is_transferable, transfer_in_progress = row
                
                now = int(time.time())
                
                # Determine status
                if not is_active:
                    status = "Deactivated"
                elif now > expires_at:
                    status = "Expired"
                elif transfer_in_progress:
                    status = "Transfer Pending"
                elif used_at:
                    if node_active:
                        # Check if node is online based on heartbeat
                        if last_heartbeat and now - last_heartbeat < DEFAULT_CONFIG['heartbeat_timeout']:
                            status = "Active (Online)"
                        else:
                            status = "Active (Offline)"
                    else:
                        status = "Inactive"
                else:
                    status = "Unused"
                
                # Format dates
                format_time = lambda ts: datetime.fromtimestamp(ts).strftime('%Y-%m-%d %H:%M:%S') if ts else None
                
                codes.append({
                    "code": code,
                    "created_at": format_time(created_at),
                    "expires_at": format_time(expires_at),
                    "status": status,
                    "node_id": node_id,
                    "node_address": node_address,
                    "last_active": format_time(last_heartbeat),
                    "last_verified": format_time(last_verified),
                    "is_transferable": bool(is_transferable),
                    "transfer_in_progress": bool(transfer_in_progress),
                    "remaining_days": max(0, int((expires_at - now) / 86400)) if expires_at > now else 0
                })
            
            return codes
        except Exception as e:
            logger.error(f"Error getting codes for wallet: {e}")
            return []
    
    def deactivate_code(self, code, wallet_address=None):
        """
        Deactivate an activation code
        
        Args:
            code: The code to deactivate
            wallet_address: If provided, verify code belongs to this wallet
            
        Returns:
            bool: True if successful, False otherwise
        """
        try:
            # Verify wallet ownership if provided
            if wallet_address:
                result = self.db_manager.execute_query(
                    "SELECT wallet_address FROM activation_codes WHERE code = ?",
                    (code,),
                    fetchone=True
                )
                
                if not result or result[0] != wallet_address:
                    return False
            
            # Deactivate code
            rows_updated = self.db_manager.execute_query(
                "UPDATE activation_codes SET is_active = 0 WHERE code = ?",
                (code,),
                modify=True
            )
            
            # Also deactivate the node if it exists
            self.db_manager.execute_query(
                "UPDATE nodes SET is_active = 0 WHERE activation_code = ?",
                (code,),
                modify=True
            )
            
            return rows_updated > 0
        except Exception as e:
            logger.error(f"Error deactivating code: {e}")
            return False
    
    def get_active_nodes(self):
        """
        Get all active nodes
        
        Returns:
            list: List of active nodes
        """
        try:
            results = self.db_manager.execute_query(
                "SELECT node_id, node_address, activation_code, wallet_address, last_verified, first_seen, last_heartbeat "
                "FROM nodes WHERE is_active = 1",
                fetchall=True,
                use_cache=True
            )
            
            nodes = []
            now = int(time.time())
            
            for row in results:
                node_id, node_address, activation_code, wallet_address, last_verified, first_seen, last_heartbeat = row
                
                # Determine online status
                online_status = "Unknown"
                if last_heartbeat:
                    if now - last_heartbeat < 300:  # 5 minutes
                        online_status = "Online"
                    elif now - last_heartbeat < 3600:  # 1 hour
                        online_status = "Recently Online"
                    else:
                        online_status = "Offline"
                
                # Format dates
                format_time = lambda ts: datetime.fromtimestamp(ts).strftime('%Y-%m-%d %H:%M:%S') if ts else None
                
                nodes.append({
                    "node_id": node_id,
                    "node_address": node_address,
                    "activation_code": activation_code,
                    "wallet_address": wallet_address,
                    "last_verified": format_time(last_verified),
                    "first_seen": format_time(first_seen) if first_seen else None,
                    "last_heartbeat": format_time(last_heartbeat),
                    "online_status": online_status
                })
            
            return nodes
        except Exception as e:
            logger.error(f"Error getting active nodes: {e}")
            return []
    
    def clean_inactive_nodes(self, timeout=86400):
        """
        Clean up nodes that haven't been active for a while
        
        Args:
            timeout: Time in seconds after which a node is considered inactive
            
        Returns:
            int: Number of nodes deactivated
        """
        try:
            now = int(time.time())
            
            # Deactivate nodes without heartbeat for longer than timeout
            rows_updated = self.db_manager.execute_query(
                "UPDATE nodes SET is_active = 0 WHERE is_active = 1 AND last_heartbeat < ?",
                (now - timeout,),
                modify=True
            )
            
            logger.info(f"Deactivated {rows_updated} inactive nodes")
            return rows_updated
        except Exception as e:
            logger.error(f"Error cleaning inactive nodes: {e}")
            return 0

def init_integration(config_file=None, test_mode=False):
    """
    Initialize the token verification integration
    
    Args:
        config_file: Path to configuration file
        test_mode: Whether to run in test mode
        
    Returns:
        ActivationCodeManager: The activation code manager
    """
    global _config, _activation_manager, _db_encryption
    
    # Load configuration from file if provided
    if config_file:
        try:
            import configparser
            config = configparser.ConfigParser()
            config.read(config_file)
            
            if 'Authentication' in config:
                auth_config = config['Authentication']
                _config['verification_enabled'] = auth_config.getboolean('verification_enabled', True)
                _config['test_mode'] = auth_config.getboolean('test_mode', test_mode)
                _config['wallet_address'] = auth_config.get('wallet_address', 'test_wallet1')
            
            if 'PumpFun' in config:
                pump_config = config['PumpFun']
                _config['token_contract'] = pump_config.get('token_contract', 'test_contract')
                _config['min_balance'] = pump_config.getint('min_balance', 10000)
                _config['check_interval'] = pump_config.getint('check_interval', 86400)
                _config['grace_period'] = pump_config.getint('grace_period', 172800)
                _config['receiver_address'] = pump_config.get('receiver_address', None)
                
            if 'Security' in config:
                security_config = config['Security']
                if 'database_key' in security_config:
                    _config['database_key'] = security_config.get('database_key')
        except Exception as e:
            logger.error(f"Error loading config: {e}")
    
    # Override with test_mode parameter if provided
    if test_mode is not None:
        _config['test_mode'] = test_mode
    
    # Initialize database encryption if key provided
    if ENCRYPTION_AVAILABLE and _config.get('database_key'):
        _db_encryption = DatabaseEncryption()
        
        # Convert string key to Fernet key
        raw_key = _config['database_key']
        if len(raw_key) < 32:
            # Pad key
            raw_key = raw_key.ljust(32, '0')
        elif len(raw_key) > 32:
            # Hash key
            raw_key = hashlib.sha256(raw_key.encode()).hexdigest()[:32]
        
        # Convert to Fernet key
        key = base64.urlsafe_b64encode(raw_key.encode())
        _db_encryption.key = key
        
        logger.info("Database encryption enabled")
    
    # Initialize activation code manager
    _activation_manager = ActivationCodeManager(
        encryption_key=_db_encryption.key if _db_encryption else None
    )
    
    logger.info(f"Token verification initialized with config: {_config}")
    logger.info(f"Test mode: {_config['test_mode']}")
    
    return _activation_manager

def mock_wallet_balances():
    """Load mock wallet balances for test mode"""
    mock_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mock_balances.json")
    
    if os.path.exists(mock_file):
        try:
            with open(mock_file, 'r') as f:
                return json.load(f)
        except Exception as e:
            logger.error(f"Error loading mock balances: {e}")
    
    # Default mock balances
    return {
        "test_wallet1": 15000,
        "test_wallet2": 12000,
        "low_balance_wallet": 9000,
        "excluded_wallet": 5000
    }

def require_api_key(f):
    """Decorator to require API key for admin endpoints"""
    @wraps(f)
    def decorated(*args, **kwargs):
        api_key = request.headers.get('X-API-Key')
        # Simple API key validation (in production, use a more secure method)
        if not api_key or api_key != os.environ.get('QNET_ADMIN_KEY', 'qnet-admin-key'):
            return jsonify({"error": "Invalid API key"}), 403
        return f(*args, **kwargs)
    return decorated

def require_admin_auth(f):
    """Enhanced decorator for admin endpoints with JWT authentication"""
    @wraps(f)
    def decorated(*args, **kwargs):
        auth_header = request.headers.get('Authorization')
        
        # Check if Authorization header is present
        if not auth_header:
            return jsonify({"error": "Authorization header required"}), 401
            
        # Parse JWT token
        try:
            # Expected format: "Bearer <token>"
            parts = auth_header.split()
            if len(parts) != 2 or parts[0].lower() != 'bearer':
                return jsonify({"error": "Invalid authorization format"}), 401
                
            token = parts[1]
            
            # Verify JWT token
            try:
                import jwt
                
                secret_key = os.environ.get('QNET_ADMIN_SECRET', 'qnet-admin-secret')
                payload = jwt.decode(token, secret_key, algorithms=["HS256"])
                
                # Check if token has admin role
                if 'role' not in payload or payload['role'] != 'admin':
                    return jsonify({"error": "Insufficient permissions"}), 403
                    
                # Store admin info in Flask g object for later use
                g.admin_id = payload.get('sub')
                
            except ImportError:
                logger.warning("JWT package not installed. Falling back to API key.")
                return require_api_key(f)(*args, **kwargs)
                
        except Exception as e:
            logger.error(f"Authentication error: {e}")
            return jsonify({"error": "Authentication failed"}), 401
            
        return f(*args, **kwargs)
    return decorated

def resilient_response(func):
    """Decorator to add retry logic and error handling to API endpoints"""
    @wraps(func)
    def wrapper(*args, **kwargs):
        max_retries = 3
        retry_delay = 1  # seconds
        
        for attempt in range(max_retries):
            try:
                return func(*args, **kwargs)
            except sqlite3.OperationalError as e:
                # Database is locked or other SQLite error
                if "database is locked" in str(e) and attempt < max_retries - 1:
                    logger.warning(f"Database locked, retrying in {retry_delay}s (attempt {attempt+1})")
                    time.sleep(retry_delay)
                    retry_delay *= 2  # Exponential backoff
                else:
                    logger.error(f"SQLite error in {func.__name__}: {e}")
                    return jsonify({"error": "Database error, please try again"}), 500
            except Exception as e:
                logger.error(f"Error in {func.__name__}: {e}")
                return jsonify({"error": "Internal server error"}), 500
        
        # If we get here, all retries failed
        return jsonify({"error": "Service temporarily unavailable"}), 503
    
    return wrapper

# REST API Endpoints
@token_verification_bp.route('/generate_code', methods=['POST'])
@resilient_response
def generate_code():
    """Generate an activation code for a wallet"""
    if not request.is_json:
        return jsonify({"error": "Request must be JSON"}), 400
    
    data = request.get_json()
    wallet_address = data.get('wallet_address')
    transaction_id = data.get('transaction_id')
    
    if not wallet_address:
        return jsonify({"error": "Wallet address is required"}), 400
    
    if not _config['test_mode'] and not transaction_id:
        return jsonify({"error": "Transaction ID is required in production mode"}), 400
    
    # In test mode, check mock balances
    if _config['test_mode']:
        mock_balances = mock_wallet_balances()
        
        if wallet_address not in mock_balances:
            return jsonify({"error": "Wallet not found in test balances"}), 404
    else:
        # In production mode, verify Solana transaction
        is_valid, verified_wallet, error = _activation_manager.verify_solana_transaction(
            transaction_id,
            _config.get('token_contract'),
            _config.get('min_balance')
        )
        
        if not is_valid:
            return jsonify({"error": f"Invalid transaction: {error}"}), 400
        
        # Use verified wallet from transaction
        wallet_address = verified_wallet
    
    # Generate activation code
    code = _activation_manager.generate_activation_code(wallet_address, transaction_id)
    
    if not code:
        return jsonify({"error": "Failed to generate activation code"}), 500
    
    return jsonify({
        "success": True, 
        "activation_code": code,
        "expires_at": datetime.fromtimestamp(int(time.time()) + 
                                          _config.get('activation_code_expiry', 604800)).strftime('%Y-%m-%d %H:%M:%S')
    }), 201

@token_verification_bp.route('/verify_code', methods=['POST'])
@resilient_response
def verify_code():
    """Verify an activation code"""
    if not request.is_json:
        return jsonify({"error": "Request must be JSON"}), 400
    
    data = request.get_json()
    code = data.get('activation_code')
    node_id = data.get('node_id')
    node_address = data.get('node_address')
    signature = data.get('signature')
    
    if not code:
        return jsonify({"error": "Activation code is required"}), 400
    
    # In test mode, allow special test codes
    if _config['test_mode'] and code == "QNET-TEST-TEST-TEST":
        return jsonify({
            "success": True,
            "message": "Test activation code accepted",
            "wallet_address": "test_wallet1"
        }), 200
    
    is_valid, message = _activation_manager.verify_activation_code(
        code, node_id, node_address, signature
    )
    
    if not is_valid:
        return jsonify({"error": message}), 400
    
    # Return signature key if this was first verification
    if isinstance(message, str) and message.startswith("Activation code valid"):
        return jsonify({
            "success": True,
            "message": message
        }), 200
    else:
        # This is a signature key from first activation
        return jsonify({
            "success": True,
            "message": "Node activated successfully",
            "signature_key": message
        }), 200

@token_verification_bp.route('/heartbeat', methods=['POST'])
@resilient_response
def node_heartbeat():
    """Update node heartbeat timestamp"""
    if not request.is_json:
        return jsonify({"error": "Request must be JSON"}), 400
    
    data = request.get_json()
    node_id = data.get('node_id')
    activation_code = data.get('activation_code')
    signature = data.get('signature')
    
    if not node_id or not activation_code:
        return jsonify({"error": "Node ID and activation code are required"}), 400
    
    success, message = _activation_manager.update_node_heartbeat(
        node_id, activation_code, signature
    )
    
    if not success:
        return jsonify({"error": message}), 400
    
    return jsonify({
        "success": True,
        "message": message
    }), 200

@token_verification_bp.route('/wallet_codes/<wallet_address>', methods=['GET'])
@resilient_response
def get_wallet_codes(wallet_address):
    """Get all activation codes for a wallet"""
    codes = _activation_manager.get_codes_for_wallet(wallet_address)
    
    return jsonify({
        "wallet_address": wallet_address,
        "codes": codes
    }), 200

@token_verification_bp.route('/initiate_transfer', methods=['POST'])
@resilient_response
def initiate_transfer():
    """Initiate node transfer to allow using code on another device"""
    if not request.is_json:
        return jsonify({"error": "Request must be JSON"}), 400
    
    data = request.get_json()
    activation_code = data.get('activation_code')
    wallet_address = data.get('wallet_address')
    
    if not activation_code or not wallet_address:
        return jsonify({"error": "Activation code and wallet address are required"}), 400
    
    success, message, transfer_code = _activation_manager.initiate_node_transfer(
        activation_code, wallet_address
    )
    
    if not success:
        return jsonify({"error": message}), 400
    
    return jsonify({
        "success": True,
        "message": message,
        "transfer_code": transfer_code
    }), 200

@token_verification_bp.route('/cancel_transfer', methods=['POST'])
@resilient_response
def cancel_transfer():
    """Cancel an in-progress node transfer"""
    if not request.is_json:
        return jsonify({"error": "Request must be JSON"}), 400
    
    data = request.get_json()
    activation_code = data.get('activation_code')
    wallet_address = data.get('wallet_address')
    
    if not activation_code or not wallet_address:
        return jsonify({"error": "Activation code and wallet address are required"}), 400
    
    success, message = _activation_manager.cancel_node_transfer(
        activation_code, wallet_address
    )
    
    if not success:
        return jsonify({"error": message}), 400
    
    return jsonify({
        "success": True,
        "message": message
    }), 200

@token_verification_bp.route('/deactivate_code', methods=['POST'])
@require_admin_auth
@resilient_response
def deactivate_code():
    """Deactivate an activation code (admin only)"""
    if not request.is_json:
        return jsonify({"error": "Request must be JSON"}), 400
    
    data = request.get_json()
    code = data.get('activation_code')
    wallet_address = data.get('wallet_address')  # Optional
    
    if not code:
        return jsonify({"error": "Activation code is required"}), 400
    
    success = _activation_manager.deactivate_code(code, wallet_address)
    
    if not success:
        return jsonify({"error": "Failed to deactivate code"}), 500
    
    return jsonify({
        "success": True,
        "message": f"Activation code {code} deactivated"
    }), 200

@token_verification_bp.route('/active_nodes', methods=['GET'])
@require_admin_auth
@resilient_response
def get_active_nodes():
    """Get all active nodes (admin only)"""
    nodes = _activation_manager.get_active_nodes()
    
    return jsonify({
        "count": len(nodes),
        "nodes": nodes
    }), 200

def register_endpoints(app):
    """Register API endpoints with Flask app"""
    app.register_blueprint(token_verification_bp)
    logger.info("Token verification API endpoints registered")