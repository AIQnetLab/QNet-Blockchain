#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: mobile_api.py
REST API for mobile/lightweight clients
"""

import os
import json
import logging
import time
import hashlib
import base64
from typing import Dict, Any, List, Optional, Union
from flask import Flask, request, jsonify, Blueprint

# Import QNet components
from node.lightweight_node import get_lightweight_node
from security import get_security_manager
from key_manager import get_key_manager

class MobileAPI:
    """
    REST API for mobile and lightweight clients.
    Provides endpoints for wallet functionality, transaction submission,
    and querying blockchain state.
    """
    
    def __init__(self, app: Flask, config=None):
        """
        Initialize the mobile API.
        
        Args:
            app: Flask application instance
            config: Configuration object or dictionary
        """
        # Default configuration
        self.config = {
            'mobile_api_enabled': os.environ.get('QNET_MOBILE_API_ENABLED', 'true').lower() == 'true',
            'mobile_api_prefix': os.environ.get('QNET_MOBILE_API_PREFIX', '/api/mobile'),
            'mobile_api_rate_limit': int(os.environ.get('QNET_MOBILE_API_RATE_LIMIT', '100')),
            'mobile_api_require_auth': os.environ.get('QNET_MOBILE_API_AUTH', 'false').lower() == 'true',
            'max_transaction_size_kb': int(os.environ.get('QNET_MAX_TX_SIZE', '64')),  # 64KB
            'max_transactions_per_request': int(os.environ.get('QNET_MAX_TX_PER_REQUEST', '100')),
        }
        
        # Override with provided config if available
        if config:
            if hasattr(config, '__getitem__'):
                for key, value in self.config.items():
                    if key in config:
                        self.config[key] = config[key]
            else:
                for key in self.config.keys():
                    if hasattr(config, key):
                        self.config[key] = getattr(config, key)
        
        # Store Flask app reference
        self.app = app
        
        # Create blueprint
        self.blueprint = Blueprint('mobile_api', __name__)
        
        # Get component instances
        self.lightweight_node = get_lightweight_node()
        self.security_manager = get_security_manager()
        self.key_manager = get_key_manager()
        
        # Register routes if mobile API is enabled
        if self.config['mobile_api_enabled']:
            self._register_routes()
            
            # Register blueprint with app
            self.app.register_blueprint(self.blueprint, url_prefix=self.config['mobile_api_prefix'])
            
            logging.info(f"Mobile API initialized at {self.config['mobile_api_prefix']}")
        else:
            logging.info("Mobile API disabled")
    
    def _register_routes(self):
        """Register API routes with blueprint."""
        
        # Authentication middleware
        @self.blueprint.before_request
        def check_auth():
            # Skip auth check if not required
            if not self.config['mobile_api_require_auth']:
                return
                
            # Get auth header
            auth_header = request.headers.get('Authorization')
            if not auth_header:
                return jsonify({'error': 'Authentication required'}), 401
                
            # Parse auth header
            try:
                auth_type, auth_token = auth_header.split(' ', 1)
                if auth_type.lower() != 'bearer':
                    return jsonify({'error': 'Invalid authentication type'}), 401
                    
                # Verify auth token
                if not self._verify_auth_token(auth_token):
                    return jsonify({'error': 'Invalid authentication token'}), 401
                    
            except Exception:
                return jsonify({'error': 'Invalid authentication header'}), 401
        
        # Rate limit middleware
        @self.blueprint.before_request
        def check_rate_limit():
            # Get client IP
            client_ip = request.remote_addr
            
            # Check rate limit
            if not self.security_manager.check_ddos_protection(client_ip):
                return jsonify({'error': 'Rate limit exceeded'}), 429
        
        # GET /status - Get node status
        @self.blueprint.route('/status', methods=['GET'])
        def get_status():
            # Get node status
            status = self._get_node_status()
            return jsonify(status)
        
        # GET /wallet/{address}/balance - Get wallet balance
        @self.blueprint.route('/wallet/<string:address>/balance', methods=['GET'])
        def get_wallet_balance(address):
            # Check address format
            if not self._validate_address(address):
                return jsonify({'error': 'Invalid address format'}), 400
                
            # Get wallet balance
            confirmed, unconfirmed = self.lightweight_node.get_balance(address)
            
            return jsonify({
                'address': address,
                'confirmed_balance': confirmed,
                'unconfirmed_balance': unconfirmed,
                'total_balance': confirmed + unconfirmed
            })
        
        # GET /wallet/{address}/transactions - Get wallet transactions
        @self.blueprint.route('/wallet/<string:address>/transactions', methods=['GET'])
        def get_wallet_transactions(address):
            # Check address format
            if not self._validate_address(address):
                return jsonify({'error': 'Invalid address format'}), 400
                
            # Parse parameters
            limit = min(int(request.args.get('limit', 50)), 100)
            
            # Get wallet transactions
            transactions = self.lightweight_node.get_transaction_history(address, limit)
            
            return jsonify({
                'address': address,
                'transactions': transactions,
                'count': len(transactions)
            })
        
        # POST /transactions - Create a new transaction
        @self.blueprint.route('/transactions', methods=['POST'])
        def create_transaction():
            # Parse request body
            try:
                data = request.get_json()
                if not data:
                    return jsonify({'error': 'Invalid JSON'}), 400
                    
                # Validate required fields
                required_fields = ['sender', 'recipient', 'amount', 'nonce', 'signature']
                for field in required_fields:
                    if field not in data:
                        return jsonify({'error': f'Missing required field: {field}'}), 400
                        
                # Validate amount
                try:
                    amount = float(data['amount'])
                    if amount <= 0:
                        return jsonify({'error': 'Amount must be positive'}), 400
                except ValueError:
                    return jsonify({'error': 'Invalid amount'}), 400
                    
                # Validate signature
                sender = data['sender']
                signature = data['signature']
                
                # Create message for signature verification (all fields except signature)
                message_data = {k: v for k, v in data.items() if k != 'signature'}
                message = json.dumps(message_data, sort_keys=True)
                
                if not self.security_manager.verify_signature(message, signature, sender):
                    return jsonify({'error': 'Invalid signature'}), 400
                    
                # Check size limit
                content_length = len(json.dumps(data))
                if content_length > self.config['max_transaction_size_kb'] * 1024:
                    return jsonify({'error': 'Transaction too large'}), 400
                    
                # Process transaction
                tx_id = self._process_transaction(data)
                if not tx_id:
                    return jsonify({'error': 'Failed to process transaction'}), 500
                    
                return jsonify({
                    'success': True,
                    'tx_id': tx_id,
                    'message': 'Transaction submitted successfully'
                })
                
            except Exception as e:
                logging.error(f"Error processing transaction: {e}")
                return jsonify({'error': 'Internal server error'}), 500
        
        # GET /transactions/{tx_id} - Get transaction status
        @self.blueprint.route('/transactions/<string:tx_id>', methods=['GET'])
        def get_transaction_status(tx_id):
            # Validate tx_id format
            if not self._validate_tx_id(tx_id):
                return jsonify({'error': 'Invalid transaction ID format'}), 400
                
            # Get transaction status
            tx_status = self._get_transaction_status(tx_id)
            if not tx_status:
                return jsonify({'error': 'Transaction not found'}), 404
                
            return jsonify(tx_status)
        
        # GET /blocks/{height} - Get block at height
        @self.blueprint.route('/blocks/<int:height>', methods=['GET'])
        def get_block(height):
            # Validate height
            if height < 0:
                return jsonify({'error': 'Invalid block height'}), 400
                
            # Get block
            block = self._get_block(height)
            if not block:
                return jsonify({'error': 'Block not found'}), 404
                
            return jsonify(block)
        
        # GET /blocks/latest - Get latest block
        @self.blueprint.route('/blocks/latest', methods=['GET'])
        def get_latest_block():
            # Get latest block
            block = self._get_latest_block()
            if not block:
                return jsonify({'error': 'No blocks available'}), 404
                
            return jsonify(block)
        
        # POST /nodes - Join as a lightweight node
        @self.blueprint.route('/nodes', methods=['POST'])
        def register_node():
            # Parse request body
            try:
                data = request.get_json()
                if not data:
                    return jsonify({'error': 'Invalid JSON'}), 400
                    
                # Validate required fields
                required_fields = ['node_id', 'public_key', 'host', 'port', 'signature']
                for field in required_fields:
                    if field not in data:
                        return jsonify({'error': f'Missing required field: {field}'}), 400
                        
                # Validate node_id format
                node_id = data['node_id']
                if not self._validate_node_id(node_id):
                    return jsonify({'error': 'Invalid node ID format'}), 400
                    
                # Validate signature
                public_key = data['public_key']
                signature = data['signature']
                
                # Create message for signature verification (all fields except signature)
                message_data = {k: v for k, v in data.items() if k != 'signature'}
                message = json.dumps(message_data, sort_keys=True)
                
                if not self.security_manager.verify_signature(message, signature, public_key):
                    return jsonify({'error': 'Invalid signature'}), 400
                    
                # Register node
                success = self._register_node(data)
                if not success:
                    return jsonify({'error': 'Failed to register node'}), 500
                    
                # Get active peers to return to the node
                peers = self._get_active_peers()
                
                return jsonify({
                    'success': True,
                    'message': 'Node registered successfully',
                    'peers': peers
                })
                
            except Exception as e:
                logging.error(f"Error registering node: {e}")
                return jsonify({'error': 'Internal server error'}), 500
        
        # GET /sync - Get sync information
        @self.blueprint.route('/sync', methods=['GET'])
        def get_sync_info():
            # Parse parameters
            start_height = int(request.args.get('start_height', 0))
            limit = min(int(request.args.get('limit', 100)), 1000)
            
            # Get sync information
            sync_info = self._get_sync_info(start_height, limit)
            
            return jsonify(sync_info)
        
        # Error handler
        @self.blueprint.errorhandler(404)
        def handle_404(e):
            return jsonify({'error': 'Endpoint not found'}), 404
            
        @self.blueprint.errorhandler(405)
        def handle_405(e):
            return jsonify({'error': 'Method not allowed'}), 405
            
        @self.blueprint.errorhandler(500)
        def handle_500(e):
            return jsonify({'error': 'Internal server error'}), 500
    
    def _get_node_status(self) -> Dict[str, Any]:
        """
        Get current node status.
        
        Returns:
            Dictionary with node status
        """
        # Get current height
        current_height = getattr(self.lightweight_node, 'current_height', 0)
        
        # Get sync status
        is_syncing = getattr(self.lightweight_node, 'sync_in_progress', False)
        
        # Get peer count
        peer_count = len(getattr(self.lightweight_node, 'peers', []))
        
        # Get blockchain info
        blockchain_info = {}
        if hasattr(self.lightweight_node, 'blockchain') and self.lightweight_node.blockchain:
            blockchain = self.lightweight_node.blockchain
            blockchain_info = {
                'blocks': len(blockchain.chain) if hasattr(blockchain, 'chain') else 0,
                'last_block_time': blockchain.chain[-1].header.timestamp if hasattr(blockchain, 'chain') and blockchain.chain else 0,
                'difficulty': getattr(blockchain, 'difficulty', 1.0)
            }
        
        return {
            'node_type': 'lightweight',
            'network': self.lightweight_node.config.get('network', 'testnet'),
            'current_height': current_height,
            'is_syncing': is_syncing,
            'peer_count': peer_count,
            'blockchain': blockchain_info,
            'timestamp': int(time.time())
        }
    
    def _validate_address(self, address: str) -> bool:
        """
        Validate an address format.
        
        Args:
            address: Address to validate
            
        Returns:
            True if valid, False otherwise
        """
        # Simple validation: must be a hex string of correct length
        return bool(re.match(r'^[0-9a-fA-F]{64}$', address))
    
    def _validate_tx_id(self, tx_id: str) -> bool:
        """
        Validate a transaction ID format.
        
        Args:
            tx_id: Transaction ID to validate
            
        Returns:
            True if valid, False otherwise
        """
        # Simple validation: must be a hex string of correct length
        return bool(re.match(r'^[0-9a-fA-F]{64}$', tx_id))
    
    def _validate_node_id(self, node_id: str) -> bool:
        """
        Validate a node ID format.
        
        Args:
            node_id: Node ID to validate
            
        Returns:
            True if valid, False otherwise
        """
        # Simple validation: must be a string with valid format
        return bool(re.match(r'^[a-zA-Z0-9._-]{3,64}$', node_id))
    
    def _verify_auth_token(self, token: str) -> bool:
        """
        Verify an authentication token.
        
        Args:
            token: Auth token to verify
            
        Returns:
            True if valid, False otherwise
        """
        # This would be implemented based on your auth system
        # Simple example: check if token is in valid tokens list
        valid_tokens = ['test_token']  # Replace with actual token validation
        return token in valid_tokens
    
    def _process_transaction(self, tx_data: Dict[str, Any]) -> Optional[str]:
        """
        Process a transaction.
        
        Args:
            tx_data: Transaction data
            
        Returns:
            Transaction ID if successful, None otherwise
        """
        try:
            # Create transaction in lightweight node
            if hasattr(self.lightweight_node, 'create_transaction'):
                recipient = tx_data['recipient']
                amount = float(tx_data['amount'])
                fee = float(tx_data.get('fee', 0.001))
                
                tx_id = self.lightweight_node.create_transaction(recipient, amount, fee)
                return tx_id
        except Exception as e:
            logging.error(f"Error creating transaction: {e}")
            
        return None
    
    def _get_transaction_status(self, tx_id: str) -> Optional[Dict[str, Any]]:
        """
        Get transaction status.
        
        Args:
            tx_id: Transaction ID
            
        Returns:
            Dictionary with transaction status or None if not found
        """
        # Check if transaction is known
        if hasattr(self.lightweight_node, 'known_transactions'):
            if tx_id in self.lightweight_node.known_transactions:
                tx_data = self.lightweight_node.known_transactions[tx_id]
                
                return {
                    'tx_id': tx_id,
                    'confirmed': tx_data.get('confirmed', False),
                    'confirmations': tx_data.get('confirmations', 0),
                    'block_height': tx_data.get('block_height'),
                    'timestamp': tx_data.get('timestamp', 0),
                    'amount': tx_data.get('amount', 0),
                    'fee': tx_data.get('fee', 0),
                    'sender': tx_data.get('sender', ''),
                    'recipient': tx_data.get('recipient', '')
                }
        
        return None
    
    def _get_block(self, height: int) -> Optional[Dict[str, Any]]:
        """
        Get block at specified height.
        
        Args:
            height: Block height
            
        Returns:
            Dictionary with block data or None if not found
        """
        # Check if block exists at height
        if hasattr(self.lightweight_node, 'block_headers'):
            if 0 <= height < len(self.lightweight_node.block_headers):
                return self.lightweight_node.block_headers[height]
        
        return None
    
    def _get_latest_block(self) -> Optional[Dict[str, Any]]:
        """
        Get latest block.
        
        Returns:
            Dictionary with block data or None if no blocks
        """
        # Get latest block
        if hasattr(self.lightweight_node, 'block_headers') and self.lightweight_node.block_headers:
            return self.lightweight_node.block_headers[-1]
        
        return None
    
    def _register_node(self, node_data: Dict[str, Any]) -> bool:
        """
        Register a node.
        
        Args:
            node_data: Node registration data
            
        Returns:
            True if successful, False otherwise
        """
        # This would be implemented based on your node registration system
        # Simple example: log the registration
        logging.info(f"Node registration: {node_data['node_id']} at {node_data['host']}:{node_data['port']}")
        return True
    
    def _get_active_peers(self) -> List[Dict[str, Any]]:
        """
        Get list of active peers.
        
        Returns:
            List of peer information
        """
        # This would be implemented based on your peer management system
        # Simple example: return some hardcoded peers
        return [
            {'address': 'peer1.example.com', 'port': 8000},
            {'address': 'peer2.example.com', 'port': 8000},
        ]
    
    def _get_sync_info(self, start_height: int, limit: int) -> Dict[str, Any]:
        """
        Get sync information for lightweight nodes.
        
        Args:
            start_height: Starting height
            limit: Maximum number of items to return
            
        Returns:
            Dictionary with sync information
        """
        # Get block headers for sync
        headers = []
        if hasattr(self.lightweight_node, 'block_headers'):
            # Get headers from start_height to start_height + limit
            end_height = min(start_height + limit, len(self.lightweight_node.block_headers))
            if start_height < end_height:
                headers = self.lightweight_node.block_headers[start_height:end_height]
        
        return {
            'latest_height': getattr(self.lightweight_node, 'current_height', 0),
            'start_height': start_height,
            'headers': headers,
            'count': len(headers)
        }

# Helper function to initialize the mobile API
def init_mobile_api(app: Flask, config=None) -> MobileAPI:
    """
    Initialize the mobile API with a Flask app.
    
    Args:
        app: Flask application instance
        config: Optional configuration
        
    Returns:
        MobileAPI instance
    """
    return MobileAPI(app, config)