#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: key_manager.py
Secure key management for QNet
"""

import os
import logging
import json
import base64
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.backends import default_backend
from typing import Tuple, Optional, Dict, Any

class KeyManager:
    """Secure key management for QNet nodes."""
    
    def __init__(self, keys_dir: str = "/app/keys"):
        """
        Initialize the key manager with a keys directory.
        
        Args:
            keys_dir: Directory path for storing keys
        """
        self.keys_dir = keys_dir
        self._ensure_keys_dir()
        self.current_keys: Dict[str, Any] = {}
        
    def _ensure_keys_dir(self) -> None:
        """Ensure the keys directory exists."""
        if not os.path.exists(self.keys_dir):
            try:
                os.makedirs(self.keys_dir, mode=0o700)  # Secure permissions
                logging.info(f"Created keys directory: {self.keys_dir}")
            except Exception as e:
                logging.error(f"Failed to create keys directory: {e}")
                raise
                
    def generate_key_pair(self) -> Tuple[bytes, bytes]:
        """
        Generate a new key pair using the appropriate crypto module.
        
        Returns:
            Tuple containing (public_key, secret_key) as bytes
        """
        try:
            # Import lazily to avoid circular imports
            from crypto_bindings import generate_dilithium_keypair
            return generate_dilithium_keypair()
        except Exception as e:
            logging.error(f"Failed to generate key pair: {e}")
            raise
            
    def load_or_create_node_keys(self, node_id: str, password: Optional[str] = None) -> Tuple[bytes, bytes]:
        """
        Load existing keys or create new ones for a node.
        
        Args:
            node_id: Node identifier
            password: Optional password for encrypting keys
            
        Returns:
            Tuple containing (public_key, secret_key) as bytes
        """
        key_path = os.path.join(self.keys_dir, f"{node_id}.keys")
        
        # Check if keys already exist
        if os.path.exists(key_path):
            try:
                return self._load_keys(key_path, password)
            except Exception as e:
                logging.error(f"Failed to load keys for node {node_id}: {e}")
                logging.warning(f"Generating new keys for node {node_id}")
        
        # Generate new keys
        public_key, secret_key = self.generate_key_pair()
        
        # Save the keys securely
        try:
            self._save_keys(key_path, public_key, secret_key, password)
        except Exception as e:
            logging.error(f"Failed to save keys for node {node_id}: {e}")
            
        # Cache the current keys
        self.current_keys = {
            "node_id": node_id,
            "public_key": public_key,
            "secret_key": secret_key
        }
        
        return public_key, secret_key
        
    def _derive_key(self, password: str, salt: bytes) -> bytes:
        """
        Derive an encryption key from a password.
        
        Args:
            password: User password
            salt: Random salt for key derivation
            
        Returns:
            Derived key for encryption/decryption
        """
        if not password:
            raise ValueError("Password is required for encrypted keys")
            
        kdf = PBKDF2HMAC(
            algorithm=hashes.SHA256(),
            length=32,  # 256 bits for AES-256
            salt=salt,
            iterations=100000,  # High iteration count for security
            backend=default_backend()
        )
        
        return kdf.derive(password.encode())
        
    def _save_keys(self, key_path: str, public_key: bytes, secret_key: bytes, 
                  password: Optional[str] = None) -> None:
        """
        Save keys to disk, optionally encrypted.
        
        Args:
            key_path: Path to save keys
            public_key: Public key bytes
            secret_key: Secret key bytes
            password: Optional password for encryption
        """
        data = {
            "public_key": base64.b64encode(public_key).decode(),
        }
        
        if password:
            # Encrypt the secret key
            salt = os.urandom(16)
            key = self._derive_key(password, salt)
            aesgcm = AESGCM(key)
            nonce = os.urandom(12)
            
            # Encrypt the secret key
            ct = aesgcm.encrypt(nonce, secret_key, None)
            
            # Store encrypted data
            data["encrypted"] = True
            data["salt"] = base64.b64encode(salt).decode()
            data["nonce"] = base64.b64encode(nonce).decode()
            data["secret_key"] = base64.b64encode(ct).decode()
        else:
            # Store unencrypted (not recommended for production)
            data["encrypted"] = False
            data["secret_key"] = base64.b64encode(secret_key).decode()
            
        # Save with secure permissions
        with open(key_path, 'w') as f:
            json.dump(data, f)
        
        os.chmod(key_path, 0o600)  # Read/write for owner only
        
    def _load_keys(self, key_path: str, password: Optional[str] = None) -> Tuple[bytes, bytes]:
        """
        Load keys from disk, decrypting if necessary.
        
        Args:
            key_path: Path to key file
            password: Optional password for decryption
            
        Returns:
            Tuple containing (public_key, secret_key) as bytes
        """
        with open(key_path, 'r') as f:
            data = json.load(f)
            
        public_key = base64.b64decode(data["public_key"])
        
        if data.get("encrypted", False):
            if not password:
                raise ValueError("Password required to decrypt keys")
                
            # Decrypt the secret key
            salt = base64.b64decode(data["salt"])
            nonce = base64.b64decode(data["nonce"])
            ct = base64.b64decode(data["secret_key"])
            
            key = self._derive_key(password, salt)
            aesgcm = AESGCM(key)
            
            try:
                secret_key = aesgcm.decrypt(nonce, ct, None)
            except Exception:
                raise ValueError("Invalid password or corrupted key file")
        else:
            # Load unencrypted
            secret_key = base64.b64decode(data["secret_key"])
            
        # Cache the current keys
        self.current_keys = {
            "public_key": public_key,
            "secret_key": secret_key
        }
            
        return public_key, secret_key
        
    def get_public_key_str(self, node_id: Optional[str] = None) -> str:
        """
        Get the public key as a string.
        
        Args:
            node_id: Optional node identifier if keys need to be loaded
            
        Returns:
            Base64 encoded public key string
        """
        if self.current_keys and "public_key" in self.current_keys:
            return base64.b64encode(self.current_keys["public_key"]).decode()
            
        if node_id:
            # Load keys if not cached
            public_key, _ = self.load_or_create_node_keys(node_id)
            return base64.b64encode(public_key).decode()
            
        raise ValueError("No keys loaded and no node_id provided")
        
    def sign_message(self, message: str, node_id: Optional[str] = None, 
                   password: Optional[str] = None) -> str:
        """
        Sign a message using the node's secret key.
        
        Args:
            message: Message to sign
            node_id: Optional node identifier if keys need to be loaded
            password: Optional password if keys are encrypted
            
        Returns:
            Base64 encoded signature
        """
        # Ensure we have keys loaded
        if not (self.current_keys and "secret_key" in self.current_keys) and node_id:
            _, _ = self.load_or_create_node_keys(node_id, password)
            
        if not (self.current_keys and "secret_key" in self.current_keys):
            raise ValueError("No keys loaded for signing")
            
        # Import lazily to avoid circular imports
        from crypto_bindings import sign_message
        
        # Always use bytes for secret key
        secret_key = self.current_keys["secret_key"]
        if isinstance(secret_key, str):
            secret_key = secret_key.encode()
            
        signature = sign_message(message.encode(), secret_key)
        return base64.b64encode(signature).decode()
        
    def verify_signature(self, message: str, signature: str, public_key: str) -> bool:
        """
        Verify a signature using a public key.
        
        Args:
            message: Message that was signed
            signature: Base64 encoded signature
            public_key: Base64 encoded or PEM format public key
            
        Returns:
            True if signature is valid, False otherwise
        """
        # Import lazily to avoid circular imports
        from crypto_bindings import verify_signature
        
        # Convert inputs to appropriate formats
        if isinstance(message, str):
            message = message.encode()
            
        if isinstance(signature, str):
            signature = base64.b64decode(signature)
            
        if isinstance(public_key, str):
            if public_key.startswith("-----BEGIN PUBLIC KEY-----"):
                # PEM format
                public_key = public_key.encode()
            else:
                # Base64 format
                public_key = base64.b64decode(public_key)
                
        return verify_signature(message, signature, public_key)
    
    def backup_keys(self, backup_path: str, password: str) -> bool:
        """
        Create an encrypted backup of all keys.
        
        Args:
            backup_path: Path to save the backup
            password: Password to encrypt the backup
            
        Returns:
            True if backup successful, False otherwise
        """
        try:
            # Get all key files
            key_files = [f for f in os.listdir(self.keys_dir) if f.endswith('.keys')]
            
            if not key_files:
                logging.warning("No keys found to backup")
                return False
                
            # Create backup data structure
            backup_data = {
                "version": 1,
                "keys": {}
            }
            
            # Process each key file
            for key_file in key_files:
                key_path = os.path.join(self.keys_dir, key_file)
                node_id = key_file.replace('.keys', '')
                
                try:
                    with open(key_path, 'r') as f:
                        key_data = json.load(f)
                    
                    # Add to backup data
                    backup_data["keys"][node_id] = key_data
                except Exception as e:
                    logging.error(f"Failed to backup key {key_file}: {e}")
            
            # Encrypt the entire backup
            backup_json = json.dumps(backup_data)
            salt = os.urandom(16)
            key = self._derive_key(password, salt)
            aesgcm = AESGCM(key)
            nonce = os.urandom(12)
            
            # Encrypt the backup data
            ct = aesgcm.encrypt(nonce, backup_json.encode(), None)
            
            # Create final backup file
            final_backup = {
                "version": 1,
                "encrypted": True,
                "salt": base64.b64encode(salt).decode(),
                "nonce": base64.b64encode(nonce).decode(),
                "data": base64.b64encode(ct).decode()
            }
            
            # Save backup
            with open(backup_path, 'w') as f:
                json.dump(final_backup, f)
            
            # Set secure permissions
            os.chmod(backup_path, 0o600)
            
            logging.info(f"Keys backup created at {backup_path}")
            return True
        
        except Exception as e:
            logging.error(f"Failed to create keys backup: {e}")
            return False
    
    def restore_keys_from_backup(self, backup_path: str, password: str) -> int:
        """
        Restore keys from an encrypted backup.
        
        Args:
            backup_path: Path to the backup file
            password: Password to decrypt the backup
            
        Returns:
            Number of keys restored
        """
        try:
            # Load backup file
            with open(backup_path, 'r') as f:
                backup = json.load(f)
                
            if not backup.get("encrypted", False):
                raise ValueError("Backup is not encrypted")
                
            # Decrypt backup
            salt = base64.b64decode(backup["salt"])
            nonce = base64.b64decode(backup["nonce"])
            ct = base64.b64decode(backup["data"])
            
            key = self._derive_key(password, salt)
            aesgcm = AESGCM(key)
            
            try:
                decrypted_data = aesgcm.decrypt(nonce, ct, None)
            except Exception:
                raise ValueError("Invalid password or corrupted backup")
                
            # Parse decrypted data
            backup_data = json.loads(decrypted_data.decode())
            
            # Restore each key
            restored_count = 0
            for node_id, key_data in backup_data["keys"].items():
                key_path = os.path.join(self.keys_dir, f"{node_id}.keys")
                
                # Skip if key already exists and not forced
                if os.path.exists(key_path):
                    logging.warning(f"Key for node {node_id} already exists, skipping")
                    continue
                
                # Save key data
                with open(key_path, 'w') as f:
                    json.dump(key_data, f)
                
                # Set secure permissions
                os.chmod(key_path, 0o600)
                
                restored_count += 1
                
            logging.info(f"Restored {restored_count} keys from backup")
            return restored_count
            
        except Exception as e:
            logging.error(f"Failed to restore keys from backup: {e}")
            return 0

# Singleton instance
_key_manager_instance = None

def get_key_manager() -> KeyManager:
    """
    Get or create the singleton key manager instance.
    
    Returns:
        KeyManager: The singleton instance
    """
    global _key_manager_instance
    if _key_manager_instance is None:
        _key_manager_instance = KeyManager()
    return _key_manager_instance