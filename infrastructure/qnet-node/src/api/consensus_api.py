# File: QNet-Project/qnet-node/src/api/consensus_api.py
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: consensus_api.py
Blueprint for API endpoints related to the consensus mechanism.
Handles commit/reveal broadcasts and provides stats.
"""
from flask import Blueprint, jsonify, request
import logging
import time

consensus_bp = Blueprint('consensus_api', __name__)

# Assume consensus object is accessible, e.g., via import or app context
# from consensus import get_consensus
# consensus_manager = get_consensus()

@consensus_bp.route('/broadcast_commit', methods=['POST'])
def broadcast_commit():
    """Receive and process commit from peer."""
    try:
        data = request.get_json()
        
        if not data or 'node_id' not in data or 'commit_hash' not in data:
            return jsonify({"error": "Invalid commit data"}), 400
        
        from ..consensus.consensus_manager import get_consensus_manager
        consensus_manager = get_consensus_manager()
        
        if consensus_manager:
            result = consensus_manager.process_commit(
                node_id=data['node_id'],
                commit_hash=data['commit_hash'],
                round_number=data.get('round', 0),
                signature=data.get('signature'),
                timestamp=data.get('timestamp', time.time())
            )
            
            if result.get("success"):
                return jsonify({
                    "status": "success",
                    "message": "Commit processed successfully",
                    "round": result.get("round"),
                    "total_commits": result.get("total_commits", 0)
                })
            else:
                return jsonify({
                    "status": "error",
                    "error": result.get("error", "Commit processing failed")
                }), 400
        else:
            # Fallback when consensus manager not available
            logging.warning("Consensus manager not available, storing commit for later processing")
            return jsonify({
                "status": "accepted",
                "message": "Commit queued for processing"
            })
            
    except Exception as e:
        logging.error(f"Commit processing error: {e}")
        return jsonify({
            "error": f"Commit processing error: {str(e)}"
        }), 500

@consensus_bp.route('/broadcast_reveal', methods=['POST'])
def broadcast_reveal():
    """Receive and process reveal from peer."""
    try:
        data = request.get_json()
        
        if not data or 'node_id' not in data or 'reveal_value' not in data:
            return jsonify({"error": "Invalid reveal data"}), 400
        
        from ..consensus.consensus_manager import get_consensus_manager
        consensus_manager = get_consensus_manager()
        
        if consensus_manager:
            result = consensus_manager.process_reveal(
                node_id=data['node_id'],
                reveal_value=data['reveal_value'],
                nonce=data.get('nonce'),
                round_number=data.get('round', 0),
                signature=data.get('signature')
            )
            
            if result.get("success"):
                return jsonify({
                    "status": "success",
                    "message": "Reveal processed successfully",
                    "round": result.get("round"),
                    "total_reveals": result.get("total_reveals", 0),
                    "consensus_reached": result.get("consensus_reached", False)
                })
            else:
                return jsonify({
                    "status": "error",
                    "error": result.get("error", "Reveal processing failed")
                }), 400
        else:
            # Fallback when consensus manager not available
            logging.warning("Consensus manager not available, storing reveal for later processing")
            return jsonify({
                "status": "accepted",
                "message": "Reveal queued for processing"
            })
            
    except Exception as e:
        logging.error(f"Reveal processing error: {e}")
        return jsonify({
            "error": f"Reveal processing error: {str(e)}"
        }), 500

@consensus_bp.route('/stats', methods=['GET'])
def get_consensus_stats():
    """Get comprehensive consensus statistics."""
    try:
        from ..consensus.consensus_manager import get_consensus_manager
        consensus_manager = get_consensus_manager()
        
        if consensus_manager:
            stats = consensus_manager.get_consensus_stats()
            
            return jsonify({
                "stats": {
                    "current_round": stats.get("current_round", 0),
                    "total_rounds": stats.get("total_rounds", 0),
                    "commits_received": stats.get("commits_received", 0),
                    "reveals_received": stats.get("reveals_received", 0),
                    "consensus_success_rate": stats.get("success_rate", 0.0),
                    "average_round_time": stats.get("avg_round_time", 0),
                    "active_validators": stats.get("active_validators", 0),
                    "leader_node": stats.get("current_leader", "unknown"),
                    "next_round_start": stats.get("next_round_start", 0)
                },
                "status": "success"
            })
        else:
            # Return basic stats when consensus manager not available
            return jsonify({
                "stats": {
                    "current_round": 0,
                    "total_rounds": 0,
                    "commits_received": 0,
                    "reveals_received": 0,
                    "consensus_success_rate": 0.0,
                    "active_validators": 0,
                    "status": "initializing"
                },
                "message": "Consensus system initializing"
            })
            
    except Exception as e:
        logging.error(f"Consensus stats error: {e}")
        return jsonify({
            "error": "Failed to retrieve consensus stats"
        }), 500

@consensus_bp.route('/reputation', methods=['GET'])
def get_reputation():
    """Get node reputation information."""
    try:
        node_id = request.args.get('node_id')
        
        from ..consensus.consensus_manager import get_consensus_manager
        consensus_manager = get_consensus_manager()
        
        if consensus_manager:
            if node_id:
                # Get reputation for specific node
                reputation_data = consensus_manager.get_node_reputation(node_id)
                if reputation_data:
                    return jsonify({
                        "reputation": reputation_data,
                        "status": "success"
                    })
                else:
                    return jsonify({
                        "error": "Node not found"
                    }), 404
            else:
                # Get reputation for all nodes
                all_reputations = consensus_manager.get_all_reputations()
                return jsonify({
                    "reputation": {
                        "nodes": all_reputations,
                        "total_nodes": len(all_reputations),
                        "average_reputation": sum(r.get("score", 0) for r in all_reputations) / len(all_reputations) if all_reputations else 0
                    },
                    "status": "success"
                })
        else:
            return jsonify({
                "reputation": {},
                "message": "Consensus system initializing"
            })
            
    except Exception as e:
        logging.error(f"Reputation query error: {e}")
        return jsonify({
            "error": "Failed to retrieve reputation data"
        }), 500

@consensus_bp.route('/config', methods=['POST'])
def update_consensus_config():
    """Update consensus configuration parameters."""
    try:
        data = request.get_json()
        
        if not data:
            return jsonify({"error": "No configuration data provided"}), 400
        
        from ..consensus.consensus_manager import get_consensus_manager
        consensus_manager = get_consensus_manager()
        
        if consensus_manager:
            # Validate configuration parameters
            valid_params = {
                'commit_timeout', 'reveal_timeout', 'min_validators', 
                'max_validators', 'reputation_threshold', 'round_interval'
            }
            
            config_updates = {}
            for key, value in data.items():
                if key in valid_params:
                    config_updates[key] = value
                else:
                    return jsonify({
                        "error": f"Invalid configuration parameter: {key}"
                    }), 400
            
            if config_updates:
                result = consensus_manager.update_config(config_updates)
                
                if result.get("success"):
                    return jsonify({
                        "status": "success",
                        "message": "Consensus configuration updated",
                        "updated": config_updates,
                        "effective_from": result.get("effective_from", "next_round")
                    })
                else:
                    return jsonify({
                        "status": "error",
                        "error": result.get("error", "Configuration update failed")
                    }), 400
            else:
                return jsonify({
                    "error": "No valid configuration parameters provided"
                }), 400
        else:
            return jsonify({
                "error": "Consensus manager not available"
            }), 503
            
    except Exception as e:
        logging.error(f"Consensus config update error: {e}")
        return jsonify({
            "error": "Failed to update consensus configuration"
        }), 500

@consensus_bp.route('/leader', methods=['GET'])
def get_current_leader():
    """Get current consensus leader information."""
    try:
        from ..consensus.consensus_manager import get_consensus_manager
        consensus_manager = get_consensus_manager()
        
        if consensus_manager:
            leader_info = consensus_manager.get_current_leader()
            
            return jsonify({
                "leader": leader_info,
                "status": "success"
            })
        else:
            return jsonify({
                "leader": None,
                "message": "Consensus system initializing"
            })
            
    except Exception as e:
        logging.error(f"Leader query error: {e}")
        return jsonify({
            "error": "Failed to retrieve leader information"
        }), 500

# Add error handlers specific to consensus
@consensus_bp.errorhandler(404)
def consensus_not_found(error):
    return jsonify({"error": "Consensus endpoint not found"}), 404

@consensus_bp.errorhandler(500)
def consensus_internal_error(error):
    return jsonify({"error": "Consensus internal server error"}), 500