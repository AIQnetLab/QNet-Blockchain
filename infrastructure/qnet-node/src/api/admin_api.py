# File: QNet-Project/qnet-node/src/api/admin_api.py
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: admin_api.py
Blueprint for QNet node administrative API endpoints.
Requires proper authentication and authorization.
"""
from flask import Blueprint, jsonify, request
import logging
from functools import wraps

admin_bp = Blueprint('admin_api', __name__)

# Authentication decorator for admin endpoints
def require_admin_auth(f):
    """Decorator to require admin authentication."""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        # Get API key from header
        api_key = request.headers.get('X-Admin-API-Key')
        
        if not api_key:
            return jsonify({"error": "Missing admin API key"}), 401
        
        # Validate API key (in production, use proper key management)
        try:
            from ..security.auth_manager import validate_admin_key
            if not validate_admin_key(api_key):
                return jsonify({"error": "Invalid admin API key"}), 403
        except ImportError:
            # Fallback for development
            if api_key != "qnet_admin_dev_key_123":
                return jsonify({"error": "Invalid admin API key"}), 403
        
        return f(*args, **kwargs)
    
    return decorated_function

@admin_bp.route('/config', methods=['GET', 'POST'])
def manage_config():
    """Get or update node configuration."""
    try:
        if request.method == 'POST':
            data = request.get_json()
            if not data:
                return jsonify({"error": "No configuration data provided"}), 400
                
            from ..node.node import get_node_instance
            node = get_node_instance()
            
            if node:
                result = node.update_config(data)
                if result.get("success"):
                    return jsonify({
                        "status": "success",
                        "message": "Configuration updated successfully",
                        "updated_fields": list(data.keys())
                    })
                else:
                    return jsonify({
                        "status": "error", 
                        "error": result.get("error", "Configuration update failed")
                    }), 400
            else:
                return jsonify({"error": "Node not available"}), 503
        else:
            # GET configuration
            from ..node.node import get_node_instance
            node = get_node_instance()
            
            if node:
                config = node.get_config()
                return jsonify({
                    "config": config,
                    "status": "success"
                })
            else:
                return jsonify({
                    "config": {},
                    "error": "Node not available"
                }), 503
                
    except Exception as e:
        logging.error(f"Configuration management error: {e}")
        return jsonify({
            "error": f"Configuration management error: {str(e)}"
        }), 500

@admin_bp.route('/control/restart', methods=['POST'])
@require_admin_auth
def restart_node():
    """Restart node with graceful shutdown."""
    try:
        from ..node.node import get_node_instance
        node = get_node_instance()
        
        if node:
            # Initiate graceful restart
            restart_result = node.graceful_restart()
            
            if restart_result.get("success"):
                return jsonify({
                    "status": "success",
                    "message": "Node restart initiated",
                    "restart_id": restart_result.get("restart_id"),
                    "estimated_downtime": restart_result.get("estimated_downtime", "30 seconds")
                })
            else:
                return jsonify({
                    "status": "error",
                    "error": restart_result.get("error", "Restart failed")
                }), 500
        else:
            return jsonify({
                "error": "Node not available for restart"
            }), 503
            
    except Exception as e:
        logging.error(f"Restart operation error: {e}")
        return jsonify({
            "error": f"Restart operation failed: {str(e)}"
        }), 500

@admin_bp.route('/security/status', methods=['GET'])
def get_security_status():
    """Get security status and metrics."""
    try:
        # Import production crypto module
        try:
            from qnet_core.src.crypto.rust.production_crypto import ProductionSig, Algorithm
            post_quantum_available = True
            algorithm = "Dilithium2"
        except ImportError:
            post_quantum_available = False
            algorithm = "Ed25519"
        
        from ..node.node import get_node_instance
        node = get_node_instance()
        
        security_status = {
            "post_quantum_enabled": post_quantum_available,
            "encryption_algorithm": algorithm,
            "key_rotation_status": "active" if post_quantum_available else "disabled",
            "threat_level": "low",
            "active_connections": 0,
            "failed_auth_attempts": 0,
            "last_security_scan": 0
        }
        
        if node:
            node_security = node.get_security_status()
            security_status.update(node_security)
        
        return jsonify({
            "security": security_status,
            "status": "success"
        })
            
    except Exception as e:
        logging.error(f"Security status error: {e}")
        return jsonify({
            "error": f"Security status error: {str(e)}"
        }), 500

@admin_bp.route('/sharding/status', methods=['GET'])
def get_sharding_status():
    """Get sharding configuration and statistics."""
    try:
        # Check if sharding is available
        try:
            from qnet_sharding.src.production_sharding import ProductionShardManager
            sharding_available = True
        except ImportError:
            sharding_available = False
        
        if sharding_available:
            # Get shard manager instance
            from ..node.node import get_node_instance
            node = get_node_instance()
            
            if node and hasattr(node, 'shard_manager'):
                shard_manager = node.shard_manager
                stats = shard_manager.get_shard_stats()
                cross_stats = shard_manager.get_cross_shard_stats()
                
                return jsonify({
                    "sharding": {
                        "enabled": True,
                        "total_shards": shard_manager.config.total_shards,
                        "managed_shards": shard_manager.config.managed_shards,
                        "shard_stats": stats,
                        "cross_shard_stats": cross_stats,
                        "estimated_tps": len(shard_manager.config.managed_shards) * shard_manager.config.max_tps_per_shard
                    },
                    "status": "success"
                })
            else:
                return jsonify({
                    "sharding": {
                        "enabled": False,
                        "status": "sharding_manager_unavailable"
                    },
                    "message": "Sharding manager initializing"
                })
        else:
            return jsonify({
                "sharding": {
                    "enabled": False,
                    "status": "sharding_not_available"
                },
                "message": "Sharding module not installed"
            })
            
    except Exception as e:
        logging.error(f"Sharding status error: {e}")
        return jsonify({
            "error": f"Sharding status error: {str(e)}"
        }), 500

@admin_bp.route('/performance/metrics', methods=['GET'])
def get_performance_metrics():
    """Get comprehensive performance metrics."""
    try:
        from ..node.node import get_node_instance
        node = get_node_instance()
        
        if node:
            metrics = node.get_performance_metrics()
            
            return jsonify({
                "performance": {
                    "current_tps": metrics.get("current_tps", 0),
                    "peak_tps": metrics.get("peak_tps", 0),
                    "average_tps": metrics.get("average_tps", 0),
                    "mempool_size": metrics.get("mempool_size", 0),
                    "mempool_utilization": metrics.get("mempool_utilization", 0),
                    "block_production_rate": metrics.get("block_rate", 0),
                    "network_latency": metrics.get("network_latency", 0),
                    "cpu_usage": metrics.get("cpu_usage", 0),
                    "memory_usage": metrics.get("memory_usage", 0),
                    "disk_usage": metrics.get("disk_usage", 0),
                    "uptime_seconds": metrics.get("uptime", 0)
                },
                "status": "success"
            })
        else:
            return jsonify({
                "performance": {
                    "current_tps": 0,
                    "status": "node_unavailable"
                },
                "error": "Node not available"
            }), 503
            
    except Exception as e:
        logging.error(f"Performance metrics error: {e}")
        return jsonify({
            "error": f"Performance metrics error: {str(e)}"
        }), 500

# Error handlers
@admin_bp.errorhandler(401)
def unauthorized(error):
    return jsonify({"error": "Unauthorized access"}), 401

@admin_bp.errorhandler(403)
def forbidden(error):
    return jsonify({"error": "Forbidden - insufficient privileges"}), 403

@admin_bp.errorhandler(500)
def internal_error(error):
    return jsonify({"error": "Internal server error"}), 500

# Add other admin endpoints here...