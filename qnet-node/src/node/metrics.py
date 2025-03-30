#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: metrics.py
Implements metrics collection, monitoring, and health reporting for QNet nodes.
"""

import os
import time
import json
import logging
import threading
import psutil
import socket
import platform
import tempfile
from collections import deque, defaultdict
import datetime
import requests

class MetricsManager:
    def __init__(self, config, node_address, blockchain=None, peers=None):
        """
        Initialize metrics manager
        
        Args:
            config: Configuration object
            node_address: Node address (IP:port)
            blockchain: Blockchain instance (optional)
            peers: Peers dictionary (optional)
        """
        self.config = config
        self.node_address = node_address
        self.blockchain = blockchain
        self.peers = peers
        
        # Default metrics retention (hours)
        self.retention_hours = 24
        
        # Metrics storage
        self.metrics_file = os.path.join(tempfile.gettempdir(), "qnet_metrics.json")
        
        # Initialize metrics
        self.system_metrics = {
            "cpu_percent": deque(maxlen=60*24),        # 24 hours at 1 minute intervals
            "memory_percent": deque(maxlen=60*24),     # 24 hours at 1 minute intervals
            "disk_usage": deque(maxlen=60*24),         # 24 hours at 1 minute intervals
            "network_in": deque(maxlen=60*24),         # 24 hours at 1 minute intervals
            "network_out": deque(maxlen=60*24),        # 24 hours at 1 minute intervals
            "uptime": 0
        }
        
        self.node_metrics = {
            "blockchain_height": deque(maxlen=60*24),     # 24 hours at 1 minute intervals
            "peer_count": deque(maxlen=60*24),            # 24 hours at 1 minute intervals
            "tx_count": deque(maxlen=60*24),              # 24 hours at 1 minute intervals 
            "pending_tx_count": deque(maxlen=60*24),      # 24 hours at 1 minute intervals
            "block_time": deque(maxlen=100),              # Last 100 blocks
            "consensus_rounds": deque(maxlen=100),        # Last 100 consensus rounds
            "sync_time": deque(maxlen=20)                 # Last 20 sync operations
        }
        
        # Performance metrics
        self.performance_metrics = {
            "tx_processing_time": deque(maxlen=100),      # Last 100 transactions
            "block_processing_time": deque(maxlen=20),    # Last 20 blocks
            "api_response_time": defaultdict(list)        # By endpoint
        }
        
        # Network metrics
        self.network_metrics = {
            "response_time": {},                          # By peer
            "success_rate": {},                           # By peer
            "bytes_sent": 0,
            "bytes_received": 0,
            "last_network_io": (0, 0)                     # Last measured network IO values
        }
        
        # Alert settings
        self.alerts = []
        self.alert_thresholds = {
            "cpu_percent": 90,
            "memory_percent": 85,
            "disk_usage": 90,
            "peer_count_low": 3,
            "no_new_blocks": 30*60,  # 30 minutes
            "sync_failure": True,
            "consensus_failure": True
        }
        
        # Start monitoring thread
        self.running = True
        self.monitoring_thread = threading.Thread(target=self._monitor_loop, daemon=True)
        self.monitoring_thread.start()
        
        # Try to load previous metrics
        self._load_metrics()
        
        logging.info("Metrics manager initialized")
    
    def _load_metrics(self):
        """Load metrics from file if it exists"""
        try:
            if os.path.exists(self.metrics_file):
                with open(self.metrics_file, 'r') as f:
                    data = json.load(f)
                
                # Process and keep only recent metrics
                now = time.time()
                cutoff = now - (self.retention_hours * 3600)
                
                for category in ['system_metrics', 'node_metrics']:
                    if category in data:
                        for key, values in data[category].items():
                            # Filter values by timestamp
                            filtered = [(t, v) for t, v in values if t > cutoff]
                            
                            if category == 'system_metrics' and key in self.system_metrics:
                                self.system_metrics[key] = deque(filtered, maxlen=self.system_metrics[key].maxlen)
                            elif category == 'node_metrics' and key in self.node_metrics:
                                self.node_metrics[key] = deque(filtered, maxlen=self.node_metrics[key].maxlen)
                
                logging.info("Loaded historical metrics")
        except Exception as e:
            logging.warning(f"Could not load historical metrics: {e}")
    
    def _save_metrics(self):
        """Save metrics to file"""
        try:
            # Convert metrics to serializable format
            metrics_data = {
                "system_metrics": {k: list(v) for k, v in self.system_metrics.items() if isinstance(v, deque)},
                "node_metrics": {k: list(v) for k, v in self.node_metrics.items() if isinstance(v, deque)},
                "last_updated": time.time()
            }
            
            with open(self.metrics_file, 'w') as f:
                json.dump(metrics_data, f)
                
            logging.debug("Saved metrics to file")
        except Exception as e:
            logging.warning(f"Could not save metrics: {e}")
    
    def _monitor_loop(self):
        """Background monitoring thread"""
        last_save = time.time()
        last_check_peers = time.time()
        
        while self.running:
            try:
                # Collect system metrics
                self._collect_system_metrics()
                
                # Collect node metrics if blockchain is available
                if self.blockchain is not None:
                    self._collect_node_metrics()
                
                # Check peer health every 5 minutes
                now = time.time()
                if now - last_check_peers >= 300:
                    if self.peers is not None:
                        self._check_peer_health()
                    last_check_peers = now
                
                # Check for alerts
                self._check_alerts()
                
                # Save metrics every 15 minutes
                if now - last_save >= 900:
                    self._save_metrics()
                    last_save = now
            
            except Exception as e:
                logging.error(f"Error in metrics monitoring: {e}")
                
            # Sleep for 60 seconds
            time.sleep(60)
    
    def _collect_system_metrics(self):
        """Collect system metrics"""
        now = time.time()
        try:
            # CPU usage
            cpu_percent = psutil.cpu_percent(interval=1)
            self.system_metrics["cpu_percent"].append((now, cpu_percent))
            
            # Memory usage
            memory = psutil.virtual_memory()
            self.system_metrics["memory_percent"].append((now, memory.percent))
            
            # Disk usage
            disk = psutil.disk_usage('/')
            self.system_metrics["disk_usage"].append((now, disk.percent))
            
            # Network I/O
            net_io = psutil.net_io_counters()
            bytes_sent, bytes_recv = net_io.bytes_sent, net_io.bytes_recv
            
            last_sent, last_recv = self.network_metrics["last_network_io"]
            
            # Calculate delta since last measurement
            if last_sent > 0 and last_recv > 0:
                delta_sent = bytes_sent - last_sent
                delta_recv = bytes_recv - last_recv
                
                # Store traffic in KB/s
                self.system_metrics["network_out"].append((now, delta_sent / 1024))
                self.system_metrics["network_in"].append((now, delta_recv / 1024))
                
                # Update total bytes
                self.network_metrics["bytes_sent"] += delta_sent
                self.network_metrics["bytes_received"] += delta_recv
            
            # Store current values for next comparison
            self.network_metrics["last_network_io"] = (bytes_sent, bytes_recv)
            
            # Update uptime
            self.system_metrics["uptime"] = time.time() - psutil.boot_time()
            
        except Exception as e:
            logging.error(f"Error collecting system metrics: {e}")
    
    def _collect_node_metrics(self):
        """Collect node-specific metrics"""
        now = time.time()
        try:
            # Blockchain height
            height = len(self.blockchain.chain) - 1
            self.node_metrics["blockchain_height"].append((now, height))
            
            # Peer count
            if self.peers is not None:
                peer_count = len(self.peers)
                self.node_metrics["peer_count"].append((now, peer_count))
            
            # Transaction count in pool
            tx_count = len(self.blockchain.transaction_pool)
            self.node_metrics["pending_tx_count"].append((now, tx_count))
            
            # Calculate total transactions across all blocks
            total_tx = 0
            for block in self.blockchain.chain:
                total_tx += len(block.transactions)
            self.node_metrics["tx_count"].append((now, total_tx))
            
            # Calculate average block time (for last 10 blocks)
            if len(self.blockchain.chain) > 10:
                last_blocks = self.blockchain.chain[-10:]
                times = [b.timestamp for b in last_blocks]
                time_diffs = [times[i] - times[i-1] for i in range(1, len(times))]
                avg_block_time = sum(time_diffs) / len(time_diffs) if time_diffs else 0
                self.node_metrics["block_time"].append((now, avg_block_time))
            
        except Exception as e:
            logging.error(f"Error collecting node metrics: {e}")
    
    def _check_peer_health(self):
        """Check peer health metrics"""
        try:
            for peer, last_seen in list(self.peers.items()):
                # Skip self
                if peer == self.node_address:
                    continue
                    
                # Measure response time
                try:
                    start_time = time.time()
                    response = requests.head(f"http://{peer}/", timeout=2)
                    end_time = time.time()
                    
                    if response.status_code == 200:
                        # Success, update response time
                        rtt = (end_time - start_time) * 1000  # ms
                        
                        # Initialize or update peer metrics
                        if peer not in self.network_metrics["response_time"]:
                            self.network_metrics["response_time"][peer] = deque(maxlen=20)
                            self.network_metrics["success_rate"][peer] = deque(maxlen=100)
                        
                        self.network_metrics["response_time"][peer].append((time.time(), rtt))
                        self.network_metrics["success_rate"][peer].append(1)  # Success
                    else:
                        # Failed response
                        if peer in self.network_metrics["success_rate"]:
                            self.network_metrics["success_rate"][peer].append(0)  # Failure
                
                except Exception:
                    # Connection failed
                    if peer in self.network_metrics["success_rate"]:
                        self.network_metrics["success_rate"][peer].append(0)  # Failure
        
        except Exception as e:
            logging.error(f"Error checking peer health: {e}")
    
    def _check_alerts(self):
        """Check for alert conditions"""
        try:
            # Clear old alerts first
            self.alerts = [a for a in self.alerts if time.time() - a['timestamp'] < 3600]  # Keep alerts for 1 hour
            
            # Check system metrics
            self._check_system_alerts()
            
            # Check node metrics
            self._check_node_alerts()
            
            # Check network metrics
            self._check_network_alerts()
            
        except Exception as e:
            logging.error(f"Error checking alerts: {e}")
    
    def _check_system_alerts(self):
        """Check system metric alerts"""
        # Check CPU usage
        if (self.system_metrics["cpu_percent"] and 
            self.system_metrics["cpu_percent"][-1][1] > self.alert_thresholds["cpu_percent"]):
            self._add_alert("high_cpu", f"High CPU usage: {self.system_metrics['cpu_percent'][-1][1]}%", "warning")
        
        # Check memory usage
        if (self.system_metrics["memory_percent"] and 
            self.system_metrics["memory_percent"][-1][1] > self.alert_thresholds["memory_percent"]):
            self._add_alert("high_memory", f"High memory usage: {self.system_metrics['memory_percent'][-1][1]}%", "warning")
        
        # Check disk usage
        if (self.system_metrics["disk_usage"] and 
            self.system_metrics["disk_usage"][-1][1] > self.alert_thresholds["disk_usage"]):
            self._add_alert("high_disk", f"High disk usage: {self.system_metrics['disk_usage'][-1][1]}%", "warning")
    
    def _check_node_alerts(self):
        """Check node metric alerts"""
        # Check peer count
        if (self.node_metrics["peer_count"] and 
            self.node_metrics["peer_count"][-1][1] < self.alert_thresholds["peer_count_low"]):
            self._add_alert("low_peers", f"Low peer count: {self.node_metrics['peer_count'][-1][1]}", "warning")
        
        # Check for consensus failure
        if hasattr(self.blockchain, 'consensus_manager') and self.blockchain.consensus_manager:
            try:
                latest_round = len(self.blockchain.chain)
                peers_in_round = len(self.blockchain.consensus_manager.reveals.get(latest_round, {}))
                
                if peers_in_round < 2:
                    self._add_alert("low_consensus", f"Low consensus participation: {peers_in_round} peers", "warning")
            except:
                pass
        
        # Check for stalled blockchain
        if self.node_metrics["blockchain_height"]:
            height_data = list(self.node_metrics["blockchain_height"])
            if len(height_data) >= 10:
                # Check if height has been constant for last 10 readings
                heights = [h[1] for h in height_data[-10:]]
                if len(set(heights)) == 1:
                    last_block_time = self.blockchain.chain[-1].timestamp if self.blockchain.chain else 0
                    time_since_block = time.time() - last_block_time
                    
                    if time_since_block > self.alert_thresholds["no_new_blocks"]:
                        self._add_alert("stalled_chain", f"No new blocks for {time_since_block/60:.1f} minutes", "error")
    
    def _check_network_alerts(self):
        """Check network-related alerts"""
        # Check for failing peers
        for peer, success_data in self.network_metrics["success_rate"].items():
            if len(success_data) >= 5:
                # Calculate success rate over last 5 requests
                recent_success = list(success_data)[-5:]
                success_rate = sum(recent_success) / len(recent_success)
                
                if success_rate < 0.6:  # Less than 60% success rate
                    self._add_alert("failing_peer", f"Peer {peer} has low availability ({success_rate*100:.0f}%)", "warning")
    
    def _add_alert(self, alert_type, message, severity="info"):
        """Add a new alert"""
        # Check if similar alert already exists
        for alert in self.alerts:
            if alert["type"] == alert_type and time.time() - alert["timestamp"] < 1800:  # 30 minutes
                # Update existing alert
                alert["count"] += 1
                alert["last_seen"] = time.time()
                alert["message"] = message  # Update with latest info
                return
        
        # Add new alert
        self.alerts.append({
            "type": alert_type,
            "message": message,
            "severity": severity,
            "timestamp": time.time(),
            "last_seen": time.time(),
            "count": 1
        })
        
        # Log alert
        log_func = logging.warning if severity == "warning" else logging.error if severity == "error" else logging.info
        log_func(f"Alert: {message}")
    
    def record_transaction_time(self, tx_hash, processing_time):
        """Record transaction processing time"""
        self.performance_metrics["tx_processing_time"].append((time.time(), tx_hash, processing_time))
    
    def record_block_time(self, block_height, processing_time):
        """Record block processing time"""
        self.performance_metrics["block_processing_time"].append((time.time(), block_height, processing_time))
    
    def record_api_time(self, endpoint, processing_time):
        """Record API endpoint response time"""
        if len(self.performance_metrics["api_response_time"][endpoint]) >= 100:
            self.performance_metrics["api_response_time"][endpoint].pop(0)
        self.performance_metrics["api_response_time"][endpoint].append((time.time(), processing_time))
    
    def record_sync_time(self, sync_type, duration, blocks_synced=0):
        """Record blockchain sync operation"""
        self.node_metrics["sync_time"].append((time.time(), sync_type, duration, blocks_synced))
    
    def get_node_health(self):
        """Get overall node health status"""
        try:
            health = {
                "status": "healthy",
                "uptime": self.system_metrics["uptime"],
                "blockchain_height": self.node_metrics["blockchain_height"][-1][1] if self.node_metrics["blockchain_height"] else 0,
                "peer_count": self.node_metrics["peer_count"][-1][1] if self.node_metrics["peer_count"] else 0,
                "cpu_percent": self.system_metrics["cpu_percent"][-1][1] if self.system_metrics["cpu_percent"] else 0,
                "memory_percent": self.system_metrics["memory_percent"][-1][1] if self.system_metrics["memory_percent"] else 0,
                "pending_transactions": self.node_metrics["pending_tx_count"][-1][1] if self.node_metrics["pending_tx_count"] else 0,
                "alerts": len(self.alerts)
            }
            
            # Determine status based on alerts
            if any(alert["severity"] == "error" for alert in self.alerts):
                health["status"] = "unhealthy"
            elif any(alert["severity"] == "warning" for alert in self.alerts):
                health["status"] = "degraded"
                
            return health
        except Exception as e:
            logging.error(f"Error getting node health: {e}")
            return {"status": "unknown", "error": str(e)}
    
    def get_system_metrics(self, time_range="1h"):
        """Get system metrics for specified time range"""
        try:
            # Calculate time cutoff
            now = time.time()
            if time_range == "1h":
                cutoff = now - 3600
            elif time_range == "6h":
                cutoff = now - 21600
            elif time_range == "24h":
                cutoff = now - 86400
            else:
                cutoff = now - 3600  # Default to 1 hour
            
            # Filter metrics by time range
            filtered_metrics = {}
            for key, values in self.system_metrics.items():
                if isinstance(values, deque):
                    filtered_metrics[key] = [(t, v) for t, v in values if t >= cutoff]
                else:
                    filtered_metrics[key] = values
            
            return filtered_metrics
        except Exception as e:
            logging.error(f"Error getting system metrics: {e}")
            return {}
    
    def get_node_metrics(self, time_range="1h"):
        """Get node metrics for specified time range"""
        try:
            # Calculate time cutoff
            now = time.time()
            if time_range == "1h":
                cutoff = now - 3600
            elif time_range == "6h":
                cutoff = now - 21600
            elif time_range == "24h":
                cutoff = now - 86400
            else:
                cutoff = now - 3600  # Default to 1 hour
            
            # Filter metrics by time range
            filtered_metrics = {}
            for key, values in self.node_metrics.items():
                if isinstance(values, deque):
                    filtered_metrics[key] = [(t, v) for t, v in values if t >= cutoff]
                else:
                    filtered_metrics[key] = values
            
            return filtered_metrics
        except Exception as e:
            logging.error(f"Error getting node metrics: {e}")
            return {}
    
    def get_performance_metrics(self):
        """Get performance metrics summary"""
        try:
            summary = {}
            
            # Average transaction processing time
            tx_times = [t[2] for t in self.performance_metrics["tx_processing_time"]]
            if tx_times:
                summary["avg_tx_time_ms"] = sum(tx_times) / len(tx_times)
                summary["min_tx_time_ms"] = min(tx_times)
                summary["max_tx_time_ms"] = max(tx_times)
            
            # Average block processing time
            block_times = [t[2] for t in self.performance_metrics["block_processing_time"]]
            if block_times:
                summary["avg_block_time_ms"] = sum(block_times) / len(block_times)
                summary["min_block_time_ms"] = min(block_times)
                summary["max_block_time_ms"] = max(block_times)
            
            # API response times
            api_summary = {}
            for endpoint, times in self.performance_metrics["api_response_time"].items():
                if times:
                    response_times = [t[1] for t in times]
                    api_summary[endpoint] = {
                        "avg_ms": sum(response_times) / len(response_times),
                        "min_ms": min(response_times),
                        "max_ms": max(response_times),
                        "samples": len(response_times)
                    }
            summary["api_response_times"] = api_summary
            
            return summary
        except Exception as e:
            logging.error(f"Error getting performance metrics: {e}")
            return {}
    
    def get_network_metrics(self):
        """Get network metrics summary"""
        try:
            summary = {
                "bytes_sent": self.network_metrics["bytes_sent"],
                "bytes_received": self.network_metrics["bytes_received"],
                "peer_response_times": {},
                "peer_success_rates": {}
            }
            
            # Process peer response times
            for peer, times in self.network_metrics["response_time"].items():
                if times:
                    rtt_values = [t[1] for t in times]
                    summary["peer_response_times"][peer] = {
                        "avg_ms": sum(rtt_values) / len(rtt_values),
                        "min_ms": min(rtt_values),
                        "max_ms": max(rtt_values)
                    }
            
            # Process peer success rates
            for peer, success_data in self.network_metrics["success_rate"].items():
                if success_data:
                    rate = sum(success_data) / len(success_data)
                    summary["peer_success_rates"][peer] = rate
            
            return summary
        except Exception as e:
            logging.error(f"Error getting network metrics: {e}")
            return {}
    
    def get_alerts(self, include_resolved=False):
        """Get current alerts"""
        try:
            # If include_resolved is False, only return active alerts (less than 1 hour old)
            if not include_resolved:
                now = time.time()
                active_alerts = [a for a in self.alerts if now - a["last_seen"] < 3600]
                return active_alerts
            else:
                return self.alerts
        except Exception as e:
            logging.error(f"Error getting alerts: {e}")
            return []
    
    def stop(self):
        """Stop metrics collection"""
        self.running = False
        if self.monitoring_thread and self.monitoring_thread.is_alive():
            self.monitoring_thread.join(timeout=2)
        self._save_metrics()
        logging.info("Metrics manager stopped")


# API endpoints for metrics
def register_metrics_endpoints(app, metrics_manager):
    """Register metrics API endpoints to Flask app"""
    
    @app.route('/api/v1/metrics/health', methods=['GET'])
    def get_health():
        """Get node health status"""
        health = metrics_manager.get_node_health()
        return json.dumps(health), 200, {'Content-Type': 'application/json'}
    
    @app.route('/api/v1/metrics/system', methods=['GET'])
    def get_system_metrics():
        """Get system metrics"""
        time_range = request.args.get('range', '1h')
        metrics = metrics_manager.get_system_metrics(time_range)
        return json.dumps(metrics), 200, {'Content-Type': 'application/json'}
    
    @app.route('/api/v1/metrics/node', methods=['GET'])
    def get_node_metrics():
        """Get node metrics"""
        time_range = request.args.get('range', '1h')
        metrics = metrics_manager.get_node_metrics(time_range)
        return json.dumps(metrics), 200, {'Content-Type': 'application/json'}
    
    @app.route('/api/v1/metrics/performance', methods=['GET'])
    def get_performance_metrics():
        """Get performance metrics"""
        metrics = metrics_manager.get_performance_metrics()
        return json.dumps(metrics), 200, {'Content-Type': 'application/json'}
    
    @app.route('/api/v1/metrics/network', methods=['GET'])
    def get_network_metrics():
        """Get network metrics"""
        metrics = metrics_manager.get_network_metrics()
        return json.dumps(metrics), 200, {'Content-Type': 'application/json'}
    
    @app.route('/api/v1/metrics/alerts', methods=['GET'])
    def get_alerts():
        """Get current alerts"""
        include_resolved = request.args.get('include_resolved', 'false').lower() == 'true'
        alerts = metrics_manager.get_alerts(include_resolved)
        return json.dumps(alerts), 200, {'Content-Type': 'application/json'}


# Flask middleware for API metrics
class MetricsMiddleware:
    def __init__(self, app, metrics_manager):
        self.app = app
        self.metrics_manager = metrics_manager
        self.app.before_request(self.before_request)
        self.app.after_request(self.after_request)
        
    def before_request(self):
        # Store start time in g
        from flask import g
        g.start_time = time.time()
        
    def after_request(self, response):
        from flask import g, request
        
        # Calculate response time
        if hasattr(g, 'start_time'):
            duration_ms = (time.time() - g.start_time) * 1000
            
            # Record API timing
            endpoint = request.endpoint or request.path
            self.metrics_manager.record_api_time(endpoint, duration_ms)
            
        return response