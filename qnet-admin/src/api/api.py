#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: api.py
Defines the Flask endpoints for the blockchain node API with security improvements.
"""

from flask import Flask, request, jsonify, abort, make_response
import logging
import time
import json
import hashlib
import requests
from consensus import compute_proposal, ConsensusManager
from block_rewards import calculate_block_reward
import config
from functools import wraps
from collections import defaultdict
import re

# Create Flask app
app = Flask(__name__)

# Security configurations
MAX_CONTENT_LENGTH = 10 * 1024 * 1024  # 10 MB max request size
MAX_CHAIN_REQUEST_LIMIT = 100  # Maximum blocks to return in a single request
REQUEST_TIMEOUT = 10  # Default timeout for external requests in seconds

# Rate limiting configuration
RATE_LIMITS = {
    "/chain": {"calls": 120, "period": 60},          # 120 calls per minute (2 per second)
    "/new_transaction": {"calls": 300, "period": 60}, # 300 calls per minute (5 per second)
    "/sync_chain": {"calls": 60, "period": 60},      # 60 calls per minute (1 per second)
    "/state": {"calls": 180, "period": 60},          # 180 calls per minute (3 per second)
    "/get_peers": {"calls": 300, "period": 60},      # 300 calls per minute (5 per second)
    "/receive_peers": {"calls": 600, "period": 60},  # 600 calls per minute (10 per second)
    "default": {"calls": 180, "period": 60}          # 180 calls per minute (3 per second)
}

# Track request counts by IP
request_counts = defaultdict(lambda: defaultdict(lambda: {"count": 0, "reset_time": 0}))

# IP blacklist for repeated abuse
ip_blacklist = {}
ip_block_history = {}  # Track number of violations per IP
BLACKLIST_THRESHOLD = 100  # Number of violations before blacklisting
BLACKLIST_DURATION_MIN = 300  # 5 minutes minimum block duration
BLACKLIST_DURATION_MAX = 86400  # 24 hours maximum block duration
BLACKLIST_MULTIPLIER = 2  # Each subsequent block is twice as long

# Input validation patterns
PATTERNS = {
    "txhash": re.compile(r'^[0-9a-f]{64}$'),
    "address": re.compile(r'^[0-9a-zA-Z]{26,42}$'),
    "integer": re.compile(r'^[0-9]+$'),
    "float": re.compile(r'^[0-9]+(\.[0-9]+)?$')
}

# Security middleware functions
def rate_limit(func):
    """Rate limiting decorator for API endpoints"""
    @wraps(func)
    def wrapper(*args, **kwargs):
        client_ip = request.remote_addr
        endpoint = request.path
        
        # Check if IP is blacklisted
        if client_ip in ip_blacklist:
            blacklist_time = ip_blacklist[client_ip]
            if time.time() < blacklist_time:
                return jsonify({"error": "IP temporarily blocked due to abuse"}), 403
            else:
                # Remove from blacklist if time has expired
                del ip_blacklist[client_ip]
        
        # Get rate limit for this endpoint or use default
        limit = RATE_LIMITS.get(endpoint, RATE_LIMITS["default"])
        
        # Check if rate limit period has expired and reset if needed
        current_time = time.time()
        if current_time > request_counts[client_ip][endpoint]["reset_time"]:
            request_counts[client_ip][endpoint] = {
                "count": 0,
                "reset_time": current_time + limit["period"]
            }
        
        # Increment request count
        request_counts[client_ip][endpoint]["count"] += 1
        
        # Check if rate limit exceeded
        if request_counts[client_ip][endpoint]["count"] > limit["calls"]:
            # Count violations for potential blacklisting
            client_violations = request_counts[client_ip].get("violations", 0) + 1
            request_counts[client_ip]["violations"] = client_violations
            
            # Blacklist if too many violations
            if client_violations >= BLACKLIST_THRESHOLD:
                # Calculate dynamic block duration based on previous blocks
                previous_blocks = ip_block_history.get(client_ip, 0)
                block_duration = min(BLACKLIST_DURATION_MIN * (BLACKLIST_MULTIPLIER ** previous_blocks), BLACKLIST_DURATION_MAX)
                
                # Set blacklist with dynamic duration
                ip_blacklist[client_ip] = time.time() + block_duration
                
                # Update block history
                ip_block_history[client_ip] = previous_blocks + 1
                
                logging.warning(f"IP {client_ip} blacklisted for {block_duration} seconds due to excessive rate limit violations (violation count: {client_violations}, previous blocks: {previous_blocks})")
                
            return jsonify({"error": "Rate limit exceeded"}), 429
            
        # Call the actual endpoint function
        return func(*args, **kwargs)
    return wrapper

def validate_input(input_type, required=True):
    """Decorator for validating input parameters"""
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            value = request.args.get(input_type) or kwargs.get(input_type)
            
            # Check if required parameter is missing
            if required and not value:
                return jsonify({"error": f"Missing required parameter: {input_type}"}), 400
                
            # Skip validation if parameter is not present and not required
            if not value and not required:
                return func(*args, **kwargs)
                
            # Validate against pattern
            pattern = PATTERNS.get(input_type)
            if pattern and not pattern.match(str(value)):
                return jsonify({"error": f"Invalid format for {input_type}"}), 400
                
            return func(*args, **kwargs)
        return wrapper
    return decorator

def log_request(func):
    """Decorator to log API requests for audit trails"""
    @wraps(func)
    def wrapper(*args, **kwargs):
        # Log request details
        client_ip = request.remote_addr
        endpoint = request.path
        method = request.method
        user_agent = request.headers.get('User-Agent', 'Unknown')
        
        # Don't log sensitive data
        log_data = {
            "ip": client_ip,
            "endpoint": endpoint,
            "method": method, 
            "user_agent": user_agent,
            "timestamp": time.time()
        }
        
        logging.info(f"API Request: {json.dumps(log_data)}")
        
        # Time the request for performance monitoring
        start_time = time.time()
        response = func(*args, **kwargs)
        request_time = time.time() - start_time
        
        # Log response time
        logging.debug(f"API Response Time: {endpoint} - {request_time:.4f}s")
        
        return response
    return wrapper

# Apply security middleware to app
@app.before_request
def enforce_max_content_length():
    """Enforce maximum request size"""
    if request.content_length and request.content_length > MAX_CONTENT_LENGTH:
        abort(413)  # Request Entity Too Large

@app.after_request
def add_security_headers(response):
    """Add security headers to all responses"""
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['X-XSS-Protection'] = '1; mode=block'
    response.headers['Cache-Control'] = 'no-store'
    return response

@app.errorhandler(Exception)
def handle_error(e):
    """Global error handler to prevent information leakage"""
    logging.error(f"API Error: {str(e)}")
    return jsonify({"error": "Internal server error"}), 500

# SPV Endpoints
@app.route('/block_headers', methods=['GET'])
@rate_limit
@log_request
def block_headers_endpoint():
    """
    Get block headers for SPV/lightweight clients
    Optionally specify start_height and count params
    """
    try:
        start_height = request.args.get('start_height', default=0, type=int)
        count = request.args.get('count', default=0, type=int)
        
        # Validate parameters
        if start_height < 0:
            return jsonify({"error": "start_height must be non-negative"}), 400
            
        if count < 0:
            return jsonify({"error": "count must be non-negative"}), 400
            
        # Enforce maximum limit
        if count > MAX_CHAIN_REQUEST_LIMIT or count == 0:
            count = MAX_CHAIN_REQUEST_LIMIT
        
        # If count is 0, return limited number of headers
        if count == 0:
            blocks_to_return = config.blockchain.chain[start_height:start_height+MAX_CHAIN_REQUEST_LIMIT]
        else:
            blocks_to_return = config.blockchain.chain[start_height:start_height+count]
        
        headers = []
        for block in blocks_to_return:
            h = {
                "index": block.index,
                "timestamp": block.timestamp,
                "previous_hash": block.previous_hash,
                "hash": block.hash,
                "nonce": block.nonce,
                "merkle_root": block.merkle_root if hasattr(block, 'merkle_root') else ""
            }
            headers.append(h)
        return jsonify({"headers": headers, "length": len(headers)}), 200
    except Exception as e:
        logging.error(f"Error in block_headers endpoint: {e}")
        return jsonify({"error": "Failed to retrieve block headers"}), 500

@app.route('/state', methods=['GET'])
@rate_limit
@log_request
def state_endpoint():
    """Get current blockchain state (account balances)"""
    try:
        # Optional parameter to filter by address
        address = request.args.get('address')
        
        if address:
            # Validate address format
            if not PATTERNS["address"].match(address):
                return jsonify({"error": "Invalid address format"}), 400
                
            # Return only the specified address
            balance = config.balances.get(address, 0)
            return jsonify({"balances": {address: balance}, "total_issued": config.total_issued}), 200
        
        # Return full state (with pagination for large state)
        limit = min(int(request.args.get('limit', 1000)), 1000)
        offset = max(int(request.args.get('offset', 0)), 0)
        
        # Get sorted list of addresses
        addresses = sorted(config.balances.keys())
        
        # Apply pagination
        paginated_addresses = addresses[offset:offset+limit]
        
        # Build response
        balances = {addr: config.balances[addr] for addr in paginated_addresses}
        
        return jsonify({
            "balances": balances, 
            "total_issued": config.total_issued,
            "total_addresses": len(addresses),
            "offset": offset,
            "limit": limit
        }), 200
    except Exception as e:
        logging.error(f"Error in state endpoint: {e}")
        return jsonify({"error": "Failed to retrieve state"}), 500

# Full Node Endpoints
@app.route('/chain', methods=['GET'])
@rate_limit
@log_request
def chain_endpoint():
    """Get blockchain data with pagination"""
    try:
        # Parse and validate parameters
        start = max(int(request.args.get('start', 0)), 0)
        limit = min(int(request.args.get('limit', MAX_CHAIN_REQUEST_LIMIT)), MAX_CHAIN_REQUEST_LIMIT)
        
        end = start + limit
        chain_length = len(config.blockchain.chain)
        
        # Ensure we don't go out of bounds
        if start >= chain_length:
            return jsonify({"error": "Start index exceeds chain length"}), 400
            
        end = min(end, chain_length)
        
        chain_data = []
        for block in config.blockchain.chain[start:end]:
            b = {
                "index": block.index,
                "timestamp": block.timestamp,
                "transactions": block.transactions,
                "previous_hash": block.previous_hash,
                "hash": block.hash,
                "nonce": block.nonce,
                "signature": block.signature,
                "producer": block.producer,
                "pub_key": block.pub_key
            }
            chain_data.append(b)
        return jsonify({"chain": chain_data, "length": chain_length, "start": start, "limit": limit}), 200
    except Exception as e:
        logging.error(f"Error in chain endpoint: {e}")
        return jsonify({"error": "Failed to retrieve chain data"}), 500

@app.route('/new_transaction', methods=['POST'])
@rate_limit
@log_request
def new_transaction_endpoint():
    """Submit a new transaction to the network"""
    try:
        # Validate content type
        if not request.is_json:
            return jsonify({"error": "Request must be JSON"}), 400
            
        tx = request.get_json()
        
        # Validate transaction data
        required = ["sender", "recipient", "amount"]
        if not all(field in tx for field in required):
            return jsonify({"error": "Invalid transaction data: missing required fields"}), 400
            
        # Validate field types
        if not isinstance(tx["sender"], str) or not isinstance(tx["recipient"], str):
            return jsonify({"error": "Invalid transaction data: sender and recipient must be strings"}), 400
            
        try:
            # Convert amount to float for validation
            tx["amount"] = float(tx["amount"])
        except (ValueError, TypeError):
            return jsonify({"error": "Invalid transaction data: amount must be a number"}), 400
            
        # Check for negative amounts
        if tx["amount"] <= 0:
            return jsonify({"error": "Invalid transaction data: amount must be positive"}), 400
            
        # Check for reasonable amount (prevent overflow)
        if tx["amount"] > 1e12:  # 1 trillion units
            return jsonify({"error": "Invalid transaction data: amount is too large"}), 400
        
        # Add timestamp if not provided
        if "timestamp" not in tx:
            tx["timestamp"] = time.time()
        
        # Submit transaction to blockchain
        result = config.blockchain.add_transaction(tx)
        if result:
            return jsonify({"message": "Transaction added successfully"}), 201
        else:
            return jsonify({"error": "Failed to add transaction: validation failed"}), 400
    except Exception as e:
        logging.error(f"Error in new_transaction endpoint: {e}")
        return jsonify({"error": "Failed to process transaction"}), 500

@app.route('/balance', methods=['GET'])
@rate_limit
@log_request
def balance_endpoint():
    """Get balance for the current node or specified address"""
    try:
        # Check if address parameter is provided
        address = request.args.get('address')
        
        if address:
            # Validate address format
            if not PATTERNS["address"].match(address):
                return jsonify({"error": "Invalid address format"}), 400
                
            bal = config.balances.get(address, 0)
            return jsonify({"address": address, "balance": bal}), 200
        else:
            # Return own node's balance
            bal = config.balances.get(config.own_address, 0)
            return jsonify({"peer": config.own_address, "balance": bal}), 200
    except Exception as e:
        logging.error(f"Error in balance endpoint: {e}")
        return jsonify({"error": "Failed to retrieve balance"}), 500

@app.route('/propose', methods=['GET'])
@rate_limit
@log_request
def propose_endpoint():
    """Submit a proposal for consensus"""
    try:
        current_round = len(config.blockchain.chain)
        
        # Convert secret key to string if needed
        if isinstance(config.secret_key, bytes):
            secret_key_str = config.secret_key.decode('utf-8') if hasattr(config.secret_key, 'decode') else str(config.secret_key)
        else:
            secret_key_str = str(config.secret_key)
            
        proposal = compute_proposal(current_round, secret_key_str)
        
        # Ensure proposal is a string
        if not isinstance(proposal, str):
            proposal = str(proposal)
            
        config.consensus_manager.add_proposal(config.own_address, proposal, current_round)
        logging.info(f"Proposal: Node {config.own_address} proposed {proposal} for round {current_round}")
        return jsonify({"peer": config.own_address, "proposal": proposal, "round": current_round}), 200
    except Exception as e:
        logging.error(f"Error in /propose endpoint: {e}")
        return jsonify({"error": "Failed to generate proposal"}), 500

@app.route('/sync_chain', methods=['GET'])
@rate_limit
@log_request
def sync_chain_endpoint():
    """Synchronize the blockchain with peers"""
    try:
        longest = config.blockchain.chain
        local_length = len(config.blockchain.chain)
        conflicting_blocks = []
        
        # Make a safe copy of peers to iterate
        peers_to_check = list(config.peers.keys())
        
        for peer in peers_to_check:
            try:
                # Use a reasonable timeout
                response = requests.get(f"http://{peer}/chain", timeout=REQUEST_TIMEOUT)
                if response.status_code == 200:
                    data = response.json()
                    peer_chain = data.get("chain", [])
                    
                    # Validate response structure
                    if not isinstance(peer_chain, list):
                        logging.warning(f"Invalid chain data from peer {peer}")
                        continue
                    
                    if len(peer_chain) > local_length:
                        # Check for conflicting blocks
                        for i, b in enumerate(peer_chain):
                            if i < len(config.blockchain.chain):
                                local_block = config.blockchain.chain[i]
                                if local_block.hash != b['hash'] and local_block.index == b['index']:
                                    conflicting_blocks.append({
                                        'height': i,
                                        'local_hash': local_block.hash,
                                        'peer_hash': b['hash'],
                                        'peer': peer
                                    })
                                    logging.warning(f"Conflicting block detected at height {i}")
                        
                        # Convert and verify chain
                        new_chain = []
                        from blockchain import Block
                        
                        for b in peer_chain:
                            # Validate block data
                            required_fields = ["index", "timestamp", "transactions", "previous_hash", "hash", "nonce"]
                            if not all(field in b for field in required_fields):
                                logging.warning(f"Invalid block data from peer {peer}")
                                chain_valid = False
                                break
                                
                            nb = Block(b['index'], b['timestamp'], b['transactions'], b['previous_hash'], b['nonce'])
                            nb.hash = b['hash']
                            nb.signature = b.get("signature")
                            nb.producer = b.get("producer")
                            nb.pub_key = b.get("pub_key")
                            new_chain.append(nb)
                        
                        # Verify chain integrity
                        chain_valid = True
                        for i in range(1, len(new_chain)):
                            if new_chain[i].previous_hash != new_chain[i-1].hash:
                                chain_valid = False
                                logging.error(f"Invalid chain from {peer}: previous_hash mismatch at block {i}")
                                break
                                
                            # Verify block signature if available
                            if new_chain[i].signature and new_chain[i].pub_key and hasattr(new_chain[i], 'verify_block_signature'):
                                if not new_chain[i].verify_block_signature():
                                    chain_valid = False
                                    logging.error(f"Invalid signature for block {i} from {peer}")
                                    break
                        
                        if chain_valid:
                            longest = new_chain
                            local_length = len(new_chain)
            except requests.exceptions.RequestException as e:
                logging.warning(f"Error connecting to peer {peer}: {e}")
            except Exception as e:
                logging.error(f"Error syncing from {peer}: {e}")
        
        if len(longest) > len(config.blockchain.chain):
            with config.consensus_manager.lock:
                if conflicting_blocks:
                    logging.warning(f"Adopting longer chain despite {len(conflicting_blocks)} conflicting blocks")
                    
                    # Log conflicts for analysis
                    try:
                        with open('conflict_log.json', 'a') as f:
                            json.dump({
                                'timestamp': time.time(),
                                'local_node': config.own_address,
                                'conflicts': conflicting_blocks
                            }, f)
                            f.write('\n')
                    except Exception as e:
                        logging.error(f"Failed to log conflict: {e}")
                
                config.blockchain.chain = longest
            
            state, total = config.blockchain.compute_state()
            config.balances = state
            config.total_issued = total
            return jsonify({"message": "Chain updated", "new_length": len(config.blockchain.chain), 
                           "conflicts_detected": len(conflicting_blocks)}), 200
        else:
            return jsonify({"message": "Our chain is up-to-date", "length": len(config.blockchain.chain)}), 200
    except Exception as e:
        logging.error(f"Error in sync_chain endpoint: {e}")
        return jsonify({"error": "Failed to sync chain"}), 500

@app.route('/sync_state', methods=['GET'])
@rate_limit
@log_request
def sync_state_endpoint():
    """Synchronize the blockchain state"""
    try:
        state, total = config.blockchain.compute_state()
        config.balances = state
        config.total_issued = total
        return jsonify({"balances": state, "total_issued": total}), 200
    except Exception as e:
        logging.error(f"Error in sync_state endpoint: {e}")
        return jsonify({"error": "Failed to sync state"}), 500

@app.route('/get_peers', methods=['GET'])
@rate_limit
@log_request
def get_peers_endpoint():
    """Get list of known peers"""
    try:
        current = time.time()
        
        # Create a safe copy with only necessary information
        peer_info = {}
        for peer, ts in config.peers.items():
            # Calculate time since last seen
            last_seen = current - ts
            
            # Only include peers seen in the last day
            if last_seen < 86400:  # 24 hours
                peer_info[peer] = last_seen
                
        logging.info(f"Peers request: returning {len(peer_info)} active peers")
        return jsonify({"peers": peer_info}), 200
    except Exception as e:
        logging.error(f"Error in get_peers endpoint: {e}")
        return jsonify({"error": "Failed to retrieve peers"}), 500

@app.route('/add_peer', methods=['POST'])
@rate_limit
@log_request
def add_peer_endpoint():
    """Add a new peer to the network"""
    try:
        # Validate content type
        if not request.is_json:
            return jsonify({"error": "Request must be JSON"}), 400
            
        data = request.get_json()
        
        # Validate peer_url
        peer_addr = data.get("peer_url")
        if not peer_addr:
            return jsonify({"error": "peer_url is required"}), 400
            
        # Basic URL validation
        if not re.match(r'^[a-zA-Z0-9\.\-:]+$', peer_addr):
            return jsonify({"error": "Invalid peer URL format"}), 400
            
        # Don't allow adding self as peer
        if peer_addr == config.own_address:
            return jsonify({"error": "Cannot add self as peer"}), 400
            
        # Add peer if not already known
        if peer_addr not in config.peers:
            # Validate peer by attempting connection
            try:
                response = requests.head(f"http://{peer_addr}/", timeout=REQUEST_TIMEOUT)
                if response.status_code < 200 or response.status_code >= 400:
                    return jsonify({"error": "Peer is not responding"}), 400
            except requests.exceptions.RequestException:
                return jsonify({"error": "Could not connect to peer"}), 400
                
            config.peers[peer_addr] = time.time()
            config.reputation[peer_addr] = 1.0
            logging.info(f"Peer added: {peer_addr}")
        
        return jsonify({"message": "Peer added", "peers": list(config.peers.keys())}), 201
    except Exception as e:
        logging.error(f"Error in /add_peer endpoint: {e}")
        return jsonify({"error": "Failed to add peer"}), 500

@app.route('/receive_peers', methods=['GET', 'POST'])
@rate_limit
@log_request
def receive_peers_endpoint():
    """Receive peer information from other nodes"""
    if request.method == 'POST':
        try:
            # Validate content type
            if not request.is_json:
                return jsonify({"error": "Request must be JSON"}), 400
                
            data = request.get_json()
            
            # Validate parameters
            incoming = data.get("peers", [])
            sender_address = data.get("peer_address")
            sender_node_id = data.get("node_id")
            msg_ts = data.get("timestamp", 0)
            
            # Reject old messages
            if time.time() - msg_ts > 60:
                logging.warning("Outdated gossip message received.")
                return jsonify({"error": "Outdated gossip message"}), 400
                
            # Validate peer list
            if not isinstance(incoming, list) and not isinstance(incoming, dict):
                return jsonify({"error": "peers must be list or dict"}), 400
                
            # Process peer list
            peers_added = 0
            peers_list = incoming.keys() if isinstance(incoming, dict) else incoming
            
            for peer in peers_list:
                # Basic validation of peer format
                if not isinstance(peer, str) or not re.match(r'^[a-zA-Z0-9\.\-:]+$', peer):
                    continue
                    
                # Don't add self
                if peer == config.own_address:
                    continue
                    
                # Add new peer
                if peer not in config.peers:
                    config.peers[peer] = time.time()
                    config.reputation[peer] = 1.0
                    peers_added += 1
                    
            # Update node info if provided
            if sender_address and sender_node_id:
                # Validate node_id format
                if isinstance(sender_node_id, str) and sender_node_id.startswith("did:qnet:"):
                    config.node_info[sender_address] = sender_node_id
                    
            logging.info(f"Received {len(peers_list)} peers from {sender_address}, added {peers_added} new peers")
            return jsonify({"message": "Peers received", "added": peers_added}), 200
        except Exception as e:
            logging.error(f"Error in /receive_peers endpoint: {e}")
            return jsonify({"error": "Failed to process peers"}), 500
    else:
        return jsonify({"message": "Please use POST to submit peers."}), 200

# Developer API Endpoints
@app.route('/api/v1/block/<int:height>', methods=['GET'])
@rate_limit
@log_request
@validate_input("height")
def api_block_endpoint(height):
    """Get block by height (API for developers)"""
    try:
        # Validate height
        if height < 0:
            return jsonify({"error": "Block height must be non-negative"}), 400
            
        block = config.blockchain.get_block_by_index(height)
        if not block:
            return jsonify({"error": "Block not found"}), 404
            
        # Convert block to dict
        block_data = block.to_dict()
        
        # Add extra info
        if height > 0:
            block_data["previous_block_url"] = f"/api/v1/block/{height-1}"
        block_data["next_block_url"] = f"/api/v1/block/{height+1}"
        
        # Add Merkle root if not present
        if "merkle_root" not in block_data:
            # Compute Merkle root from transactions
            from crypto_bindings import compute_merkle_root
            tx_hashes = []
            for tx in block.transactions:
                tx_json = json.dumps(tx, sort_keys=True).encode()
                tx_hash = hashlib.sha256(tx_json).hexdigest()
                tx_hashes.append(tx_hash)
                
            block_data["merkle_root"] = compute_merkle_root(tx_hashes) if tx_hashes else hashlib.sha256(b"").hexdigest()
        
        return jsonify(block_data), 200
    except Exception as e:
        logging.error(f"Error in api_block_endpoint: {e}")
        return jsonify({"error": "Failed to retrieve block"}), 500

@app.route('/api/v1/transaction/<tx_hash>', methods=['GET'])
@rate_limit
@log_request
@validate_input("txhash")
def api_transaction_endpoint(tx_hash):
    """Get transaction by hash (API for developers)"""
    try:
        # Validate transaction hash format
        if not PATTERNS["txhash"].match(tx_hash):
            return jsonify({"error": "Invalid transaction hash format"}), 400
            
        # Search for transaction in all blocks
        for block in config.blockchain.chain:
            for idx, tx in enumerate(block.transactions):
                # Compute transaction hash
                tx_json = json.dumps(tx, sort_keys=True).encode()
                computed_hash = hashlib.sha256(tx_json).hexdigest()
                
                if computed_hash == tx_hash:
                    # Add block info to transaction
                    tx_data = tx.copy()
                    tx_data["hash"] = computed_hash
                    tx_data["block_height"] = block.index
                    tx_data["block_hash"] = block.hash
                    tx_data["timestamp"] = block.timestamp
                    tx_data["confirmation_status"] = "confirmed"
                    tx_data["transaction_index"] = idx
                    
                    return jsonify(tx_data), 200
                    
        # Check if transaction is pending
        for idx, tx in enumerate(config.blockchain.transaction_pool):
            tx_json = json.dumps(tx, sort_keys=True).encode()
            computed_hash = hashlib.sha256(tx_json).hexdigest()
            
            if computed_hash == tx_hash:
                tx_data = tx.copy()
                tx_data["hash"] = computed_hash
                tx_data["confirmation_status"] = "pending"
                return jsonify(tx_data), 200
        
        return jsonify({"error": "Transaction not found"}), 404
    except Exception as e:
        logging.error(f"Error in api_transaction_endpoint: {e}")
        return jsonify({"error": "Failed to retrieve transaction"}), 500

@app.route('/api/v1/address/<address>/balance', methods=['GET'])
@rate_limit
@log_request
@validate_input("address")
def api_address_balance_endpoint(address):
    """Get address balance (API for developers)"""
    try:
        # Validate address format
        if not PATTERNS["address"].match(address):
            return jsonify({"error": "Invalid address format"}), 400
            
        balance = config.balances.get(address, 0)
        return jsonify({"address": address, "balance": balance}), 200
    except Exception as e:
        logging.error(f"Error in api_address_balance_endpoint: {e}")
        return jsonify({"error": "Failed to retrieve address balance"}), 500

@app.route('/api/v1/address/<address>/transactions', methods=['GET'])
@rate_limit
@log_request
@validate_input("address")
def api_address_transactions_endpoint(address):
    """Get transactions for an address (API for developers)"""
    try:
        # Validate address format
        if not PATTERNS["address"].match(address):
            return jsonify({"error": "Invalid address format"}), 400
            
        # Parse and validate pagination parameters
        limit = min(int(request.args.get('limit', 50)), 100)  # Max 100 tx per request
        offset = max(int(request.args.get('offset', 0)), 0)
        
        transactions = []
        
        # Search for transactions involving this address
        for block in config.blockchain.chain:
            block_height = block.index
            
            for tx in block.transactions:
                if tx.get("sender") == address or tx.get("recipient") == address:
                    # Compute transaction hash
                    tx_json = json.dumps(tx, sort_keys=True).encode()
                    tx_hash = hashlib.sha256(tx_json).hexdigest()
                    
                    # Add to transactions list
                    transactions.append({
                        "hash": tx_hash,
                        "sender": tx.get("sender"),
                        "recipient": tx.get("recipient"),
                        "amount": tx.get("amount", 0),
                        "block_height": block_height,
                        "timestamp": block.timestamp,
                        "type": "receive" if tx.get("recipient") == address else "send"
                    })
        
        # Sort by timestamp (newest first)
        transactions.sort(key=lambda x: x["timestamp"], reverse=True)
        
        # Apply pagination
        paginated = transactions[offset:offset+limit]
        
        return jsonify({
            "address": address,
            "transactions": paginated,
            "total": len(transactions),
            "offset": offset,
            "limit": limit
        }), 200
    except Exception as e:
        logging.error(f"Error in api_address_transactions_endpoint: {e}")
        return jsonify({"error": "Failed to retrieve address transactions"}), 500

@app.route('/api/v1/stats', methods=['GET'])
@rate_limit
@log_request
def api_stats_endpoint():
    """Get blockchain statistics (API for developers)"""
    try:
        # Calculate statistics
        block_count = len(config.blockchain.chain)
        
        # Calculate total transactions
        tx_count = 0
        for block in config.blockchain.chain:
            tx_count += len(block.transactions)
        
        # Calculate average block time (for last 100 blocks)
        avg_block_time = 0
        if block_count > 1:
            blocks_to_analyze = min(100, block_count - 1)
            total_time = 0
            for i in range(block_count - blocks_to_analyze, block_count):
                if i > 0:
                    time_diff = config.blockchain.chain[i].timestamp - config.blockchain.chain[i-1].timestamp
                    total_time += time_diff
            avg_block_time = total_time / blocks_to_analyze if blocks_to_analyze > 0 else 0
        
        stats = {
            "block_count": block_count,
            "transaction_count": tx_count,
            "average_block_time": avg_block_time,
            "current_reward": calculate_block_reward(block_count),
            "total_supply": config.total_issued,
            "pending_transactions": len(config.blockchain.transaction_pool),
            "peer_count": len(config.peers),
            "timestamp": time.time()
        }
        
        return jsonify(stats), 200
    except Exception as e:
        logging.error(f"Error in api_stats_endpoint: {e}")
        return jsonify({"error": "Failed to retrieve blockchain statistics"}), 500

@app.route('/api/v1/submit_transaction', methods=['POST'])
@rate_limit
@log_request
def api_submit_transaction_endpoint():
    """Submit a transaction (API for developers)"""
    try:
        # Validate content type
        if not request.is_json:
            return jsonify({"error": "Request must be JSON"}), 400
            
        tx_data = request.get_json()
        
        # Validate transaction
        required = ["sender", "recipient", "amount", "signature", "pub_key"]
        if not all(field in tx_data for field in required):
            return jsonify({"error": "Missing required fields"}), 400
        
        # Validate field types
        if not isinstance(tx_data["sender"], str) or not isinstance(tx_data["recipient"], str):
            return jsonify({"error": "Invalid transaction data: sender and recipient must be strings"}), 400
            
        try:
            # Convert amount to float for validation
            tx_data["amount"] = float(tx_data["amount"])
        except (ValueError, TypeError):
            return jsonify({"error": "Invalid transaction data: amount must be a number"}), 400
            
        # Check for negative amounts
        if tx_data["amount"] <= 0:
            return jsonify({"error": "Invalid transaction data: amount must be positive"}), 400
            
        # Check for reasonable amount (prevent overflow)
        if tx_data["amount"] > 1e12:  # 1 trillion units
            return jsonify({"error": "Invalid transaction data: amount is too large"}), 400
        
        # Add transaction to pool
        tx = {
            "sender": tx_data["sender"],
            "recipient": tx_data["recipient"],
            "amount": tx_data["amount"],
            "signature": tx_data["signature"],
            "pub_key": tx_data["pub_key"],
            "timestamp": tx_data.get("timestamp", time.time())
        }
        
        result = config.blockchain.add_transaction(tx)
        if result:
            # Compute transaction hash
            tx_json = json.dumps(tx, sort_keys=True).encode()
            tx_hash = hashlib.sha256(tx_json).hexdigest()
            
            return jsonify({
                "success": True,
                "message": "Transaction submitted successfully",
                "transaction_hash": tx_hash
            }), 201
        else:
            return jsonify({
                "success": False,
                "message": "Failed to add transaction: validation failed"
            }), 400
    except Exception as e:
        logging.error(f"Error in api_submit_transaction_endpoint: {e}")
        return jsonify({"error": "Failed to submit transaction"}), 500

@app.route("/")
@rate_limit
@log_request
def root_endpoint():
    """Root endpoint that returns basic info"""
    try:
        info = {
            "name": "QNet Blockchain Node",
            "version": "1.0.0",
            "endpoints": ["/chain", "/state", "/get_peers", "/balance"],
            "node_address": config.own_address,
            "current_height": len(config.blockchain.chain) - 1,
            "api_docs": "/api/v1/docs"
        }
        return jsonify(info), 200
    except Exception as e:
        logging.error(f"Error in root endpoint: {e}")
        return jsonify({"error": "Internal server error"}), 500

@app.route("/api/v1/docs")
@rate_limit
@log_request
def api_docs_endpoint():
    """API documentation endpoint"""
    try:
        docs = {
            "api_version": "1.0",
            "endpoints": [
                {
                    "path": "/api/v1/block/{height}",
                    "method": "GET",
                    "description": "Get block by height",
                    "parameters": [
                        {"name": "height", "type": "integer", "required": True, "description": "Block height"}
                    ]
                },
                {
                    "path": "/api/v1/transaction/{tx_hash}",
                    "method": "GET",
                    "description": "Get transaction by hash",
                    "parameters": [
                        {"name": "tx_hash", "type": "string", "required": True, "description": "Transaction hash (64 hex chars)"}
                    ]
                },
                {
                    "path": "/api/v1/address/{address}/balance",
                    "method": "GET",
                    "description": "Get address balance",
                    "parameters": [
                        {"name": "address", "type": "string", "required": True, "description": "Blockchain address"}
                    ]
                },
                {
                    "path": "/api/v1/address/{address}/transactions",
                    "method": "GET",
                    "description": "Get transactions for an address",
                    "parameters": [
                        {"name": "address", "type": "string", "required": True, "description": "Blockchain address"},
                        {"name": "limit", "type": "integer", "required": False, "description": "Max transactions to return (default 50, max 100)"},
                        {"name": "offset", "type": "integer", "required": False, "description": "Pagination offset (default 0)"}
                    ]
                },
                {
                    "path": "/api/v1/stats",
                    "method": "GET",
                    "description": "Get blockchain statistics",
                    "parameters": []
                },
                {
                    "path": "/api/v1/submit_transaction",
                    "method": "POST",
                    "description": "Submit a new transaction",
                    "parameters": [
                        {"name": "sender", "type": "string", "required": True, "description": "Sender address"},
                        {"name": "recipient", "type": "string", "required": True, "description": "Recipient address"},
                        {"name": "amount", "type": "number", "required": True, "description": "Transaction amount"},
                        {"name": "signature", "type": "string", "required": True, "description": "Transaction signature"},
                        {"name": "pub_key", "type": "string", "required": True, "description": "Sender's public key"},
                        {"name": "timestamp", "type": "number", "required": False, "description": "Transaction timestamp (default: current time)"}
                    ]
                }
            ],
            "rate_limits": {
                "default": "30 requests per minute",
                "/chain": "10 requests per minute",
                "/new_transaction": "20 requests per minute",
                "/sync_chain": "5 requests per minute"
            },
            "errors": {
                "400": "Bad Request - Invalid parameters",
                "403": "Forbidden - IP blacklisted",
                "404": "Not Found - Resource doesn't exist",
                "429": "Too Many Requests - Rate limit exceeded",
                "500": "Internal Server Error"
            }
        }
        return jsonify(docs), 200
    except Exception as e:
        logging.error(f"Error in api_docs_endpoint: {e}")
        return jsonify({"error": "Failed to retrieve API documentation"}), 500

# Register crypto API endpoints
@app.route('/api/v1/debug', methods=['GET'])
@rate_limit
@log_request
def debug_consensus_endpoint():
    """Debug endpoint to check consensus state"""
    try:
        # Get current round and consensus state
        current_round = len(config.blockchain.chain)
        commits = config.consensus_manager.commits.get(current_round, {})
        reveals = config.consensus_manager.reveals.get(current_round, {})
        
        # Log detailed information
        logging.info(f"DEBUG-CONSENSUS: Current round = {current_round}")
        logging.info(f"DEBUG-CONSENSUS: Own address = {config.own_address}")
        logging.info(f"DEBUG-CONSENSUS: Eligible nodes = {config.eligible_nodes}")
        logging.info(f"DEBUG-CONSENSUS: Node info = {config.node_info}")
        logging.info(f"DEBUG-CONSENSUS: Commits for round {current_round} = {commits}")
        logging.info(f"DEBUG-CONSENSUS: Reveals for round {current_round} = {reveals}")
        
        # Check valid reveals based on commit-reveal verification
        valid_reveals = {}
        for addr, proposal in reveals.items():
            # Check if address is eligible
            if addr not in config.eligible_nodes:
                logging.info(f"DEBUG-CONSENSUS: Node {addr} not in eligible nodes")
                continue
            
            # Check if commit matches reveal
            expected_commit = hashlib.sha256(proposal.encode()).hexdigest()
            if addr in commits and commits[addr] == expected_commit:
                valid_reveals[addr] = proposal
                logging.info(f"DEBUG-CONSENSUS: Valid reveal from {addr}")
            else:
                logging.info(f"DEBUG-CONSENSUS: Invalid reveal from {addr}, commit mismatch")
        
        # Check minimum reveals
        min_reveals = max(2, len(config.eligible_nodes) // 3)
        logging.info(f"DEBUG-CONSENSUS: Min reveals required = {min_reveals}, actual valid reveals = {len(valid_reveals)}")
        
        return jsonify({
            "current_round": current_round,
            "eligible_nodes": config.eligible_nodes,
            "node_info": config.node_info,
            "commits": commits,
            "reveals": reveals,
            "valid_reveals": valid_reveals,
            "min_reveals_required": min_reveals
        }), 200
    except Exception as e:
        logging.error(f"Error in Debug Consensus endpoint: {e}")
        return jsonify({"error": "Internal server error"}), 500


@app.route('/api/v1/consensus/broadcast_commit', methods=['POST'])
@rate_limit
@log_request
def broadcast_commit_endpoint():
    """Receive commit value from another node"""
    try:
        # Validate content type
        if not request.is_json:
            return jsonify({"error": "Request must be JSON"}), 400
            
        data = request.get_json()
        
        # Validate data
        required = ["round", "node_address", "commit_value"]
        if not all(k in data for k in required):
            return jsonify({"error": "Missing required fields"}), 400
        
        round_number = data["round"]
        node_address = data["node_address"]
        commit_value = data["commit_value"]
        
        # Add commit to consensus manager
        config.consensus_manager.add_commit(round_number, node_address, commit_value)
        
        return jsonify({
            "success": True,
            "message": f"Commit received from {node_address} for round {round_number}"
        }), 200
    except Exception as e:
        logging.error(f"Error in broadcast_commit endpoint: {e}")
        return jsonify({"error": "Internal server error"}), 500

@app.route('/api/v1/consensus/broadcast_reveal', methods=['POST'])
@rate_limit
@log_request
def broadcast_reveal_endpoint():
    """Receive reveal value from another node"""
    try:
        # Validate content type
        if not request.is_json:
            return jsonify({"error": "Request must be JSON"}), 400
            
        data = request.get_json()
        
        # Validate data
        required = ["round", "node_address", "reveal_value"]
        if not all(k in data for k in required):
            return jsonify({"error": "Missing required fields"}), 400
        
        round_number = data["round"]
        node_address = data["node_address"]
        reveal_value = data["reveal_value"]
        
        # Add reveal to consensus manager
        config.consensus_manager.add_reveal(round_number, node_address, reveal_value)
        
        return jsonify({
            "success": True,
            "message": f"Reveal received from {node_address} for round {round_number}"
        }), 200
    except Exception as e:
        logging.error(f"Error in broadcast_reveal endpoint: {e}")
        return jsonify({"error": "Internal server error"}), 500