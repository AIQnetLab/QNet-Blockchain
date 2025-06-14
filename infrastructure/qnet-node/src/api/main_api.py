# File: QNet-Project/qnet-node/src/api/main_api.py
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: main_api.py
Blueprint for core QNet node API endpoints (chain, transactions, peers, etc.).
"""
from flask import Blueprint, jsonify, request
import logging

main_bp = Blueprint('main_api', __name__)

@main_bp.route('/status', methods=['GET'])
def get_status():
    """Get comprehensive node status."""
    try:
        # Import node instance
        from ..node.node import get_node_instance
        node = get_node_instance()
        
        if node:
            status = node.get_node_status()
            return jsonify({
                "status": "active",
                "node_id": status.get("node_id", "unknown"),
                "node_type": status.get("node_type", "full"),
                "address": status.get("address", "unknown"),
                "blockchain_height": status.get("height", 0),
                "peers_count": len(status.get("peers", [])),
                "is_mining": status.get("is_mining", False),
                "uptime_seconds": status.get("uptime", 0),
                "performance": {
                    "current_tps": status.get("current_tps", 0),
                    "peak_tps": status.get("peak_tps", 0),
                    "mempool_size": status.get("mempool_size", 0)
                },
                "region": {
                    "name": status.get("region", "unknown"),
                    "regional_sharding": status.get("regional_sharding", False)
                }
            })
        else:
            return jsonify({
                "status": "offline",
                "error": "Node instance not available"
            }), 503
    except ImportError:
        # Fallback status when node not available
        return jsonify({
            "status": "initializing", 
            "message": "Node starting up",
            "node_id": "temp_node_001",
            "node_type": "full",
            "blockchain_height": 0,
            "peers_count": 0,
            "is_mining": False
        })

@main_bp.route('/chain', methods=['GET'])
def get_chain():
    """Get blockchain data with pagination."""
    start = request.args.get('start', 0, type=int)
    limit = request.args.get('limit', 100, type=int)
    
    try:
        from ..node.node import get_node_instance
        node = get_node_instance()
        
        if node:
            chain_data = node.get_blockchain_data(start, limit)
            return jsonify({
                "chain": chain_data.get("blocks", []),
                "length": chain_data.get("total_length", 0),
                "start": start,
                "limit": limit,
                "status": "success"
            })
        else:
            return jsonify({
                "chain": [],
                "length": 0,
                "start": start,
                "limit": limit,
                "error": "Node not available"
            }), 503
    except ImportError:
        # Return empty chain when node not available
        return jsonify({
            "chain": [],
            "length": 0,
            "start": start,
            "limit": limit,
            "message": "Node initializing"
        })

@main_bp.route('/transactions', methods=['POST'])
def submit_transaction():
    """Submit a transaction to the network."""
    try:
        data = request.get_json()
        
        if not data:
            return jsonify({"error": "No transaction data provided"}), 400
            
        # Validate required fields
        required_fields = ['from', 'to', 'amount', 'signature']
        for field in required_fields:
            if field not in data:
                return jsonify({"error": f"Missing required field: {field}"}), 400
        
        from ..node.node import get_node_instance
        node = get_node_instance()
        
        if node:
            # Submit transaction to mempool
            result = node.submit_transaction(data)
            
            if result.get("success"):
                return jsonify({
                    "status": "success",
                    "message": "Transaction submitted successfully",
                    "tx_hash": result.get("tx_hash"),
                    "tx_id": result.get("tx_id")
                }), 201
            else:
                return jsonify({
                    "status": "error",
                    "error": result.get("error", "Transaction validation failed")
                }), 400
        else:
            return jsonify({
                "status": "error",
                "error": "Node not available"
            }), 503
            
    except Exception as e:
        logging.error(f"Transaction submission error: {e}")
        return jsonify({
            "status": "error",
            "error": "Internal server error"
        }), 500

@main_bp.route('/peers', methods=['GET'])
def get_peers():
    """Get connected peers information."""
    try:
        from ..node.node import get_node_instance
        node = get_node_instance()
        
        if node:
            peers_data = node.get_peers_info()
            
            peers = []
            for peer in peers_data:
                peers.append({
                    "id": peer.get("node_id", "unknown"),
                    "address": peer.get("address", "unknown"),
                    "port": peer.get("port", 0),
                    "region": peer.get("region", "unknown"),
                    "node_type": peer.get("node_type", "unknown"),
                    "last_seen": peer.get("last_seen", 0),
                    "latency_ms": peer.get("latency", 0)
                })
            
            return jsonify({
                "peers": peers,
                "total_count": len(peers),
                "status": "success"
            })
        else:
            return jsonify({
                "peers": [],
                "total_count": 0,
                "error": "Node not available"
            }), 503
            
    except ImportError:
        return jsonify({
            "peers": [],
            "total_count": 0,
            "message": "Node initializing"
        })

@main_bp.route('/mempool', methods=['GET'])
def get_mempool():
    """Get mempool information."""
    try:
        from ..node.node import get_node_instance
        node = get_node_instance()
        
        if node:
            mempool_data = node.get_mempool_info()
            
            return jsonify({
                "pending_transactions": mempool_data.get("count", 0),
                "mempool_size": mempool_data.get("size_bytes", 0),
                "oldest_transaction": mempool_data.get("oldest_tx_time", 0),
                "fee_stats": {
                    "min_fee": mempool_data.get("min_fee", 0),
                    "max_fee": mempool_data.get("max_fee", 0),
                    "avg_fee": mempool_data.get("avg_fee", 0)
                },
                "status": "success"
            })
        else:
            return jsonify({
                "pending_transactions": 0,
                "mempool_size": 0,
                "error": "Node not available"
            }), 503
            
    except Exception as e:
        logging.error(f"Mempool info error: {e}")
        return jsonify({
            "pending_transactions": 0,
            "mempool_size": 0,
            "error": "Failed to get mempool info"
        }), 500

@main_bp.route('/block/<block_hash>', methods=['GET'])
def get_block(block_hash):
    """Get specific block by hash."""
    try:
        from ..node.node import get_node_instance
        node = get_node_instance()
        
        if node:
            block_data = node.get_block_by_hash(block_hash)
            
            if block_data:
                return jsonify({
                    "block": block_data,
                    "status": "success"
                })
            else:
                return jsonify({
                    "error": "Block not found"
                }), 404
        else:
            return jsonify({
                "error": "Node not available"
            }), 503
            
    except Exception as e:
        logging.error(f"Block retrieval error: {e}")
        return jsonify({
            "error": "Failed to retrieve block"
        }), 500

@main_bp.route('/transaction/<tx_hash>', methods=['GET'])
def get_transaction(tx_hash):
    """Get specific transaction by hash."""
    try:
        from ..node.node import get_node_instance
        node = get_node_instance()
        
        if node:
            tx_data = node.get_transaction_by_hash(tx_hash)
            
            if tx_data:
                return jsonify({
                    "transaction": tx_data,
                    "status": "success"
                })
            else:
                return jsonify({
                    "error": "Transaction not found"
                }), 404
        else:
            return jsonify({
                "error": "Node not available"
            }), 503
            
    except Exception as e:
        logging.error(f"Transaction retrieval error: {e}")
        return jsonify({
            "error": "Failed to retrieve transaction"
        }), 500

@main_bp.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint."""
    return jsonify({
        "status": "healthy",
        "timestamp": int(__import__('time').time()),
        "version": "1.0.0"
    })

# Add error handlers
@main_bp.errorhandler(404)
def not_found(error):
    return jsonify({"error": "Endpoint not found"}), 404

@main_bp.errorhandler(500)
def internal_error(error):
    return jsonify({"error": "Internal server error"}), 500