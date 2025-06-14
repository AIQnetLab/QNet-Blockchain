#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: security.py
Security enhancements for QNet
"""

import os
import json
import logging
import time
import hashlib
import base64
import hmac
import secrets
import socket
import ipaddress
import threading
import re
from typing import Dict, Any, List, Optional, Union, Set, Tuple, Callable

class SecurityManager:
    """
    Security manager for QNet nodes.
    Provides protection against common attacks and security policy enforcement.
    """
    
    def __init__(self, config=None):
        """
        Initialize the security manager.
        
        Args:
            config: Configuration object or dictionary
        """
        # Default configuration
        self.config = {
            'ip_whitelist': os.environ.get('QNET_IP_WHITELIST', '').split(','),
            'ip_blacklist': os.environ.get('QNET_IP_BLACKLIST', '').split(','),
            'max_failed_auth_attempts': int(os.environ.get('QNET_MAX_AUTH_FAILURES', '5')),
            'auth_ban_time_minutes': int(os.environ.get('QNET_AUTH_BAN_TIME', '30')),
            'ddos_protection_enabled': os.environ.get('QNET_DDOS_PROTECTION', 'true').lower() == 'true',
            'ddos_request_limit': int(os.environ.get('QNET_DDOS_REQUEST_LIMIT', '100')),
            'ddos_time_window_seconds': int(os.environ.get('QNET_DDOS_TIME_WINDOW', '60')),
            'audit_log_enabled': os.environ.get('QNET_AUDIT_LOG', 'true').lower() == 'true',
            'audit_log_file': os.environ.get('QNET_AUDIT_LOG_FILE', '/app/data/audit_log.json'),
            'key_rotation_days': int(os.environ.get('QNET_KEY_ROTATION_DAYS', '90')),
            'required_signature_header': os.environ.get('QNET_SIG_HEADER', 'X-QNet-Signature'),
            'use_ip_reputation': os.environ.get('QNET_USE_IP_REPUTATION', 'true').lower() == 'true',
            'tls_required': os.environ.get('QNET_TLS_REQUIRED', 'true').lower() == 'true',
            'validate_hostnames': os.environ.get('QNET_VALIDATE_HOSTNAMES', 'true').lower() == 'true',
            'max_payload_size_kb': int(os.environ.get('QNET_MAX_PAYLOAD_SIZE', '1024')),  # 1MB
            'security_headers': {
                'X-Content-Type-Options': 'nosniff',
                'X-Frame-Options': 'DENY',
                'Content-Security-Policy': "default-src 'self'",
                'X-XSS-Protection': '1; mode=block',
                'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
                'Cache-Control': 'no-store, no-cache, must-revalidate',
                'Pragma': 'no-cache',
            },
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
        
        # Initialize security state
        self.failed_auth_attempts = {}  # IP -> count
        self.ip_ban_list = {}  # IP -> expiry timestamp
        self.request_counts = {}  # IP -> list of timestamps
        self.ip_reputation = {}  # IP -> reputation score (0-100)
        self.csrf_tokens = {}  # Token -> expiry timestamp
        self.nonces = {}  # Nonce -> expiry timestamp
        
        # Mutex for thread safety
        self.lock = threading.RLock()
        
        # Load audit log if enabled
        self.audit_log = []
        if self.config['audit_log_enabled']:
            self._load_audit_log()
        
        logging.info("Security manager initialized")
    
    def check_ip_allowed(self, ip_address: str) -> bool:
        """
        Check if an IP is allowed to connect.
        
        Args:
            ip_address: IP address to check
            
        Returns:
            True if allowed, False if blocked
        """
        with self.lock:
            # Check if IP is banned
            if ip_address in self.ip_ban_list:
                ban_expiry = self.ip_ban_list[ip_address]
                if time.time() < ban_expiry:
                    self.audit_log_event(
                        'connection_blocked',
                        f"Blocked connection from banned IP: {ip_address}",
                        ip_address=ip_address
                    )
                    return False
                else:
                    # Ban expired, remove from list
                    del self.ip_ban_list[ip_address]
            
            # Check whitelist (if whitelist is configured, only allow whitelisted IPs)
            if self.config['ip_whitelist'] and self.config['ip_whitelist'][0]:
                for allowed_ip in self.config['ip_whitelist']:
                    if self._ip_match(ip_address, allowed_ip):
                        return True
                
                self.audit_log_event(
                    'connection_blocked',
                    f"Blocked connection from non-whitelisted IP: {ip_address}",
                    ip_address=ip_address
                )
                return False
            
            # Check blacklist
            if self.config['ip_blacklist'] and self.config['ip_blacklist'][0]:
                for blocked_ip in self.config['ip_blacklist']:
                    if self._ip_match(ip_address, blocked_ip):
                        self.audit_log_event(
                            'connection_blocked',
                            f"Blocked connection from blacklisted IP: {ip_address}",
                            ip_address=ip_address
                        )
                        return False
            
            # Check IP reputation if enabled
            if self.config['use_ip_reputation'] and ip_address in self.ip_reputation:
                reputation = self.ip_reputation[ip_address]
                if reputation < 20:  # Very bad reputation
                    self.audit_log_event(
                        'connection_blocked',
                        f"Blocked connection from IP with bad reputation: {ip_address} (score: {reputation})",
                        ip_address=ip_address,
                        reputation=reputation
                    )
                    return False
        
        return True
    
    def record_auth_failure(self, ip_address: str) -> bool:
        """
        Record an authentication failure and possibly ban the IP.
        
        Args:
            ip_address: IP address to record
            
        Returns:
            True if IP is now banned, False otherwise
        """
        with self.lock:
            # Initialize counter if not exists
            if ip_address not in self.failed_auth_attempts:
                self.failed_auth_attempts[ip_address] = 0
            
            # Increment counter
            self.failed_auth_attempts[ip_address] += 1
            
            # Log the event
            self.audit_log_event(
                'auth_failure',
                f"Authentication failure from IP: {ip_address} (attempts: {self.failed_auth_attempts[ip_address]})",
                ip_address=ip_address,
                attempt_count=self.failed_auth_attempts[ip_address]
            )
            
            # Check if we should ban this IP
            if self.failed_auth_attempts[ip_address] >= self.config['max_failed_auth_attempts']:
                # Ban for the configured time
                ban_duration = self.config['auth_ban_time_minutes'] * 60
                self.ip_ban_list[ip_address] = time.time() + ban_duration
                
                # Log the ban
                self.audit_log_event(
                    'ip_banned',
                    f"IP banned due to authentication failures: {ip_address} (banned for {self.config['auth_ban_time_minutes']} minutes)",
                    ip_address=ip_address,
                    ban_duration_minutes=self.config['auth_ban_time_minutes']
                )
                
                # Reset the counter
                self.failed_auth_attempts[ip_address] = 0
                
                # Also decrease reputation
                if self.config['use_ip_reputation']:
                    self._update_ip_reputation(ip_address, -20)
                
                return True
                
        return False
    
    def record_auth_success(self, ip_address: str):
        """
        Record an authentication success and reset the failure counter.
        
        Args:
            ip_address: IP address to record
        """
        with self.lock:
            # Reset counter
            if ip_address in self.failed_auth_attempts:
                self.failed_auth_attempts[ip_address] = 0
            
            # Improve reputation
            if self.config['use_ip_reputation']:
                self._update_ip_reputation(ip_address, 1)
    
    def check_ddos_protection(self, ip_address: str) -> bool:
        """
        Check if a request should be blocked by DDoS protection.
        
        Args:
            ip_address: IP address to check
            
        Returns:
            True if request should be allowed, False if blocked
        """
        if not self.config['ddos_protection_enabled']:
            return True
            
        with self.lock:
            current_time = time.time()
            
            # Initialize request list if not exists
            if ip_address not in self.request_counts:
                self.request_counts[ip_address] = []
            
            # Maintain list of request timestamps
            self.request_counts[ip_address].append(current_time)
            
            # Remove timestamps outside the time window
            time_window = self.config['ddos_time_window_seconds']
            window_start = current_time - time_window
            self.request_counts[ip_address] = [
                ts for ts in self.request_counts[ip_address] if ts >= window_start
            ]
            
            # Check if request count exceeds limit
            if len(self.request_counts[ip_address]) > self.config['ddos_request_limit']:
                # Log the event
                self.audit_log_event(
                    'ddos_protection',
                    f"Request blocked by DDoS protection: {ip_address} ({len(self.request_counts[ip_address])} requests in {time_window} seconds)",
                    ip_address=ip_address,
                    request_count=len(self.request_counts[ip_address]),
                    time_window_seconds=time_window
                )
                
                # Decrease reputation
                if self.config['use_ip_reputation']:
                    self._update_ip_reputation(ip_address, -5)
                
                return False
        
        return True
    
    def generate_csrf_token(self, session_id: str) -> str:
        """
        Generate a CSRF token for a session.
        
        Args:
            session_id: Session identifier
            
        Returns:
            CSRF token
        """
        with self.lock:
            # Generate a secure random token
            token = secrets.token_hex(32)
            
            # Store with 24-hour expiry
            self.csrf_tokens[token] = time.time() + 86400
            
            return token
    
    def verify_csrf_token(self, token: str) -> bool:
        """
        Verify a CSRF token.
        
        Args:
            token: Token to verify
            
        Returns:
            True if valid, False otherwise
        """
        with self.lock:
            # Check if token exists and not expired
            if token in self.csrf_tokens:
                expiry = self.csrf_tokens[token]
                if time.time() < expiry:
                    return True
                else:
                    # Token expired, remove it
                    del self.csrf_tokens[token]
        
        return False
    
    def generate_nonce(self) -> str:
        """
        Generate a nonce for replay protection.
        
        Returns:
            Nonce string
        """
        with self.lock:
            # Generate a secure random nonce
            nonce = secrets.token_hex(16)
            
            # Store with 5-minute expiry
            self.nonces[nonce] = time.time() + 300
            
            return nonce
    
    def verify_nonce(self, nonce: str) -> bool:
        """
        Verify a nonce (and consume it).
        
        Args:
            nonce: Nonce to verify
            
        Returns:
            True if valid, False otherwise
        """
        with self.lock:
            # Check if nonce exists and not expired
            if nonce in self.nonces:
                expiry = self.nonces[nonce]
                if time.time() < expiry:
                    # Consume the nonce
                    del self.nonces[nonce]
                    return True
                else:
                    # Nonce expired, remove it
                    del self.nonces[nonce]
        
        return False
    
    def clean_expired_data(self):
        """Clean expired data from all security caches."""
        with self.lock:
            current_time = time.time()
            
            # Clean expired IP bans
            self.ip_ban_list = {
                ip: expiry for ip, expiry in self.ip_ban_list.items()
                if expiry > current_time
            }
            
            # Clean expired CSRF tokens
            self.csrf_tokens = {
                token: expiry for token, expiry in self.csrf_tokens.items()
                if expiry > current_time
            }
            
            # Clean expired nonces
            self.nonces = {
                nonce: expiry for nonce, expiry in self.nonces.items()
                if expiry > current_time
            }
    
    def validate_payload_size(self, content_length: int) -> bool:
        """
        Validate that a payload size is within limits.
        
        Args:
            content_length: Content length in bytes
            
        Returns:
            True if allowed, False if too large
        """
        max_size = self.config['max_payload_size_kb'] * 1024
        return content_length <= max_size
    
    def get_security_headers(self) -> Dict[str, str]:
        """
        Get security headers to add to responses.
        
        Returns:
            Dictionary of security headers
        """
        return self.config['security_headers']
    
    def validate_hostname(self, hostname: str) -> bool:
        """
        Validate a hostname.
        
        Args:
            hostname: Hostname to validate
            
        Returns:
            True if valid, False otherwise
        """
        if not self.config['validate_hostnames']:
            return True
            
        # Simple validation: hostname must be alphanumeric, dots, and hyphens
        # and must not be all digits (to avoid IP addresses)
        if not hostname or len(hostname) > 255 or hostname.endswith('.'):
            return False
            
        if hostname.replace('.', '').isdigit():
            return False
            
        allowed_chars = re.compile(r'^[a-z0-9.-]+$', re.IGNORECASE)