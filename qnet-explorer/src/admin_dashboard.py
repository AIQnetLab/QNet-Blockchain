#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: admin_dashboard.py
Administrative dashboard for QNet
"""

import os
import json
import logging
import time
import threading
import base64
import hashlib
from typing import Dict, Any, List, Optional, Union, Set, Tuple
from flask import Flask, request, jsonify, render_template, redirect, url_for, session

# Import QNet components
from monitoring import get_monitor
from security import get_security_manager
from token_verification import get_token_verifier
from consensus import get_consensus

class AdminDashboard:
    """
    Administrative dashboard for QNet nodes.
    Provides web interface for monitoring, configuration, and control.
    """
    
    def __init__(self, app: Flask, config=None):
        """
        Initialize the administrative dashboard.
        
        Args:
            app: Flask application instance
            config: Configuration object or dictionary
        """
        # Default configuration
        self.config = {
            'admin_enabled': os.environ.get('QNET_ADMIN_ENABLED', 'true').lower() == 'true',
            'admin_username': os.environ.get('QNET_ADMIN_USERNAME', 'admin'),
            'admin_password_hash': os.environ.get('QNET_ADMIN_PASSWORD_HASH', ''),  # Should be pre-hashed
            'admin_session_minutes': int(os.environ.get('QNET_ADMIN_SESSION', '30')),
            'admin_api_key': os.environ.get('QNET_ADMIN_API_KEY', ''),
            'admin_require_2fa': os.environ.get('QNET_ADMIN_REQUIRE_2FA', 'false').lower() == 'true',
            'admin_allowed_ips': os.environ.get('QNET_ADMIN_ALLOWED_IPS', '127.0.0.1').split(','),
            'node_control_enabled': os.environ.get('QNET_NODE_CONTROL', 'true').lower() == 'true',
            'blockchain_explorer_enabled': os.environ.get('QNET_EXPLORER_ENABLED', 'true').lower() == 'true',
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
        
        # Validate configuration
        if not self.config['admin_password_hash'] and self.config['admin_enabled']:
            logging.warning("Admin dashboard enabled but no password hash set - this is insecure!")
            
        # Store Flask app reference
        self.app = app
        
        # Get component instances
        self.monitor = get_monitor()
        self.security_manager = get_security_manager()
        self.token_verifier = get_token_verifier()
        self.consensus = get_consensus()
        
        # Register routes if admin dashboard is enabled
        if self.config['admin_enabled']:
            self._register_routes()
            
            logging.info("Admin dashboard initialized")
        else:
            logging.info("Admin dashboard disabled")
    
    def _register_routes(self):
        """Register admin dashboard routes with Flask app."""
        
        # Authentication routes
        @self.app.route('/admin/login', methods=['GET', 'POST'])
        def admin_login():
            # Handle login form submission
            if request.method == 'POST':
                username = request.form.get('username')
                password = request.form.get('password')
                
                # Check IP whitelist
                client_ip = request.remote_addr
                if not self._is_ip_allowed(client_ip):
                    self.security_manager.audit_log_event(
                        'admin_login_blocked',
                        f"Admin login attempt from non-whitelisted IP: {client_ip}",
                        ip_address=client_ip
                    )
                    return render_template('admin/login.html', error="Access denied from your IP address")
                
                # Check credentials
                if not self._check_credentials(username, password):
                    # Record auth failure for this IP
                    self.security_manager.record_auth_failure(client_ip)
                    
                    return render_template('admin/login.html', error="Invalid username or password")
                
                # Check 2FA if required
                if self.config['admin_require_2fa']:
                    totp_code = request.form.get('totp_code')
                    if not self._verify_2fa(username, totp_code):
                        self.security_manager.record_auth_failure(client_ip)
                        return render_template('admin/login.html', error="Invalid 2FA code")
                
                # Authentication successful
                self.security_manager.record_auth_success(client_ip)
                self.security_manager.audit_log_event(
                    'admin_login',
                    f"Admin login successful: {username}",
                    username=username,
                    ip_address=client_ip
                )
                
                # Set session
                session['admin_authenticated'] = True
                session['admin_username'] = username
                session['admin_expiry'] = time.time() + (self.config['admin_session_minutes'] * 60)
                
                # Set CSRF token
                session['csrf_token'] = self.security_manager.generate_csrf_token(session.sid)
                
                return redirect(url_for('admin_dashboard'))
            
            # Show login form
            return render_template('admin/login.html')
            
        @self.app.route('/admin/logout')
        def admin_logout():
            # Clear session
            session.pop('admin_authenticated', None)
            session.pop('admin_username', None)
            session.pop('admin_expiry', None)
            session.pop('csrf_token', None)
            
            return redirect(url_for('admin_login'))
        
        @self.app.route('/admin')
        def admin_index():
            return redirect(url_for('admin_dashboard'))
        
        # Main dashboard route
        @self.app.route('/admin/dashboard')
        def admin_dashboard():
            # Check authentication
            if not self._is_authenticated():
                return redirect(url_for('admin_login'))
                
            # Get system metrics for display
            system_metrics = None
            blockchain_metrics = None
            if self.monitor:
                # Get latest metrics
                if self.monitor.last_system_metrics:
                    system_metrics = self.monitor.last_system_metrics
                if self.monitor.last_blockchain_metrics:
                    blockchain_metrics = self.monitor.last_blockchain_metrics
            
            return render_template(
                'admin/dashboard.html',
                system_metrics=system_metrics,
                blockchain_metrics=blockchain_metrics,
                csrf_token=session.get('csrf_token')
            )
        
        # Node configuration route
        @self.app.route('/admin/config', methods=['GET', 'POST'])
        def admin_config():
            # Check authentication
            if not self._is_authenticated():
                return redirect(url_for('admin_login'))
                
            # Check if node control is enabled
            if not self.config['node_control_enabled']:
                return render_template('admin/error.html', error="Node control is disabled")
                
            # Handle form submission
            if request.method == 'POST':
                # Verify CSRF token
                csrf_token = request.form.get('csrf_token')
                if not self.security_manager.verify_csrf_token(csrf_token):
                    return render_template('admin/error.html', error="Invalid CSRF token")
                
                # Get configuration changes
                # (This would depend on the specific configuration options available)
                # For example:
                new_config = {}
                for key in request.form:
                    if key != 'csrf_token':
                        new_config[key] = request.form[key]
                
                # Apply configuration changes
                # (This would depend on the specific configuration system)
                self._apply_configuration(new_config)
                
                # Log the configuration change
                self.security_manager.audit_log_event(
                    'config_changed',
                    f"Configuration changed by admin: {session.get('admin_username')}",
                    username=session.get('admin_username'),
                    changes=new_config
                )
                
                return redirect(url_for('admin_config', success=True))
            
            # Show configuration form
            # (This would depend on the specific configuration system)
            current_config = self._get_current_config()
            
            return render_template(
                'admin/config.html',
                config=current_config,
                csrf_token=session.get('csrf_token')
            )
        
        # Monitoring routes
        @self.app.route('/admin/monitoring')
        def admin_monitoring():
            # Check authentication
            if not self._is_authenticated():
                return redirect(url_for('admin_login'))
                
            # Get monitoring data
            # Default to last hour of data
            time_range = int(request.args.get('time_range', 3600))
            metrics = {}
            
            if self.monitor:
                metrics = self.monitor.get_metrics(time_range)
            
            return render_template(
                'admin/monitoring.html',
                metrics=metrics,
                time_range=time_range,
                csrf_token=session.get('csrf_token')
            )
        
        # Alerts routes
        @self.app.route('/admin/alerts')
        def admin_alerts():
            # Check authentication
            if not self._is_authenticated():
                return redirect(url_for('admin_login'))
                
            # Get alerts
            include_resolved = request.args.get('include_resolved', 'false').lower() == 'true'
            alerts = []
            
            if self.monitor:
                alerts = self.monitor.get_alerts(include_resolved)
            
            return render_template(
                'admin/alerts.html',
                alerts=alerts,
                include_resolved=include_resolved,
                csrf_token=session.get('csrf_token')
            )
        
        # API to resolve an alert
        @self.app.route('/admin/api/alerts/<int:alert_index>/resolve', methods=['POST'])
        def admin_resolve_alert(alert_index):
            # Check authentication
            if not self._is_authenticated():
                return jsonify({'success': False, 'error': 'Not authenticated'}), 401
                
            # Verify CSRF token
            csrf_token = request.form.get('csrf_token')
            if not self.security_manager.verify_csrf_token(csrf_token):
                return jsonify({'success': False, 'error': 'Invalid CSRF token'}), 403
                
            # Resolve the alert
            if self.monitor:
                self.monitor.resolve_alert(alert_index)
                
                # Log the alert resolution
                self.security_manager.audit_log_event(
                    'alert_resolved',
                    f"Alert resolved by admin: {session.get('admin_username')}",
                    username=session.get('admin_username'),
                    alert_index=alert_index
                )
                
                return jsonify({'success': True})
            
            return jsonify({'success': False, 'error': 'Monitor not available'}), 500
        
        # Network routes
        @self.app.route('/admin/network')
        def admin_network():
            # Check authentication
            if not self._is_authenticated():
                return redirect(url_for('admin_login'))
                
            # Get network information
            # This would depend on the specific network module
            network_info = self._get_network_info()
            
            return render_template(
                'admin/network.html',
                network_info=network_info,
                csrf_token=session.get('csrf_token')
            )
        
        # Token verification routes
        @self.app.route('/admin/tokens')
        def admin_tokens():
            # Check authentication
            if not self._is_authenticated():
                return redirect(url_for('admin_login'))
                
            # Get token verification data
            token_info = {}
            
            if self.token_verifier:
                # Get token verification status
                token_info = {
                    'total_verifications': getattr(self.token_verifier, 'total_verifications', 0),
                    'successful_verifications': getattr(self.token_verifier, 'successful_verifications', 0),
                    'failed_verifications': getattr(self.token_verifier, 'failed_verifications', 0),
                    'token_address': self.token_verifier.config.get('token_address', ''),
                    'min_token_balance': self.token_verifier.config.get('min_token_balance', 0),
                    'network': self.token_verifier.config.get('network', ''),
                }
            
            return render_template(
                'admin/tokens.html',
                token_info=token_info,
                csrf_token=session.get('csrf_token')
            )
        
        # Blockchain explorer routes (if enabled)
        if self.config['blockchain_explorer_enabled']:
            @self.app.route('/admin/explorer')
            def admin_explorer():
                # Check authentication
                if not self._is_authenticated():
                    return redirect(url_for('admin_login'))
                    
                # Get blockchain data
                # This would depend on the specific blockchain module
                blockchain_data = self._get_blockchain_data()
                
                return render_template(
                    'admin/explorer.html',
                    blockchain_data=blockchain_data,
                    csrf_token=session.get('csrf_token')
                )
                
            @self.app.route('/admin/explorer/block/<int:height>')
            def admin_explorer_block(height):
                # Check authentication
                if not self._is_authenticated():
                    return redirect(url_for('admin_login'))
                    
                # Get block data
                # This would depend on the specific blockchain module
                block_data = self._get_block_data(height)
                
                if not block_data:
                    return render_template('admin/error.html', error=f"Block {height} not found")
                
                return render_template(
                    'admin/block.html',
                    block=block_data,
                    csrf_token=session.get('csrf_token')
                )
                
            @self.app.route('/admin/explorer/transaction/<string:tx_id>')
            def admin_explorer_transaction(tx_id):
                # Check authentication
                if not self._is_authenticated():
                    return redirect(url_for('admin_login'))
                    
                # Get transaction data
                # This would depend on the specific blockchain module
                tx_data = self._get_transaction_data(tx_id)
                
                if not tx_data:
                    return render_template('admin/error.html', error=f"Transaction {tx_id} not found")
                
                return render_template(
                    'admin/transaction.html',
                    transaction=tx_data,
                    csrf_token=session.get('csrf_token')
                )
        
        # Security routes
        @self.app.route('/admin/security')
        def admin_security():
            # Check authentication
            if not self._is_authenticated():
                return redirect(url_for('admin_login'))
                
            # Get security data
            # This would depend on the specific security module
            security_data = {}
            
            if self.security_manager:
                # Get security information
                security_data = {
                    'banned_ips': len(getattr(self.security_manager, 'ip_ban_list', {})),
                    'failed_auth_ips': len(getattr(self.security_manager, 'failed_auth_attempts', {})),
                    'csrf_tokens': len(getattr(self.security_manager, 'csrf_tokens', {})),
                    'audit_log_count': len(getattr(self.security_manager, 'audit_log', [])),
                    'ddos_protection': self.security_manager.config.get('ddos_protection_enabled', False),
                    'ip_reputation': self.security_manager.config.get('use_ip_reputation', False),
                }
            
            return render_template(
                'admin/security.html',
                security_data=security_data,
                csrf_token=session.get('csrf_token')
            )
            
        # API to unban an IP
        @self.app.route('/admin/api/security/unban_ip', methods=['POST'])
        def admin_unban_ip():
            # Check authentication
            if not self._is_authenticated():
                return jsonify({'success': False, 'error': 'Not authenticated'}), 401
                
            # Verify CSRF token
            csrf_token = request.form.get('csrf_token')
            if not self.security_manager.verify_csrf_token(csrf_token):
                return jsonify({'success': False, 'error': 'Invalid CSRF token'}), 403
                
            # Get IP to unban
            ip_address = request.form.get('ip_address')
            if not ip_address:
                return jsonify({'success': False, 'error': 'No IP address provided'}), 400
                
            # Unban the IP
            if self.security_manager:
                with self.security_manager.lock:
                    if ip_address in self.security_manager.ip_ban_list:
                        del self.security_manager.ip_ban_list[ip_address]
                        
                        # Log the unban
                        self.security_manager.audit_log_event(
                            'ip_unbanned',
                            f"IP unbanned by admin: {session.get('admin_username')}",
                            username=session.get('admin_username'),
                            ip_address=ip_address
                        )
                        
                        return jsonify({'success': True})
                    else:
                        return jsonify({'success': False, 'error': 'IP not banned'}), 404
            
            return jsonify({'success': False, 'error': 'Security manager not available'}), 500
        
        # Audit log route
        @self.app.route('/admin/audit_log')
        def admin_audit_log():
            # Check authentication
            if not self._is_authenticated():
                return redirect(url_for('admin_login'))
                
            # Get audit log
            audit_log = []
            
            if self.security_manager:
                # Get audit log
                audit_log = getattr(self.security_manager, 'audit_log', [])
                
                # Apply filters if provided
                event_type = request.args.get('event_type')
                if event_type:
                    audit_log = [event for event in audit_log if event.get('type') == event_type]
                    
                # Apply date range if provided
                start_time = request.args.get('start_time')
                if start_time:
                    try:
                        start_timestamp = int(start_time)
                        audit_log = [event for event in audit_log if event.get('timestamp', 0) >= start_timestamp]
                    except ValueError:
                        pass
                        
                end_time = request.args.get('end_time')
                if end_time:
                    try:
                        end_timestamp = int(end_time)
                        audit_log = [event for event in audit_log if event.get('timestamp', 0) <= end_timestamp]
                    except ValueError:
                        pass
                
                # Sort by timestamp (newest first)
                audit_log.sort(key=lambda event: event.get('timestamp', 0), reverse=True)
                
                # Paginate
                page = request.args.get('page', 1, type=int)
                per_page = request.args.get('per_page', 50, type=int)
                
                total_pages = (len(audit_log) + per_page - 1) // per_page
                start_idx = (page - 1) * per_page
                end_idx = start_idx + per_page
                
                paginated_log = audit_log[start_idx:end_idx]
            
            return render_template(
                'admin/audit_log.html',
                audit_log=paginated_log,
                page=page,
                total_pages=total_pages,
                csrf_token=session.get('csrf_token')
            )
        
        # Node restart/stop routes (if node control enabled)
        if self.config['node_control_enabled']:
            @self.app.route('/admin/control')
            def admin_control():
                # Check authentication
                if not self._is_authenticated():
                    return redirect(url_for('admin_login'))
                    
                return render_template(
                    'admin/control.html',
                    csrf_token=session.get('csrf_token')
                )
                
            @self.app.route('/admin/api/control/restart', methods=['POST'])
            def admin_restart_node():
                # Check authentication
                if not self._is_authenticated():
                    return jsonify({'success': False, 'error': 'Not authenticated'}), 401
                    
                # Verify CSRF token
                csrf_token = request.form.get('csrf_token')
                if not self.security_manager.verify_csrf_token(csrf_token):
                    return jsonify({'success': False, 'error': 'Invalid CSRF token'}), 403
                    
                # Log the restart
                self.security_manager.audit_log_event(
                    'node_restart',
                    f"Node restart initiated by admin: {session.get('admin_username')}",
                    username=session.get('admin_username')
                )
                
                # Schedule restart (in a separate thread to allow response)
                threading.Thread(target=self._restart_node).start()
                
                return jsonify({'success': True})
                
            @self.app.route('/admin/api/control/stop', methods=['POST'])
            def admin_stop_node():
                # Check authentication
                if not self._is_authenticated():
                    return jsonify({'success': False, 'error': 'Not authenticated'}), 401
                    
                # Verify CSRF token
                csrf_token = request.form.get('csrf_token')
                if not self.security_manager.verify_csrf_token(csrf_token):
                    return jsonify({'success': False, 'error': 'Invalid CSRF token'}), 403
                    
                # Log the stop
                self.security_manager.audit_log_event(
                    'node_stop',
                    f"Node stop initiated by admin: {session.get('admin_username')}",
                    username=session.get('admin_username')
                )
                
                # Schedule stop (in a separate thread to allow response)
                threading.Thread(target=self._stop_node).start()
                
                return jsonify({'success': True})
    
    def _is_authenticated(self) -> bool:
        """
        Check if the current session is authenticated.
        
        Returns:
            True if authenticated, False otherwise
        """
        # Check if session has admin_authenticated flag
        if not session.get('admin_authenticated', False):
            return False
            
        # Check if session has expired
        expiry = session.get('admin_expiry', 0)
        if time.time() > expiry:
            # Session expired, clear it
            session.pop('admin_authenticated', None)
            session.pop('admin_username', None)
            session.pop('admin_expiry', None)
            session.pop('csrf_token', None)
            return False
            
        # Check IP whitelist
        client_ip = request.remote_addr
        if not self._is_ip_allowed(client_ip):
            # IP not allowed, clear session
            session.pop('admin_authenticated', None)
            session.pop('admin_username', None)
            session.pop('admin_expiry', None)
            session.pop('csrf_token', None)
            return False
            
        return True
    
    def _is_ip_allowed(self, ip_address: str) -> bool:
        """
        Check if an IP address is allowed to access the admin dashboard.
        
        Args:
            ip_address: IP address to check
            
        Returns:
            True if allowed, False otherwise
        """
        # If no allowed IPs configured, allow all
        if not self.config['admin_allowed_ips'] or not self.config['admin_allowed_ips'][0]:
            return True
            
        # Check if IP is in allowed list
        for allowed_ip in self.config['admin_allowed_ips']:
            if ip_address == allowed_ip or allowed_ip == '*':
                return True
                
            # Check CIDR notation
            if '/' in allowed_ip:
                try:
                    import ipaddress
                    if ipaddress.ip_address(ip_address) in ipaddress.ip_network(allowed_ip, strict=False):
                        return True
                except Exception:
                    pass
        
        return False
    
    def _check_credentials(self, username: str, password: str) -> bool:
        """
        Check admin credentials.
        
        Args:
            username: Username to check
            password: Password to check
            
        Returns:
            True if credentials are valid, False otherwise
        """
        # Check username
        if username != self.config['admin_username']:
            return False
            
        # Check password hash
        password_hash = self._hash_password(password)
        return password_hash == self.config['admin_password_hash']
    
    def _hash_password(self, password: str) -> str:
        """
        Hash a password for comparison with stored hash.
        
        Args:
            password: Password to hash
            
        Returns:
            Hashed password
        """
        # Simple SHA-256 hash (in production, use proper password hashing with salt)
        return hashlib.sha256(password.encode()).hexdigest()
    
    def _verify_2fa(self, username: str, totp_code: str) -> bool:
        """
        Verify a 2FA code.
        
        Args:
            username: Username
            totp_code: TOTP code to verify
            
        Returns:
            True if code is valid, False otherwise
        """
        # Not implemented in this basic version
        # In a real implementation, you would verify the TOTP code
        # using a library like pyotp
        return True
    
    def _get_current_config(self) -> Dict[str, Any]:
        """
        Get current node configuration.
        
        Returns:
            Dictionary with configuration values
        """
        # This would depend on the specific configuration system
        # In a real implementation, you would get the actual configuration
        return {
            'network': 'testnet',
            'max_peers': 10,
            'sync_interval': 60,
        }
    
    def _apply_configuration(self, new_config: Dict[str, Any]) -> bool:
        """
        Apply new configuration values.
        
        Args:
            new_config: Dictionary with new configuration values
            
        Returns:
            True if successful, False otherwise
        """
        # This would depend on the specific configuration system
        # In a real implementation, you would apply the configuration changes
        return True
    
    def _get_network_info(self) -> Dict[str, Any]:
        """
        Get network information.
        
        Returns:
            Dictionary with network information
        """
        # This would depend on the specific network module
        # In a real implementation, you would get actual network information
        return {
            'peers': [],
            'connected_peers': 0,
            'outgoing_connections': 0,
            'incoming_connections': 0,
        }
    
    def _get_blockchain_data(self) -> Dict[str, Any]:
        """
        Get blockchain data for explorer.
        
        Returns:
            Dictionary with blockchain data
        """
        # This would depend on the specific blockchain module
        # In a real implementation, you would get actual blockchain data
        return {
            'blocks': [],
            'transactions': [],
            'height': 0,
        }
    
    def _get_block_data(self, height: int) -> Optional[Dict[str, Any]]:
        """
        Get data for a specific block.
        
        Args:
            height: Block height
            
        Returns:
            Dictionary with block data or None if not found
        """
        # This would depend on the specific blockchain module
        # In a real implementation, you would get actual block data
        return None
    
    def _get_transaction_data(self, tx_id: str) -> Optional[Dict[str, Any]]:
        """
        Get data for a specific transaction.
        
        Args:
            tx_id: Transaction ID
            
        Returns:
            Dictionary with transaction data or None if not found
        """
        # This would depend on the specific blockchain module
        # In a real implementation, you would get actual transaction data
        return None
    
    def _restart_node(self):
        """Restart the node (implementation-specific)."""
        # This would depend on the specific node implementation
        # In a real implementation, you would restart the node
        logging.info("Node restart requested by admin")
        
        # Example implementation: wait a moment then exit process
        time.sleep(2)
        os._exit(42)  # Exit code 42 tells supervisor to restart the process
    
    def _stop_node(self):
        """Stop the node (implementation-specific)."""
        # This would depend on the specific node implementation
        # In a real implementation, you would stop the node
        logging.info("Node stop requested by admin")
        
        # Example implementation: wait a moment then exit process
        time.sleep(2)
        os._exit(0)

# Helper function to initialize the admin dashboard
def init_admin_dashboard(app: Flask, config=None) -> AdminDashboard:
    """
    Initialize the admin dashboard with a Flask app.
    
    Args:
        app: Flask application instance
        config: Optional configuration
        
    Returns:
        AdminDashboard instance
    """
    return AdminDashboard(app, config)