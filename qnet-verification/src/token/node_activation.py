#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: node_activation.py
Service for QNet node activation using token verification
"""

import os
import json
import logging
import time
import uuid
import hashlib
from typing import Dict, Any, Optional, Tuple, List, Union

# Import token verification
from token_verification import get_token_verifier

class NodeActivationService:
    """
    Service for QNet node activation and management based on token ownership.
    Handles validation, grace periods, and deactivation of nodes.
    """
    
    def __init__(self, config=None):
        """
        Initialize the node activation service.
        
        Args:
            config: Configuration object or dictionary
        """
        # Default configuration
        self.config = {
            'network': os.environ.get('QNET_NETWORK', 'testnet'),
            'min_token_balance': int(os.environ.get('QNET_MIN_TOKEN_BALANCE', '10000')),
            'grace_period_days': int(os.environ.get('QNET_GRACE_PERIOD_DAYS', '7')),
            'check_interval_hours': int(os.environ.get('QNET_CHECK_INTERVAL_HOURS', '24')),
            'activation_db_file': os.environ.get('QNET_ACTIVATION_DB_FILE', '/app/data/activation_db.json'),
            'activated_only_mode': os.environ.get('QNET_ACTIVATED_ONLY', 'false').lower() == 'true',
        }
        
        # Override with provided config if available
        if config:
            if hasattr(config, '__getitem__'):
                # Dictionary-like object
                for key, value in self.config.items():
                    if key in config:
                        self.config[key] = config[key]
            else:
                # Attribute-based object
                for key in self.config.keys():
                    if hasattr(config, key):
                        self.config[key] = getattr(config, key)
        
        # Initialize token verifier
        self.token_verifier = get_token_verifier(config)
        
        # Load or initialize activation database
        self.activation_db = self._load_activation_db()
        
        # Convert grace period to seconds
        self.grace_period_seconds = self.config['grace_period_days'] * 24 * 60 * 60
        
        logging.info(f"Node activation service initialized for {self.config['network']} network")
        logging.info(f"Minimum token balance: {self.config['min_token_balance']}")
        logging.info(f"Grace period: {self.config['grace_period_days']} days")
    
    def _load_activation_db(self) -> Dict[str, Any]:
        """
        Load the activation database from file.
        
        Returns:
            Dictionary with node activation data
        """
        try:
            # Ensure directory exists
            os.makedirs(os.path.dirname(self.config['activation_db_file']), exist_ok=True)
            
            # Load existing database if it exists
            if os.path.exists(self.config['activation_db_file']):
                with open(self.config['activation_db_file'], 'r') as f:
                    return json.load(f)
            
            # Initialize new database
            activation_db = {
                'version': 1,
                'network': self.config['network'],
                'last_updated': int(time.time()),
                'nodes': {}
            }
            
            # Save empty database
            self._save_activation_db(activation_db)
            return activation_db
            
        except Exception as e:
            logging.error(f"Error loading activation database: {e}")
            # Return empty database on error
            return {
                'version': 1,
                'network': self.config['network'],
                'last_updated': int(time.time()),
                'nodes': {}
            }
    
    def _save_activation_db(self, activation_db: Optional[Dict[str, Any]] = None) -> bool:
        """
        Save the activation database to file.
        
        Args:
            activation_db: Database to save (uses self.activation_db if None)
            
        Returns:
            True if saved successfully, False otherwise
        """
        if activation_db is None:
            activation_db = self.activation_db
            
        try:
            # Update timestamp
            activation_db['last_updated'] = int(time.time())
            
            # Ensure directory exists
            os.makedirs(os.path.dirname(self.config['activation_db_file']), exist_ok=True)
            
            # Save to file
            with open(self.config['activation_db_file'], 'w') as f:
                json.dump(activation_db, f, indent=2)
                
            return True
        except Exception as e:
            logging.error(f"Error saving activation database: {e}")
            return False
    
    def activate_node(self, node_id: str, wallet_address: str, signature: Optional[str] = None) -> Tuple[bool, str]:
        """
        Activate a node based on token ownership verification.
        
        Args:
            node_id: Node identifier
            wallet_address: Solana wallet address
            signature: Optional signature for verification
            
        Returns:
            Tuple of (success, message)
        """
        # Check if node is already activated
        if node_id in self.activation_db['nodes']:
            node_data = self.activation_db['nodes'][node_id]
            # If node is active and associated with same wallet, just return success
            if node_data['status'] == 'active' and node_data['wallet_address'] == wallet_address:
                return True, "Node already activated"
                
            # If node exists but with different wallet, reject
            if node_data['wallet_address'] != wallet_address:
                return False, "Node ID already activated with different wallet"
        
        # Verify token balance
        is_verified, balance = self.token_verifier.verify_token_balance(wallet_address)
        
        if not is_verified:
            message = f"Insufficient token balance. Required: {self.config['min_token_balance']}, Current: {balance}"
            return False, message
        
        # Verify signature if provided
        if signature and not self.token_verifier.verify_signature(node_id, signature, wallet_address):
            return False, "Invalid signature"
        
        # Create or update node activation
        node_entry = {
            'node_id': node_id,
            'wallet_address': wallet_address,
            'status': 'active',
            'token_balance': balance,
            'activation_time': int(time.time()),
            'last_check_time': int(time.time()),
            'grace_period_start': None
        }
        
        self.activation_db['nodes'][node_id] = node_entry
        self._save_activation_db()
        
        return True, "Node activated successfully"
    
    def check_node_status(self, node_id: str) -> Tuple[bool, str, Dict[str, Any]]:
        """
        Check if a node is activated and in good standing.
        
        Args:
            node_id: Node identifier
            
        Returns:
            Tuple of (is_active, message, node_data)
        """
        # Check if node exists in database
        if node_id not in self.activation_db['nodes']:
            return False, "Node not activated", {}
        
        node_data = self.activation_db['nodes'][node_id]
        
        # If node is in grace period, check if it has expired
        if node_data['status'] == 'grace_period' and node_data['grace_period_start']:
            grace_end_time = node_data['grace_period_start'] + self.grace_period_seconds
            if int(time.time()) > grace_end_time:
                # Grace period expired, deactivate node
                node_data['status'] = 'deactivated'
                node_data['deactivation_time'] = int(time.time())
                self._save_activation_db()
                return False, "Node deactivated due to expired grace period", node_data
        
        # Node is active or in valid grace period
        return (node_data['status'] == 'active' or node_data['status'] == 'grace_period'), 
               f"Node status: {node_data['status']}", 
               node_data
    
    def update_node_status(self, node_id: str) -> Tuple[bool, str]:
        """
        Update node status by checking current token balance.
        
        Args:
            node_id: Node identifier
            
        Returns:
            Tuple of (success, message)
        """
        # Check if node exists in database
        if node_id not in self.activation_db['nodes']:
            return False, "Node not activated"
        
        node_data = self.activation_db['nodes'][node_id]
        wallet_address = node_data['wallet_address']
        
        # Update last check time
        node_data['last_check_time'] = int(time.time())
        
        # Verify token balance
        is_verified, balance = self.token_verifier.verify_token_balance(wallet_address)
        node_data['token_balance'] = balance
        
        # Update status based on verification
        if is_verified:
            # If node was in grace period, restore to active
            if node_data['status'] == 'grace_period':
                node_data['status'] = 'active'
                node_data['grace_period_start'] = None
                message = "Node restored to active status"
            else:
                message = "Node remains active"
                
        else:
            if node_data['status'] == 'active':
                # Start grace period
                node_data['status'] = 'grace_period'
                node_data['grace_period_start'] = int(time.time())
                message = f"Node entered grace period. Balance: {balance}, Required: {self.config['min_token_balance']}"
            elif node_data['status'] == 'grace_period':
                # Check if grace period has expired
                grace_end_time = node_data['grace_period_start'] + self.grace_period_seconds
                if int(time.time()) > grace_end_time:
                    node_data['status'] = 'deactivated'
                    node_data['deactivation_time'] = int(time.time())
                    message = "Node deactivated due to expired grace period"
                else:
                    days_left = (grace_end_time - int(time.time())) // (24 * 60 * 60)
                    message = f"Node in grace period. {days_left} days remaining."
            else:
                message = "Node status unchanged"
        
        # Save changes
        self._save_activation_db()
        
        return node_data['status'] in ['active', 'grace_period'], message
    
    def deactivate_node(self, node_id: str, wallet_address: Optional[str] = None) -> Tuple[bool, str]:
        """
        Deactivate a node.
        
        Args:
            node_id: Node identifier
            wallet_address: Optional wallet address for verification
            
        Returns:
            Tuple of (success, message)
        """
        # Check if node exists in database
        if node_id not in self.activation_db['nodes']:
            return False, "Node not found"
        
        node_data = self.activation_db['nodes'][node_id]
        
        # Verify wallet ownership if address provided
        if wallet_address and node_data['wallet_address'] != wallet_address:
            return False, "Wallet address does not match node registration"
        
        # Deactivate the node
        node_data['status'] = 'deactivated'
        node_data['deactivation_time'] = int(time.time())
        
        # Save changes
        self._save_activation_db()
        
        return True, "Node deactivated successfully"
    
    def list_active_nodes(self) -> List[Dict[str, Any]]:
        """
        Get a list of all active and grace period nodes.
        
        Returns:
            List of node data dictionaries
        """
        active_nodes = []
        
        for node_id, node_data in self.activation_db['nodes'].items():
            if node_data['status'] in ['active', 'grace_period']:
                active_nodes.append(node_data)
                
        return active_nodes
    
    def cleanup_expired_nodes(self) -> int:
        """
        Check all nodes in grace period and deactivate if expired.
        
        Returns:
            Number of nodes deactivated
        """
        deactivated_count = 0
        current_time = int(time.time())
        
        for node_id, node_data in self.activation_db['nodes'].items():
            if node_data['status'] == 'grace_period' and node_data['grace_period_start']:
                grace_end_time = node_data['grace_period_start'] + self.grace_period_seconds
                if current_time > grace_end_time:
                    # Grace period expired, deactivate node
                    node_data['status'] = 'deactivated'
                    node_data['deactivation_time'] = current_time
                    deactivated_count += 1
        
        if deactivated_count > 0:
            # Save changes
            self._save_activation_db()
            logging.info(f"Deactivated {deactivated_count} nodes with expired grace periods")
        
        return deactivated_count
    
    def is_node_allowed(self, node_id: str) -> bool:
        """
        Check if a node is allowed to connect based on activation status.
        Used for network access control.
        
        Args:
            node_id: Node identifier
            
        Returns:
            True if node is allowed, False otherwise
        """
        # If not in activated-only mode, allow all
        if not self.config['activated_only_mode']:
            return True
            
        # Check node status
        is_active, _, _ = self.check_node_status(node_id)
        return is_active


# Helper function to get singleton instance
_activation_service_instance = None

def get_activation_service(config=None) -> NodeActivationService:
    """
    Get or create the singleton activation service instance.
    
    Args:
        config: Optional configuration
        
    Returns:
        NodeActivationService instance
    """
    global _activation_service_instance
    if _activation_service_instance is None:
        _activation_service_instance = NodeActivationService(config)
    return _activation_service_instance