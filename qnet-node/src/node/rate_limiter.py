#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: rate_limiter.py
Implements rate limiting for API protection
"""

import time
import threading
import logging
import os
from functools import wraps
from flask import request, jsonify, g

# Initialize logger
logging.basicConfig(level=logging.INFO,
                    format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

class RateLimiter:
    """Rate limiter implementation to prevent abuse"""
    
    def __init__(self):
        """Initialize the rate limiter"""
        self.limits = {
            # Endpoint: (requests_per_minute, burst)
            "default": (60, 10),  # 60 req/min with 10 burst
            "/api/v1/token/generate_code": (10, 3),  # More restrictive for sensitive operations
            "/api/v1/token/verify_code": (30, 5),
            "/api/v1/token/heartbeat": (120, 20),  # More permissive for heartbeats
            "/api/v1/token/wallet_codes": (30, 5),
            "/api/v1/token/initiate_transfer": (10, 3),
            "/api/v1/token/cancel_transfer": (10, 3),
            "/api/v1/node/activate": (10, 3),
            "/api/v1/node/verify_activation": (30, 5),
            "/api/v1/node/heartbeat": (120, 20),
            "/api/v1/node/status": (60, 10),
            "/api/v1/node/transfer": (10, 3)
        }
        self.requests = {}  # {ip: {endpoint: [(timestamp, count)]}}
        self.lock = threading.RLock()
        
        # Blacklist for repeat offenders
        self.blacklist = {}  # {ip: expiry_time}
        self.violation_counts = {}  # {ip: count}
        
        # IP whitelisting for trusted sources
        self.whitelist = set()
        self._load_whitelist()
    
    def _load_whitelist(self):
        """Load whitelist from environment or file"""
        # Environment variable for whitelist (comma-separated)
        env_whitelist = os.environ.get('QNET_RATE_LIMIT_WHITELIST', '')
        if env_whitelist:
            self.whitelist.update(ip.strip() for ip in env_whitelist.split(',') if ip.strip())
        
        # File-based whitelist
        whitelist_file = os.environ.get('QNET_RATE_LIMIT_WHITELIST_FILE')
        if whitelist_file and os.path.exists(whitelist_file):
            try:
                with open(whitelist_file, 'r') as f:
                    self.whitelist.update(line.strip() for line in f if line.strip())
            except Exception as e:
                logger.error(f"Error loading whitelist file: {e}")
        
        # Always whitelist localhost
        self.whitelist.add('127.0.0.1')
        self.whitelist.add('::1')
        
        logger.info(f"Rate limiter whitelist loaded: {len(self.whitelist)} entries")
    
    def is_rate_limited(self, ip, endpoint):
        """
        Check if request exceeds rate limit
        
        Args:
            ip: Client IP address
            endpoint: API endpoint
            
        Returns:
            bool: True if rate limited, False otherwise
        """
        with self.lock:
            now = time.time()
            
            # Check whitelist
            if ip in self.whitelist:
                return False
            
            # Check blacklist
            if ip in self.blacklist:
                expiry = self.blacklist[ip]
                if now < expiry:
                    # Still blacklisted
                    return True
                else:
                    # Blacklist expired
                    del self.blacklist[ip]
            
            # Find rate limit for endpoint or use default
            endpoint_parts = endpoint.split('/')
            
            # Try more specific match first, then less specific
            for i in range(len(endpoint_parts), 0, -1):
                test_endpoint = '/'.join(endpoint_parts[:i])
                if test_endpoint in self.limits:
                    limit, burst = self.limits[test_endpoint]
                    break
            else:
                # Use default if no match found
                limit, burst = self.limits["default"]
            
            window = 60.0  # 1 minute window
            
            # Initialize if needed
            if ip not in self.requests:
                self.requests[ip] = {}
            if endpoint not in self.requests[ip]:
                self.requests[ip][endpoint] = []
            
            # Clean up old entries
            self.requests[ip][endpoint] = [r for r in self.requests[ip][endpoint] 
                                          if now - r[0] < window]
            
            # Count recent requests
            recent_reqs = sum(r[1] for r in self.requests[ip][endpoint])
            
            # Check if limit exceeded
            if recent_reqs >= limit:
                self._register_violation(ip)
                return True
            
            # Check burst limit (requests in last 5 seconds)
            last_5sec = [r for r in self.requests[ip][endpoint] if now - r[0] < 5]
            burst_count = sum(r[1] for r in last_5sec)
            if burst_count >= burst:
                self._register_violation(ip)
                return True
            
            # Update request count
            if self.requests[ip][endpoint] and now - self.requests[ip][endpoint][-1][0] < 1:
                # Update last entry if less than 1 second ago
                self.requests[ip][endpoint][-1] = (self.requests[ip][endpoint][-1][0], 
                                                  self.requests[ip][endpoint][-1][1] + 1)
            else:
                # Add new entry
                self.requests[ip][endpoint].append((now, 1))
            
            return False
    
    def _register_violation(self, ip):
        """
        Register a rate limit violation for an IP
        
        Args:
            ip: Client IP address
        """
        # Update violation count
        self.violation_counts[ip] = self.violation_counts.get(ip, 0) + 1
        
        # Check if blacklisting is needed
        violation_count = self.violation_counts[ip]
        if violation_count >= 10:  # Blacklist after 10 violations
            # Exponential backoff for blacklist duration
            duration = min(60 * (2 ** (violation_count - 10)), 86400)  # Cap at 24 hours
            expiry = time.time() + duration
            self.blacklist[ip] = expiry
            logger.warning(f"IP {ip} blacklisted for {duration} seconds after {violation_count} violations")
            
            # Try to record in monitoring system
            try:
                from monitoring import prometheus_monitoring
                prometheus_monitoring.record_rate_limit(endpoint="blacklist", ip=ip)
            except (ImportError, AttributeError):
                pass
    
    def clear_old_data(self):
        """Clear old rate limit data to prevent memory leaks"""
        with self.lock:
            now = time.time()
            
            # Clear old blacklist entries
            expired_ips = [ip for ip, expiry in self.blacklist.items() if now > expiry]
            for ip in expired_ips:
                del self.blacklist[ip]
            
            # Clear old request data (older than 10 minutes)
            for ip in list(self.requests.keys()):
                for endpoint in list(self.requests[ip].keys()):
                    self.requests[ip][endpoint] = [r for r in self.requests[ip][endpoint] if now - r[0] < 600]
                    
                    # Remove empty endpoints
                    if not self.requests[ip][endpoint]:
                        del self.requests[ip][endpoint]
                
                # Remove empty IPs
                if not self.requests[ip]:
                    del self.requests[ip]
            
            # Clear old violation counts (reset after 1 hour of no violations)
            for ip in list(self.violation_counts.keys()):
                if ip not in self.requests or not any(self.requests[ip].values()):
                    # No recent requests, check if violation is old
                    if ip not in self.blacklist or self.blacklist[ip] - now < 3600:
                        del self.violation_counts[ip]

# Create global rate limiter instance
rate_limiter = RateLimiter()

# Start background cleanup thread
def _cleanup_loop():
    """Background thread to clean up old rate limit data"""
    while True:
        try:
            time.sleep(300)  # Clean up every 5 minutes
            rate_limiter.clear_old_data()
        except Exception as e:
            logger.error(f"Error in rate limiter cleanup: {e}")

cleanup_thread = threading.Thread(target=_cleanup_loop, daemon=True)
cleanup_thread.start()

# Flask middleware
def apply_rate_limiting(app):
    """Apply rate limiting to Flask app"""
    @app.before_request
    def check_rate_limit():
        """Check rate limit before processing request"""
        # Skip for OPTIONS (CORS)
        if request.method == 'OPTIONS':
            return None
            
        # Get client IP address
        ip = request.remote_addr
        
        # Allow bypassing in development
        if ip == '127.0.0.1' and os.environ.get('FLASK_ENV') == 'development' and request.args.get('bypass_rate_limit'):
            return None
            
        # Check rate limit
        endpoint = request.path
        if rate_limiter.is_rate_limited(ip, endpoint):
            # Calculate retry headers
            if hasattr(g, 'rate_limit_violations'):
                g.rate_limit_violations += 1
            else:
                g.rate_limit_violations = 1
                
            # Exponential backoff
            retry_after = min(2 ** g.rate_limit_violations, 3600)  # Cap at 1 hour
            
            # Try to record in monitoring
            try:
                from monitoring import prometheus_monitoring
                prometheus_monitoring.record_rate_limit(endpoint, ip)
            except (ImportError, AttributeError):
                pass
                
            # Return 429 response
            response = jsonify({
                "error": "Rate limit exceeded",
                "retry_after": retry_after
            })
            response.status_code = 429
            response.headers['Retry-After'] = str(retry_after)
            return response
        
        # Store IP in g for logging
        g.client_ip = ip
        
        return None

# Rate limit decorator for individual functions
def rate_limit(limit_per_minute, burst=None):
    """
    Decorator to apply rate limiting to a specific function
    
    Args:
        limit_per_minute: Requests allowed per minute
        burst: Burst limit (requests allowed in 5 seconds)
    """
    if burst is None:
        burst = max(1, limit_per_minute // 10)
        
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            ip = request.remote_addr
            endpoint = request.path
            
            # Use local rate limiting logic
            with rate_limiter.lock:
                now = time.time()
                
                # Check whitelist
                if ip in rate_limiter.whitelist:
                    return func(*args, **kwargs)
                
                # Check blacklist
                if ip in rate_limiter.blacklist:
                    expiry = rate_limiter.blacklist[ip]
                    if now < expiry:
                        # Still blacklisted
                        retry_after = int(expiry - now)
                        response = jsonify({
                            "error": "IP temporarily blocked due to abuse",
                            "retry_after": retry_after
                        })
                        response.status_code = 429
                        response.headers['Retry-After'] = str(retry_after)
                        return response
                    else:
                        # Blacklist expired
                        del rate_limiter.blacklist[ip]
                
                window = 60.0  # 1 minute window
                
                # Initialize if needed
                if ip not in rate_limiter.requests:
                    rate_limiter.requests[ip] = {}
                if endpoint not in rate_limiter.requests[ip]:
                    rate_limiter.requests[ip][endpoint] = []
                
                # Clean up old entries
                rate_limiter.requests[ip][endpoint] = [r for r in rate_limiter.requests[ip][endpoint] 
                                                      if now - r[0] < window]
                
                # Count recent requests
                recent_reqs = sum(r[1] for r in rate_limiter.requests[ip][endpoint])
                
                # Check if limit exceeded
                if recent_reqs >= limit_per_minute:
                    rate_limiter._register_violation(ip)
                    
                    # Calculate retry after
                    oldest_req = min(r[0] for r in rate_limiter.requests[ip][endpoint]) if rate_limiter.requests[ip][endpoint] else now
                    retry_after = max(1, int(oldest_req + window - now))
                    
                    response = jsonify({
                        "error": "Rate limit exceeded",
                        "retry_after": retry_after
                    })
                    response.status_code = 429
                    response.headers['Retry-After'] = str(retry_after)
                    return response
                
                # Check burst limit (requests in last 5 seconds)
                last_5sec = [r for r in rate_limiter.requests[ip][endpoint] if now - r[0] < 5]
                burst_count = sum(r[1] for r in last_5sec)
                if burst_count >= burst:
                    rate_limiter._register_violation(ip)
                    
                    response = jsonify({
                        "error": "Burst rate limit exceeded",
                        "retry_after": 5
                    })
                    response.status_code = 429
                    response.headers['Retry-After'] = "5"
                    return response
                
                # Update request count
                if rate_limiter.requests[ip][endpoint] and now - rate_limiter.requests[ip][endpoint][-1][0] < 1:
                    # Update last entry if less than 1 second ago
                    rate_limiter.requests[ip][endpoint][-1] = (rate_limiter.requests[ip][endpoint][-1][0], 
                                                              rate_limiter.requests[ip][endpoint][-1][1] + 1)
                else:
                    # Add new entry
                    rate_limiter.requests[ip][endpoint].append((now, 1))
            
            # Call the original function if not rate limited
            return func(*args, **kwargs)
        
        return wrapper
    
    return decorator