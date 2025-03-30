#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: api_integration.py
Integrates the token verification API with the main node API with enhanced security and performance.
"""

from flask import Blueprint, request, jsonify, g, current_app
import os
import logging
import json
import time
import hashlib
import sys
import sqlite3
from datetime import datetime
import threading
import traceback
from functools import wraps

# Import custom modules
try:
    from token_verification_api import init_integration, token_verification_bp, register_endpoints
    from rate_limiter import apply_rate_limiting, rate_limiter, rate_limit
    from monitoring import prometheus_monitoring, prometheus_middleware
    from async_operations import async_handler, register_async_endpoints, async_endpoint
    from node_startup_integration import verify_node_startup, NodeActivation
except ImportError as e:
    logging.error(f"Error importing required modules: {e}")
    logging.warning("Some functionality may be disabled")

# Set up logging
logging.basicConfig(level=logging.INFO,
                   format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

# Circuit breaker implementation
class CircuitBreaker:
    """Circuit breaker pattern implementation for API calls"""
    
    def __init__(self, name, failure_threshold=5, reset_timeout=60):
        """Initialize the circuit breaker"""
        self.name = name
        self.failure_threshold = failure_threshold
        self.reset_timeout = reset_timeout
        self.failures = 0
        self.opened_at = None
        self.state = "CLOSED"  # CLOSED, OPEN, HALF-OPEN
        self.lock = threading.RLock()
    
    def is_open(self):
        """Check if circuit is open"""
        with self.lock:
            if self.state == "OPEN":
                # Check if timeout has elapsed
                now = time.time()
                if self.opened_at and now - self.opened_at > self.reset_timeout:
                    self.state = "HALF-OPEN"
                    logger.info(f"Circuit {self.name} half-open after {self.reset_timeout}s timeout")
                    return False
                return True
            return False
    
    def record_success(self):
        """Record a successful API call"""
        with self.lock:
            if self.state == "HALF-OPEN":
                self.state = "CLOSED"
                self.failures = 0
                self.opened_at = None
                logger.info(f"Circuit {self.name} closed after successful call")
            elif self.state == "CLOSED":
                self.failures = 0  # Reset failures on success
    
    def record_failure(self):
        """Record a failed API call"""
        with self.lock:
            self.failures += 1
            logger.debug(f"Circuit {self.name} failure count: {self.failures}/{self.failure_threshold}")
            
            if self.failures >= self.failure_threshold:
                if self.state != "OPEN":
                    self.state = "OPEN"
                    self.opened_at = time.time()
                    logger.warning(f"Circuit {self.name} opened after {self.failures} failures")
                    
                    # Try to record in monitoring system
                    try:
                        prometheus_monitoring.record_circuit_breaker_trip(self.name)
                    except (NameError, AttributeError):
                        pass
    
    def reset(self):
        """Reset the circuit breaker"""
        with self.lock:
            self.state = "CLOSED"
            self.failures = 0
            self.opened_at = None
            logger.info(f"Circuit {self.name} manually reset")

class APIHealthMonitor:
    """Monitors API health and maintains circuit breakers"""
    
    def __init__(self):
        """Initialize API health monitor"""
        self.circuit_breakers = {}
        self.endpoints = {}
        self.lock = threading.RLock()
    
    def get_circuit_breaker(self, endpoint):
        """Get or create circuit breaker for endpoint"""
        with self.lock:
            if endpoint not in self.circuit_breakers:
                self.circuit_breakers[endpoint] = CircuitBreaker(endpoint)
            return self.circuit_breakers[endpoint]
    
    def record_request(self, endpoint, success, response_time=None):
        """Record API request result"""
        with self.lock:
            circuit = self.get_circuit_breaker(endpoint)
            
            # Update endpoint stats
            if endpoint not in self.endpoints:
                self.endpoints[endpoint] = {
                    "total_requests": 0,
                    "successes": 0,
                    "failures": 0,
                    "response_times": [],
                    "last_request": None,
                    "last_success": None,
                    "last_failure": None
                }
            
            stats = self.endpoints[endpoint]
            stats["total_requests"] += 1
            
            now = time.time()
            stats["last_request"] = now
            
            if success:
                circuit.record_success()
                stats["successes"] += 1
                stats["last_success"] = now
            else:
                circuit.record_failure()
                stats["failures"] += 1
                stats["last_failure"] = now
            
            if response_time is not None:
                stats["response_times"].append(response_time)
                if len(stats["response_times"]) > 100:
                    stats["response_times"].pop(0)
    
    def is_healthy(self, endpoint):
        """Check if endpoint is healthy"""
        with self.lock:
            circuit = self.get_circuit_breaker(endpoint)
            return not circuit.is_open()
    
    def get_health_report(self):
        """Get health report for all endpoints"""
        with self.lock:
            report = {}
            for endpoint, stats in self.endpoints.items():
                circuit = self.circuit_breakers.get(endpoint)
                
                # Calculate metrics
                total_requests = max(1, stats["total_requests"])
                success_rate = (stats["successes"] / total_requests) * 100
                
                response_times = stats["response_times"]
                avg_response_time = sum(response_times) / max(1, len(response_times))
                
                # Format dates
                format_time = lambda ts: datetime.fromtimestamp(ts).strftime('%Y-%m-%d %H:%M:%S') if ts else None
                
                report[endpoint] = {
                    "total_requests": stats["total_requests"],
                    "successes": stats["successes"],
                    "failures": stats["failures"],
                    "success_rate": f"{success_rate:.1f}%",
                    "avg_response_time": f"{avg_response_time:.2f}ms",
                    "last_request": format_time(stats["last_request"]),
                    "last_success": format_time(stats["last_success"]),
                    "last_failure": format_time(stats["last_failure"]),
                    "circuit_state": circuit.state if circuit else "UNKNOWN"
                }
            
            return report
    
    def reset_circuit(self, endpoint):
        """Reset circuit breaker for endpoint"""
        with self.lock:
            if endpoint in self.circuit_breakers:
                self.circuit_breakers[endpoint].reset()
                return True
            return False

# Create global health monitor
health_monitor = APIHealthMonitor()

def circuit_breaker(func):
    """Decorator for making API calls with circuit breaker pattern"""
    @wraps(func)
    def wrapper(*args, **kwargs):
        endpoint = request.path
        circuit = health_monitor.get_circuit_breaker(endpoint)
        
        # Check if circuit is open
        if circuit.is_open():
            logger.warning(f"Circuit for {endpoint} is open, failing fast")
            return jsonify({"error": "Service temporarily unavailable"}), 503
        
        # Initialize retry counter
        retries = 0
        delay = 1  # Start with 1 second delay
        start_time = time.time()
        
        while retries < 3:  # Maximum 3 retries
            try:
                result = func(*args, **kwargs)
                
                # Record successful request
                response_time = (time.time() - start_time) * 1000  # in ms
                health_monitor.record_request(endpoint, True, response_time)
                
                return result
                
            except (sqlite3.OperationalError, sqlite3.DatabaseError) as e:
                # Handle database errors with retry
                if "database is locked" in str(e) and retries < 2:
                    retries += 1
                    logger.warning(f"Database locked, retry {retries}/3 in {delay}s")
                    time.sleep(delay)
                    delay *= 2  # Exponential backoff
                else:
                    # Record failure
                    health_monitor.record_request(endpoint, False)
                    logger.error(f"Database error in {func.__name__}: {e}")
                    return jsonify({"error": "Database error, please try again"}), 500
                    
            except Exception as e:
                # Record failure
                health_monitor.record_request(endpoint, False)
                logger.error(f"Error in {func.__name__}: {e}")
                logger.error(traceback.format_exc())
                return jsonify({"error": "Internal server error"}), 500
        
        # If we get here, all retries failed
        return jsonify({"error": "Service temporarily unavailable"}), 503
    
    return wrapper

def offline_fallback(func):
    """Decorator for API endpoints with offline fallback capability"""
    @wraps(func)
    def wrapper(*args, **kwargs):
        try:
            return func(*args, **kwargs)
        except Exception as e:
            logger.error(f"Error in {func.__name__}, attempting offline fallback: {e}")
            
            # Try to load activation data for fallback
            try:
                if os.path.exists(ACTIVATION_FILE):
                    with open(ACTIVATION_FILE, 'r') as f:
                        activation_data = json.load(f)
                    
                    # Check if data is valid
                    required_fields = ['activation_code', 'node_id', 'last_verified']
                    if all(field in activation_data for field in required_fields):
                        logger.info("Using offline activation data")
                        
                        # Record in monitoring if available
                        try:
                            prometheus_monitoring.record_offline_mode_activation()
                        except (NameError, AttributeError):
                            pass
                            
                        # Create offline response
                        return jsonify({
                            "success": True,
                            "message": "Offline mode active",
                            "offline": True,
                            "activation_code": activation_data['activation_code'],
                            "node_id": activation_data['node_id'],
                            "last_verified": activation_data['last_verified']
                        }), 200
            except Exception as fallback_error:
                logger.error(f"Offline fallback failed: {fallback_error}")
            
            # If offline fallback fails, return original error
            return jsonify({"error": str(e)}), 500
    
    return wrapper

def integrate_token_verification(app, config_file=None):
    """
    Integrate token verification with the main API
    
    Args:
        app: Flask app to integrate with
        config_file: Path to configuration file
    """
    try:
        # Initialize token verification
        activation_manager = init_integration(config_file)
        
        # Register token verification endpoints
        register_endpoints(app)
        
        # Apply rate limiting
        apply_rate_limiting(app)
        
        # Apply Prometheus monitoring
        try:
            prometheus_middleware(app)
        except (NameError, AttributeError):
            logger.warning("Prometheus monitoring not available")
        
        # Register async endpoints
        try:
            register_async_endpoints(app)
        except (NameError, AttributeError):
            logger.warning("Async operations not available")
        
        # Create additional verification endpoints
        verify_blueprint = Blueprint('node_verification', __name__, url_prefix='/api/v1/node')
        
        @verify_blueprint.route('/verify_activation', methods=['POST'])
        @circuit_breaker
        @offline_fallback
        @rate_limit(30, 5)  # 30 requests per minute, burst of 5
        def verify_activation_endpoint():
            """Verify node activation status"""
            # Get data from request
            data = request.get_json()
            
            activation_code = data.get('activation_code')
            node_id = data.get('node_id')
            node_address = data.get('node_address')
            
            if not activation_code or not node_id or not node_address:
                return jsonify({
                    "success": False,
                    "error": "Missing required parameters"
                }), 400
            
            # Verify activation code
            is_valid, message = activation_manager.verify_activation_code(
                activation_code, node_id, node_address
            )
            
            if not is_valid:
                return jsonify({
                    "success": False,
                    "error": message
                }), 400
            
            return jsonify({
                "success": True,
                "message": message
            }), 200
        
        @verify_blueprint.route('/status', methods=['GET'])
        @circuit_breaker
        @rate_limit(60, 10)  # 60 requests per minute, burst of 10
        def node_status_endpoint():
            """Get node activation status"""
            # Get node ID from query parameter
            node_id = request.args.get('node_id')
            
            if not node_id:
                return jsonify({
                    "success": False,
                    "error": "Missing node_id parameter"
                }), 400
            
            # Query node status from database
            conn = sqlite3.connect(activation_manager.db_path)
            
            try:
                # Query node status
                cursor = conn.cursor()
                cursor.execute(
                    "SELECT n.is_active, n.last_verified, n.activation_code, n.wallet_address, "
                    "n.last_heartbeat, n.first_seen, a.expires_at "
                    "FROM nodes n JOIN activation_codes a ON n.activation_code = a.code "
                    "WHERE n.node_id = ?",
                    (node_id,)
                )
                
                result = cursor.fetchone()
                
                if not result:
                    return jsonify({
                        "success": False,
                        "error": "Node not found"
                    }), 404
                
                is_active, last_verified, activation_code, wallet_address, last_heartbeat, first_seen, expires_at = result
                
                # Check if verification is expired
                now = int(time.time())
                grace_period = 172800  # 48 hours
                
                status = "active" if is_active else "inactive"
                if now - last_verified > grace_period:
                    status = "expired"
                
                # Format dates
                format_time = lambda ts: datetime.fromtimestamp(ts).strftime('%Y-%m-%d %H:%M:%S') if ts else None
                
                return jsonify({
                    "success": True,
                    "node_id": node_id,
                    "status": status,
                    "activation_code": activation_code[:8] + "****" if activation_code else None,  # Only show part of the code for security
                    "wallet_address": wallet_address,
                    "last_verified": format_time(last_verified),
                    "last_heartbeat": format_time(last_heartbeat),
                    "first_seen": format_time(first_seen),
                    "expires_at": format_time(expires_at)
                }), 200
                
            finally:
                conn.close()
        
        @verify_blueprint.route('/activate', methods=['POST'])
        @circuit_breaker
        @rate_limit(10, 3)  # 10 requests per minute, burst of 3
        def activate_node_endpoint():
            """Activate a node with a code"""
            # Get data from request
            data = request.get_json()
            
            activation_code = data.get('activation_code')
            node_id = data.get('node_id')
            node_address = data.get('node_address')
            transfer_code = data.get('transfer_code')  # Optional for node transfers
            
            if not activation_code or not node_id or not node_address:
                return jsonify({
                    "success": False,
                    "error": "Missing required parameters"
                }), 400
            
            # Prepare signature for transfer if applicable
            signature = transfer_code if transfer_code else None
            
            # Verify activation code
            is_valid, message = activation_manager.verify_activation_code(
                activation_code, node_id, node_address, signature
            )
            
            if not is_valid:
                return jsonify({
                    "success": False,
                    "error": message
                }), 400
            
            # Check if this is first activation (message contains signature key)
            if isinstance(message, str) and message.startswith("Activation code valid"):
                return jsonify({
                    "success": True,
                    "message": "Node activated successfully"
                }), 200
            else:
                # This is a signature key from first activation
                return jsonify({
                    "success": True,
                    "message": "Node activated successfully",
                    "signature_key": message
                }), 200
        
        @verify_blueprint.route('/heartbeat', methods=['POST'])
        @circuit_breaker
        @rate_limit(120, 20)  # 120 requests per minute, burst of 20
        def node_heartbeat_endpoint():
            """Handle node heartbeat"""
            # Get data from request
            data = request.get_json()
            
            node_id = data.get('node_id')
            activation_code = data.get('activation_code')
            signature = data.get('signature')
            
            if not node_id or not activation_code:
                return jsonify({
                    "success": False,
                    "error": "Missing required parameters"
                }), 400
            
            # Update heartbeat
            success, message = activation_manager.update_node_heartbeat(
                node_id, activation_code, signature
            )
            
            if not success:
                return jsonify({
                    "success": False,
                    "error": message
                }), 400
            
            return jsonify({
                "success": True,
                "message": message
            }), 200
        
        @verify_blueprint.route('/transfer/initiate', methods=['POST'])
        @circuit_breaker
        @rate_limit(10, 3)  # 10 requests per minute, burst of 3
        def initiate_transfer_endpoint():
            """Initiate node transfer"""
            # Get data from request
            data = request.get_json()
            
            activation_code = data.get('activation_code')
            wallet_address = data.get('wallet_address')
            expiry_hours = data.get('expiry_hours', 24)
            
            if not activation_code or not wallet_address:
                return jsonify({
                    "success": False,
                    "error": "Missing required parameters"
                }), 400
            
            # Initiate transfer
            success, message, transfer_code = activation_manager.initiate_node_transfer(
                activation_code, wallet_address, expiry_hours
            )
            
            if not success:
                return jsonify({
                    "success": False,
                    "error": message
                }), 400
            
            # Record in monitoring
            try:
                prometheus_monitoring.record_node_transfer("initiated")
            except (NameError, AttributeError):
                pass
                
            return jsonify({
                "success": True,
                "message": message,
                "transfer_code": transfer_code
            }), 200
        
        @verify_blueprint.route('/transfer/cancel', methods=['POST'])
        @circuit_breaker
        @rate_limit(10, 3)  # 10 requests per minute, burst of 3
        def cancel_transfer_endpoint():
            """Cancel node transfer"""
            # Get data from request
            data = request.get_json()
            
            activation_code = data.get('activation_code')
            wallet_address = data.get('wallet_address')
            
            if not activation_code or not wallet_address:
                return jsonify({
                    "success": False,
                    "error": "Missing required parameters"
                }), 400
            
            # Cancel transfer
            success, message = activation_manager.cancel_node_transfer(
                activation_code, wallet_address
            )
            
            if not success:
                return jsonify({
                    "success": False,
                    "error": message
                }), 400
            
            # Record in monitoring
            try:
                prometheus_monitoring.record_node_transfer("cancelled")
            except (NameError, AttributeError):
                pass
                
            return jsonify({
                "success": True,
                "message": message
            }), 200
        
        @verify_blueprint.route('/health', methods=['GET'])
        def health_endpoint():
            """Get API health status"""
            report = health_monitor.get_health_report()
            
            # Check nodes status
            nodes = activation_manager.get_active_nodes()
            
            return jsonify({
                "success": True,
                "endpoints": report,
                "active_nodes": len(nodes),
                "timestamp": datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            }), 200
        
        @verify_blueprint.route('/health/reset_circuit/<endpoint>', methods=['POST'])
        def reset_circuit_endpoint(endpoint):
            """Reset circuit breaker for an endpoint"""
            # Clean endpoint path
            endpoint = endpoint.replace('__', '/')
            
            success = health_monitor.reset_circuit(endpoint)
            
            if not success:
                return jsonify({
                    "success": False,
                    "error": f"Circuit breaker for {endpoint} not found"
                }), 404
            
            return jsonify({
                "success": True,
                "message": f"Circuit breaker for {endpoint} reset successfully"
            }), 200
        
        # Register blueprint
        app.register_blueprint(verify_blueprint)
        
        logger.info("Token verification API integrated successfully")
        
    except Exception as e:
        logger.error(f"Error integrating token verification: {e}")
        logger.error(traceback.format_exc())
        logger.warning("Node activation will be disabled")

def setup_node_verification(app, config):
    """
    Setup node verification middleware
    
    Args:
        app: Flask app
        config: Configuration object
    """
    # Check if token verification is enabled
    verification_enabled = getattr(config, 'verification_enabled', True)
    
    if not verification_enabled:
        logger.info("Node verification is disabled")
        return
    
    @app.before_request
    def verify_node_access():
        """Middleware to verify node access for protected endpoints"""
        # Skip verification for token verification endpoints and public endpoints
        if (request.path.startswith('/api/v1/token') or 
            request.path.startswith('/api/v1/node') or
            request.path == '/' or
            request.path.startswith('/static')):
            return None
        
        # Start timer for response time tracking
        g.start_time = time.time()
        
        # Try to get node activation data
        try:
            activation_file = os.path.join(os.path.expanduser('~'), '.qnet', 'activation.json')
            
            if not os.path.exists(activation_file):
                return jsonify({
                    "success": False,
                    "error": "Node not activated",
                    "message": "Please activate your node with an activation code"
                }), 403
            
            with open(activation_file, 'r') as f:
                activation_data = json.load(f)
            
            # Check if activation data is valid
            required_fields = ['activation_code', 'node_id', 'last_verified']
            if not all(field in activation_data for field in required_fields):
                return jsonify({
                    "success": False,
                    "error": "Invalid activation data",
                    "message": "Please activate your node with a valid activation code"
                }), 403
            
            # Check if verification is expired
            now = time.time()
            last_verified = activation_data.get('last_verified', 0)
            grace_period = 172800  # 48 hours
            
            if now - last_verified > grace_period:
                # Check if we can operate offline
                cache_file = os.path.join(os.path.expanduser('~'), '.qnet', 'cache', 'verification_cache.json')
                if os.path.exists(cache_file):
                    with open(cache_file, 'r') as f:
                        cache = json.load(f)
                    
                    remaining = cache.get('remaining_offline_allowance', 0)
                    if remaining > 0:
                        logger.warning(f"Operating in offline mode (remaining: {remaining}s)")
                        return None
                
                return jsonify({
                    "success": False,
                    "error": "Activation expired",
                    "message": "Please re-verify your node activation"
                }), 403
            
        except Exception as e:
            logger.error(f"Error verifying node access: {e}")
            return jsonify({
                "success": False,
                "error": "Error verifying node access"
            }), 500
        
        # Allow request to proceed
        return None
    
    @app.after_request
    def after_request_handler(response):
        """After request handler for metrics"""
        try:
            # Calculate response time if start_time was set
            if hasattr(g, 'start_time'):
                response_time = (time.time() - g.start_time) * 1000  # ms
                
                # Record endpoint metrics
                endpoint = request.path
                success = 200 <= response.status_code < 400
                
                try:
                    # Update health monitor
                    health_monitor.record_request(endpoint, success, response_time)
                    
                    # Update Prometheus metrics if available
                    prometheus_monitoring.record_request(
                        endpoint=endpoint,
                        method=request.method,
                        status=response.status_code,
                        response_time=response_time
                    )
                except (NameError, AttributeError):
                    pass
                
                # Add response time header
                response.headers['X-Response-Time'] = f"{response_time:.2f}ms"
        except Exception as e:
            logger.error(f"Error in after_request_handler: {e}")
        
        return response

# Helper class for shared state
class QNetNodeState:
    """Shared state for QNet node"""
    
    def __init__(self):
        """Initialize shared state"""
        self.is_activated = False
        self.activation_data = None
        self.node_id = None
        self.heartbeat_thread = None
        self.activation_handler = None
    
    def setup_activation(self, config_file=None):
        """Setup activation handler"""
        self.activation_handler = NodeActivation(config_file)
        
        # Check existing activation
        if self.activation_handler.activation_data.get('activation_code'):
            self.is_activated = True
            self.activation_data = self.activation_handler.activation_data
            self.node_id = self.activation_handler.node_id
            
            # Start heartbeat thread
            self.activation_handler.start_heartbeat_thread()
    
    def shutdown(self):
        """Shutdown shared state"""
        if self.activation_handler:
            self.activation_handler.stop_heartbeat_thread()
        
        # Stop async handler
        try:
            async_handler.shutdown()
        except (NameError, AttributeError):
            pass

# Create global shared state
qnet_state = QNetNodeState()

def initialize_api(app, config_file=None):
    """
    Initialize all API integrations
    
    Args:
        app: Flask app
        config_file: Path to configuration file
        
    Returns:
        bool: True if successful, False otherwise
    """
    try:
        # Ensure node is activated
        if not verify_node_startup(config_file):
            logger.error("Node startup verification failed")
            return False
        
        # Initialize state
        qnet_state.setup_activation(config_file)
        
        # Integrate token verification
        integrate_token_verification(app, config_file)
        
        # Setup node verification middleware
        if hasattr(app, 'config'):
            setup_node_verification(app, app.config)
        
        # Setup shutdown handler
        if hasattr(app, 'teardown_appcontext'):
            @app.teardown_appcontext
            def shutdown_node(exception=None):
                qnet_state.shutdown()
        
        logger.info("API initialization complete")
        return True
        
    except Exception as e:
        logger.error(f"Error initializing API: {e}")
        logger.error(traceback.format_exc())
        return False