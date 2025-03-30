#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: monitoring.py
Monitoring system for QNet nodes
"""

import os
import json
import logging
import time
import threading
import socket
import psutil
import requests
from typing import Dict, Any, List, Optional, Union, Set, Tuple
from dataclasses import dataclass, field, asdict
import queue

# Define metric types
@dataclass
class SystemMetrics:
    """System-level metrics for node monitoring."""
    timestamp: int = 0
    cpu_percent: float = 0.0
    memory_percent: float = 0.0
    disk_usage_percent: float = 0.0
    network_sent_bytes: int = 0
    network_recv_bytes: int = 0
    open_file_descriptors: int = 0
    uptime_seconds: int = 0
    load_average: List[float] = field(default_factory=lambda: [0.0, 0.0, 0.0])

@dataclass
class BlockchainMetrics:
    """Blockchain-specific metrics for node monitoring."""
    timestamp: int = 0
    chain_height: int = 0
    pending_transactions: int = 0
    peers_count: int = 0
    last_block_time: int = 0
    consensus_phase: str = "unknown"
    sync_status: str = "unknown"
    sync_percent: float = 0.0
    block_processing_time_ms: float = 0.0
    tps: float = 0.0  # Transactions per second

@dataclass
class NodeAlert:
    """Alert data structure for node issues."""
    timestamp: int = 0
    level: str = "info"  # info, warning, error, critical
    message: str = ""
    source: str = ""
    resolved: bool = False
    resolution_timestamp: int = 0
    data: Dict[str, Any] = field(default_factory=dict)

class QNetMonitor:
    """
    Monitoring system for QNet nodes.
    Collects system and blockchain metrics, generates alerts,
    and provides a dashboard API.
    """
    
    def __init__(self, config=None, blockchain=None):
        """
        Initialize the monitoring system.
        
        Args:
            config: Configuration object or dictionary
            blockchain: Blockchain instance to monitor
        """
        # Default configuration
        self.config = {
            'enabled': os.environ.get('QNET_MONITORING_ENABLED', 'true').lower() == 'true',
            'metrics_interval_seconds': int(os.environ.get('QNET_METRICS_INTERVAL', '10')),
            'metrics_retention_hours': int(os.environ.get('QNET_METRICS_RETENTION', '24')),
            'alert_check_interval_seconds': int(os.environ.get('QNET_ALERT_CHECK_INTERVAL', '30')),
            'metrics_history_file': os.environ.get('QNET_METRICS_HISTORY_FILE', '/app/data/metrics_history.json'),
            'alerts_history_file': os.environ.get('QNET_ALERTS_HISTORY_FILE', '/app/data/alerts_history.json'),
            'webhook_url': os.environ.get('QNET_ALERT_WEBHOOK', ''),
            'prometheus_enabled': os.environ.get('QNET_PROMETHEUS_ENABLED', 'false').lower() == 'true',
            'prometheus_port': int(os.environ.get('QNET_PROMETHEUS_PORT', '9090')),
            'max_alerts_count': int(os.environ.get('QNET_MAX_ALERTS', '1000')),
            'max_metrics_points': int(os.environ.get('QNET_MAX_METRICS_POINTS', '8640')),  # 24h at 10s interval
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
        
        # Initialize blockchain reference
        self.blockchain = blockchain
        
        # Initialize metrics storage
        self.system_metrics_history: List[SystemMetrics] = []
        self.blockchain_metrics_history: List[BlockchainMetrics] = []
        self.alerts: List[NodeAlert] = []
        
        # Last metrics values for rate calculations
        self.last_system_metrics: Optional[SystemMetrics] = None
        self.last_blockchain_metrics: Optional[BlockchainMetrics] = None
        
        # Start time for uptime calculation
        self.start_time = int(time.time())
        
        # Monitoring threads
        self.metrics_thread = None
        self.alert_thread = None
        self.is_running = False
        
        # Alert queue for sending alerts asynchronously
        self.alert_queue = queue.Queue()
        
        # Load metrics and alerts history
        self._load_metrics_history()
        self._load_alerts_history()
        
        logging.info("QNet monitoring system initialized")
    
    def start(self):
        """Start monitoring threads."""
        if not self.config['enabled']:
            logging.info("Monitoring system is disabled")
            return
            
        if self.is_running:
            logging.warning("Monitoring system is already running")
            return
            
        self.is_running = True
        
        # Start metrics collection thread
        self.metrics_thread = threading.Thread(
            target=self._metrics_collection_loop,
            daemon=True
        )
        self.metrics_thread.start()
        
        # Start alert check thread
        self.alert_thread = threading.Thread(
            target=self._alert_check_loop,
            daemon=True
        )
        self.alert_thread.start()
        
        # Start alert sender thread
        self.alert_sender_thread = threading.Thread(
            target=self._alert_sender_loop,
            daemon=True
        )
        self.alert_sender_thread.start()
        
        # Start Prometheus exporter if enabled
        if self.config['prometheus_enabled']:
            try:
                from prometheus_client import start_http_server
                start_http_server(self.config['prometheus_port'])
                logging.info(f"Prometheus metrics server started on port {self.config['prometheus_port']}")
            except ImportError:
                logging.warning("Prometheus client not available. Prometheus metrics disabled.")
                self.config['prometheus_enabled'] = False
        
        logging.info("Monitoring system started")
    
    def stop(self):
        """Stop monitoring threads."""
        if not self.is_running:
            return
            
        self.is_running = False
        
        # Save metrics and alerts
        self._save_metrics_history()
        self._save_alerts_history()
        
        # Wait for threads to stop
        if self.metrics_thread and self.metrics_thread.is_alive():
            self.metrics_thread.join(timeout=1.0)
            
        if self.alert_thread and self.alert_thread.is_alive():
            self.alert_thread.join(timeout=1.0)
            
        if self.alert_sender_thread and self.alert_sender_thread.is_alive():
            self.alert_sender_thread.join(timeout=1.0)
            
        logging.info("Monitoring system stopped")
    
    def _metrics_collection_loop(self):
        """Main loop for metrics collection."""
        while self.is_running:
            try:
                # Collect metrics
                system_metrics = self._collect_system_metrics()
                blockchain_metrics = self._collect_blockchain_metrics()
                
                # Store metrics
                self.system_metrics_history.append(system_metrics)
                self.blockchain_metrics_history.append(blockchain_metrics)
                
                # Update last metrics
                self.last_system_metrics = system_metrics
                self.last_blockchain_metrics = blockchain_metrics
                
                # Trim metrics history if needed
                if len(self.system_metrics_history) > self.config['max_metrics_points']:
                    self.system_metrics_history = self.system_metrics_history[-self.config['max_metrics_points']:]
                    
                if len(self.blockchain_metrics_history) > self.config['max_metrics_points']:
                    self.blockchain_metrics_history = self.blockchain_metrics_history[-self.config['max_metrics_points']:]
                
                # Export to Prometheus if enabled
                if self.config['prometheus_enabled']:
                    self._export_metrics_to_prometheus(system_metrics, blockchain_metrics)
                
                # Sleep until next collection
                time.sleep(self.config['metrics_interval_seconds'])
            except Exception as e:
                logging.error(f"Error in metrics collection: {e}")
                time.sleep(5)  # Sleep on error to prevent tight loop
    
    def _alert_check_loop(self):
        """Main loop for alert checking."""
        while self.is_running:
            try:
                self._check_alerts()
                time.sleep(self.config['alert_check_interval_seconds'])
            except Exception as e:
                logging.error(f"Error in alert checking: {e}")
                time.sleep(5)  # Sleep on error to prevent tight loop
    
    def _alert_sender_loop(self):
        """Loop for sending alerts from the queue."""
        while self.is_running:
            try:
                # Get alert from queue with timeout
                try:
                    alert = self.alert_queue.get(timeout=1.0)
                except queue.Empty:
                    continue
                    
                # Try to send the alert
                self._send_alert(alert)
                
                # Mark as done
                self.alert_queue.task_done()
            except Exception as e:
                logging.error(f"Error in alert sender: {e}")
                time.sleep(1)  # Sleep on error to prevent tight loop
    
    def _collect_system_metrics(self) -> SystemMetrics:
        """
        Collect system metrics.
        
        Returns:
            SystemMetrics object with current values
        """
        metrics = SystemMetrics()
        metrics.timestamp = int(time.time())
        
        try:
            # CPU usage
            metrics.cpu_percent = psutil.cpu_percent(interval=0.5)
            
            # Memory usage
            memory = psutil.virtual_memory()
            metrics.memory_percent = memory.percent
            
            # Disk usage
            disk = psutil.disk_usage('/')
            metrics.disk_usage_percent = disk.percent
            
            # Network stats
            network = psutil.net_io_counters()
            metrics.network_sent_bytes = network.bytes_sent
            metrics.network_recv_bytes = network.bytes_recv
            
            # Open files
            metrics.open_file_descriptors = len(psutil.Process().open_files())
            
            # Uptime
            metrics.uptime_seconds = int(time.time()) - self.start_time
            
            # Load average
            metrics.load_average = [x / psutil.cpu_count() * 100 for x in psutil.getloadavg()]
        except Exception as e:
            logging.error(f"Error collecting system metrics: {e}")
        
        return metrics
    
    def _collect_blockchain_metrics(self) -> BlockchainMetrics:
        """
        Collect blockchain metrics.
        
        Returns:
            BlockchainMetrics object with current values
        """
        metrics = BlockchainMetrics()
        metrics.timestamp = int(time.time())
        
        # If no blockchain reference, return default metrics
        if not self.blockchain:
            return metrics
            
        try:
            # Chain height
            if hasattr(self.blockchain, 'chain'):
                metrics.chain_height = len(self.blockchain.chain)
            elif hasattr(self.blockchain, 'height'):
                metrics.chain_height = self.blockchain.height
            elif hasattr(self.blockchain, 'get_height'):
                metrics.chain_height = self.blockchain.get_height()
            
            # Last block time
            if metrics.chain_height > 0:
                if hasattr(self.blockchain, 'chain') and len(self.blockchain.chain) > 0:
                    last_block = self.blockchain.chain[-1]
                    if hasattr(last_block, 'header') and hasattr(last_block.header, 'timestamp'):
                        metrics.last_block_time = last_block.header.timestamp
                    elif hasattr(last_block, 'timestamp'):
                        metrics.last_block_time = last_block.timestamp
                elif hasattr(self.blockchain, 'get_latest_block'):
                    last_block = self.blockchain.get_latest_block()
                    if last_block:
                        if hasattr(last_block, 'header') and hasattr(last_block.header, 'timestamp'):
                            metrics.last_block_time = last_block.header.timestamp
                        elif hasattr(last_block, 'timestamp'):
                            metrics.last_block_time = last_block.timestamp
            
            # Pending transactions
            if hasattr(self.blockchain, 'pending_transactions'):
                metrics.pending_transactions = len(self.blockchain.pending_transactions)
            elif hasattr(self.blockchain, 'mempool'):
                metrics.pending_transactions = len(self.blockchain.mempool)
            
            # Peers count
            if hasattr(self.blockchain, 'peers'):
                metrics.peers_count = len(self.blockchain.peers)
            elif hasattr(self.blockchain, 'get_peers_count'):
                metrics.peers_count = self.blockchain.get_peers_count()
            
            # Consensus phase
            try:
                from consensus import get_consensus
                consensus = get_consensus()
                if hasattr(consensus, 'round_state') and 'phase' in consensus.round_state:
                    metrics.consensus_phase = consensus.round_state['phase']
            except (ImportError, AttributeError) as e:
                logging.debug(f"Unable to get consensus phase: {e}")
            
            # Calculate TPS
            if self.last_blockchain_metrics:
                time_diff = metrics.timestamp - self.last_blockchain_metrics.timestamp
                if time_diff > 0:
                    tx_diff = metrics.pending_transactions - self.last_blockchain_metrics.pending_transactions
                    metrics.tps = abs(tx_diff) / time_diff
        except Exception as e:
            logging.error(f"Error collecting blockchain metrics: {e}")
        
        return metrics
    
    def _check_alerts(self):
        """Check all alert conditions."""
        # Skip if no metrics collected yet
        if not self.last_system_metrics or not self.last_blockchain_metrics:
            return
            
        # System alerts
        self._check_system_alerts(self.last_system_metrics)
        
        # Blockchain alerts
        self._check_blockchain_alerts(self.last_blockchain_metrics)
    
    def _check_system_alerts(self, metrics: SystemMetrics):
        """
        Check system metrics for alert conditions.
        
        Args:
            metrics: Current system metrics
        """
        # High CPU usage alert
        if metrics.cpu_percent > 90:
            self.add_alert(
                level="warning",
                message=f"High CPU usage: {metrics.cpu_percent:.1f}%",
                source="system",
                data={"cpu_percent": metrics.cpu_percent}
            )
            
        # High memory usage alert
        if metrics.memory_percent > 90:
            self.add_alert(
                level="warning",
                message=f"High memory usage: {metrics.memory_percent:.1f}%",
                source="system",
                data={"memory_percent": metrics.memory_percent}
            )
            
        # High disk usage alert
        if metrics.disk_usage_percent > 90:
            self.add_alert(
                level="warning",
                message=f"High disk usage: {metrics.disk_usage_percent:.1f}%",
                source="system",
                data={"disk_usage_percent": metrics.disk_usage_percent}
            )
            
        # Extremely high load average alert
        if metrics.load_average[0] > 95:  # 1-minute load average > 95%
            self.add_alert(
                level="error",
                message=f"Extremely high system load: {metrics.load_average[0]:.1f}%",
                source="system",
                data={"load_average": metrics.load_average}
            )
    
    def _check_blockchain_alerts(self, metrics: BlockchainMetrics):
        """
        Check blockchain metrics for alert conditions.
        
        Args:
            metrics: Current blockchain metrics
        """
        # No peers alert
        if metrics.peers_count == 0:
            self.add_alert(
                level="warning",
                message="Node has no connected peers",
                source="blockchain",
                data={"peers_count": 0}
            )
            
        # No recent blocks alert
        if metrics.chain_height > 0 and metrics.last_block_time > 0:
            time_since_last_block = int(time.time()) - metrics.last_block_time
            if time_since_last_block > 300:  # More than 5 minutes
                self.add_alert(
                    level="warning",
                    message=f"No new blocks for {time_since_last_block // 60} minutes",
                    source="blockchain",
                    data={
                        "time_since_last_block": time_since_last_block,
                        "last_block_time": metrics.last_block_time
                    }
                )
        
        # Fork detection
        if hasattr(self.blockchain, 'fork_count') and self.blockchain.fork_count > 0:
            self.add_alert(
                level="error",
                message=f"Chain fork detected ({self.blockchain.fork_count} blocks)",
                source="blockchain",
                data={"fork_count": self.blockchain.fork_count}
            )
            
        # Consensus stalled alert
        if metrics.consensus_phase == "stalled":
            self.add_alert(
                level="error",
                message="Consensus mechanism is stalled",
                source="blockchain",
                data={"consensus_phase": metrics.consensus_phase}
            )
    
    def add_alert(self, level: str, message: str, source: str, data: Dict[str, Any] = None):
        """
        Add a new alert.
        
        Args:
            level: Alert level (info, warning, error, critical)
            message: Alert message
            source: Alert source (system, blockchain, etc.)
            data: Additional alert data
        """
        # Check if similar alert already exists and is not resolved
        for alert in self.alerts:
            if (
                alert.level == level and
                alert.source == source and
                alert.message == message and
                not alert.resolved
            ):
                # Similar alert exists, don't add duplicate
                return
                
        # Create new alert
        alert = NodeAlert(
            timestamp=int(time.time()),
            level=level,
            message=message,
            source=source,
            resolved=False,
            data=data or {}
        )
        
        # Add to alerts list
        self.alerts.append(alert)
        
        # Trim alerts list if needed
        if len(self.alerts) > self.config['max_alerts_count']:
            # Remove oldest non-critical alerts first
            non_critical_indexes = [
                i for i, a in enumerate(self.alerts)
                if a.level != "critical" and a.resolved
            ]
            
            if non_critical_indexes:
                # Remove oldest resolved non-critical alert
                self.alerts.pop(non_critical_indexes[0])
            else:
                # Just remove oldest alert
                self.alerts.pop(0)
        
        # Log alert
        log_method = getattr(logging, level, logging.warning)
        log_method(f"Alert: {message} (Source: {source})")
        
        # Add to send queue
        self.alert_queue.put(alert)
    
    def resolve_alert(self, alert_index: int):
        """
        Mark an alert as resolved.
        
        Args:
            alert_index: Index of the alert to resolve
        """
        if 0 <= alert_index < len(self.alerts):
            alert = self.alerts[alert_index]
            if not alert.resolved:
                alert.resolved = True
                alert.resolution_timestamp = int(time.time())
                logging.info(f"Alert resolved: {alert.message}")
    
    def _send_alert(self, alert: NodeAlert):
        """
        Send alert to configured destinations.
        
        Args:
            alert: Alert to send
        """
        # Skip if no webhook configured
        if not self.config['webhook_url']:
            return
            
        # Prepare alert payload
        payload = asdict(alert)
        
        # Add node identifier if available
        if hasattr(self, 'node_id'):
            payload['node_id'] = self.node_id
            
        try:
            # Send to webhook
            response = requests.post(
                self.config['webhook_url'],
                json=payload,
                headers={'Content-Type': 'application/json'},
                timeout=5.0
            )
            
            if response.status_code != 200:
                logging.warning(f"Failed to send alert to webhook: {response.status_code} {response.text}")
                
        except Exception as e:
            logging.warning(f"Error sending alert to webhook: {e}")
    
    def _load_metrics_history(self):
        """Load metrics history from file."""
        # Skip if file doesn't exist
        if not os.path.exists(self.config['metrics_history_file']):
            return
            
        try:
            with open(self.config['metrics_history_file'], 'r') as f:
                data = json.load(f)
                
                # Load system metrics
                if 'system_metrics' in data:
                    self.system_metrics_history = [
                        SystemMetrics(**m) for m in data['system_metrics']
                    ]
                    
                # Load blockchain metrics
                if 'blockchain_metrics' in data:
                    self.blockchain_metrics_history = [
                        BlockchainMetrics(**m) for m in data['blockchain_metrics']
                    ]
                    
                logging.info(f"Loaded metrics history: {len(self.system_metrics_history)} system, {len(self.blockchain_metrics_history)} blockchain")
        except Exception as e:
            logging.error(f"Error loading metrics history: {e}")
    
    def _save_metrics_history(self):
        """Save metrics history to file."""
        try:
            # Ensure directory exists
            os.makedirs(os.path.dirname(self.config['metrics_history_file']), exist_ok=True)
            
            # Prepare data
            data = {
                'system_metrics': [asdict(m) for m in self.system_metrics_history],
                'blockchain_metrics': [asdict(m) for m in self.blockchain_metrics_history]
            }
            
            # Save to file
            with open(self.config['metrics_history_file'], 'w') as f:
                json.dump(data, f)
                
            logging.info(f"Saved metrics history to {self.config['metrics_history_file']}")
        except Exception as e:
            logging.error(f"Error saving metrics history: {e}")
    
    def _load_alerts_history(self):
        """Load alerts history from file."""
        # Skip if file doesn't exist
        if not os.path.exists(self.config['alerts_history_file']):
            return
            
        try:
            with open(self.config['alerts_history_file'], 'r') as f:
                data = json.load(f)
                
                # Load alerts
                if 'alerts' in data:
                    self.alerts = [
                        NodeAlert(**a) for a in data['alerts']
                    ]
                    
                logging.info(f"Loaded alerts history: {len(self.alerts)} alerts")
        except Exception as e:
            logging.error(f"Error loading alerts history: {e}")
    
    def _save_alerts_history(self):
        """Save alerts history to file."""
        try:
            # Ensure directory exists
            os.makedirs(os.path.dirname(self.config['alerts_history_file']), exist_ok=True)
            
            # Prepare data
            data = {
                'alerts': [asdict(a) for a in self.alerts]
            }
            
            # Save to file
            with open(self.config['alerts_history_file'], 'w') as f:
                json.dump(data, f)
                
            logging.info(f"Saved alerts history to {self.config['alerts_history_file']}")
        except Exception as e:
            logging.error(f"Error saving alerts history: {e}")
    
    def _export_metrics_to_prometheus(self, system_metrics: SystemMetrics, blockchain_metrics: BlockchainMetrics):
        """
        Export metrics to Prometheus.
        
        Args:
            system_metrics: Current system metrics
            blockchain_metrics: Current blockchain metrics
        """
        try:
            from prometheus_client import Gauge
            
            # Create gauges for system metrics if not exists
            if not hasattr(self, 'prometheus_system_gauges'):
                self.prometheus_system_gauges = {
                    'cpu_percent': Gauge('qnet_system_cpu_percent', 'CPU usage in percent'),
                    'memory_percent': Gauge('qnet_system_memory_percent', 'Memory usage in percent'),
                    'disk_usage_percent': Gauge('qnet_system_disk_usage_percent', 'Disk usage in percent'),
                    'network_sent_bytes': Gauge('qnet_system_network_sent_bytes', 'Network bytes sent'),
                    'network_recv_bytes': Gauge('qnet_system_network_recv_bytes', 'Network bytes received'),
                    'open_file_descriptors': Gauge('qnet_system_open_file_descriptors', 'Open file descriptors'),
                    'uptime_seconds': Gauge('qnet_system_uptime_seconds', 'Node uptime in seconds'),
                    'load_average_1m': Gauge('qnet_system_load_average_1m', '1 minute load average in percent'),
                    'load_average_5m': Gauge('qnet_system_load_average_5m', '5 minute load average in percent'),
                    'load_average_15m': Gauge('qnet_system_load_average_15m', '15 minute load average in percent'),
                }
                
            # Create gauges for blockchain metrics if not exists
            if not hasattr(self, 'prometheus_blockchain_gauges'):
                self.prometheus_blockchain_gauges = {
                    'chain_height': Gauge('qnet_blockchain_height', 'Blockchain height'),
                    'pending_transactions': Gauge('qnet_blockchain_pending_transactions', 'Pending transactions count'),
                    'peers_count': Gauge('qnet_blockchain_peers_count', 'Connected peers count'),
                    'time_since_last_block': Gauge('qnet_blockchain_time_since_last_block', 'Time since last block in seconds'),
                    'tps': Gauge('qnet_blockchain_tps', 'Transactions per second'),
                }
                
            # Update system metrics gauges
            self.prometheus_system_gauges['cpu_percent'].set(system_metrics.cpu_percent)
            self.prometheus_system_gauges['memory_percent'].set(system_metrics.memory_percent)
            self.prometheus_system_gauges['disk_usage_percent'].set(system_metrics.disk_usage_percent)
            self.prometheus_system_gauges['network_sent_bytes'].set(system_metrics.network_sent_bytes)
            self.prometheus_system_gauges['network_recv_bytes'].set(system_metrics.network_recv_bytes)
            self.prometheus_system_gauges['open_file_descriptors'].set(system_metrics.open_file_descriptors)
            self.prometheus_system_gauges['uptime_seconds'].set(system_metrics.uptime_seconds)
            
            # Update load average gauges
            if len(system_metrics.load_average) >= 3:
                self.prometheus_system_gauges['load_average_1m'].set(system_metrics.load_average[0])
                self.prometheus_system_gauges['load_average_5m'].set(system_metrics.load_average[1])
                self.prometheus_system_gauges['load_average_15m'].set(system_metrics.load_average[2])
                
            # Update blockchain metrics gauges
            self.prometheus_blockchain_gauges['chain_height'].set(blockchain_metrics.chain_height)
            self.prometheus_blockchain_gauges['pending_transactions'].set(blockchain_metrics.pending_transactions)
            self.prometheus_blockchain_gauges['peers_count'].set(blockchain_metrics.peers_count)
            
            # Calculate time since last block
            if blockchain_metrics.last_block_time > 0:
                time_since_last_block = int(time.time()) - blockchain_metrics.last_block_time
                self.prometheus_blockchain_gauges['time_since_last_block'].set(time_since_last_block)
                
            self.prometheus_blockchain_gauges['tps'].set(blockchain_metrics.tps)
            
        except Exception as e:
            logging.error(f"Error exporting metrics to Prometheus: {e}")
    
    def get_metrics(self, time_range_seconds: int = 3600) -> Dict[str, Any]:
        """
        Get metrics for the specified time range.
        
        Args:
            time_range_seconds: Time range in seconds (default: 1 hour)
            
        Returns:
            Dictionary with system and blockchain metrics
        """
        current_time = int(time.time())
        start_time = current_time - time_range_seconds
        
        # Filter metrics by time range
        system_metrics = [
            asdict(m) for m in self.system_metrics_history
            if m.timestamp >= start_time
        ]
        
        blockchain_metrics = [
            asdict(m) for m in self.blockchain_metrics_history
            if m.timestamp >= start_time
        ]
        
        return {
            'system_metrics': system_metrics,
            'blockchain_metrics': blockchain_metrics,
            'start_time': start_time,
            'end_time': current_time
        }
    
    def get_alerts(self, include_resolved: bool = False) -> List[Dict[str, Any]]:
        """
        Get all alerts.
        
        Args:
            include_resolved: Include resolved alerts
            
        Returns:
            List of alert dictionaries
        """
        return [
            asdict(a) for a in self.alerts
            if include_resolved or not a.resolved
        ]
    
    def get_system_status(self) -> Dict[str, Any]:
        """
        Get overall system status summary.
        
        Returns:
            Dictionary with system status
        """
        status = {
            'uptime': 0,
            'cpu_percent': 0,
            'memory_percent': 0,
            'disk_percent': 0,
            'active_alerts': 0,
            'critical_alerts': 0,
            'blockchain_height': 0,
            'peers': 0,
            'pending_transactions': 0,
            'last_block_age': None,
            'sync_status': 'unknown'
        }
        
        # Update with last metrics if available
        if self.last_system_metrics:
            status.update({
                'uptime': self.last_system_metrics.uptime_seconds,
                'cpu_percent': self.last_system_metrics.cpu_percent,
                'memory_percent': self.last_system_metrics.memory_percent,
                'disk_percent': self.last_system_metrics.disk_usage_percent,
            })
            
        if self.last_blockchain_metrics:
            status.update({
                'blockchain_height': self.last_blockchain_metrics.chain_height,
                'peers': self.last_blockchain_metrics.peers_count,
                'pending_transactions': self.last_blockchain_metrics.pending_transactions,
                'sync_status': self.last_blockchain_metrics.sync_status,
            })
            
            # Calculate last block age
            if self.last_blockchain_metrics.last_block_time > 0:
                status['last_block_age'] = int(time.time()) - self.last_blockchain_metrics.last_block_time
        
        # Count active and critical alerts
        active_alerts = 0
        critical_alerts = 0
        
        for alert in self.alerts:
            if not alert.resolved:
                active_alerts += 1
                if alert.level == 'critical':
                    critical_alerts += 1
        
        status['active_alerts'] = active_alerts
        status['critical_alerts'] = critical_alerts
        
        return status
    
    def audit_log_event(self, event_type: str, message: str, **kwargs):
        """
        Add an entry to the audit log.
        
        Args:
            event_type: Type of event
            message: Event message
            **kwargs: Additional event data
        """
        # Create info-level alert for important audit events
        if event_type in ['node_started', 'node_stopped', 'config_changed', 'upgrade_completed']:
            self.add_alert(
                level="info",
                message=message,
                source="audit",
                data=kwargs
            )
            
        # Log the event
        logging.info(f"Audit: {event_type} - {message}")


# Helper function to get singleton instance
_monitor_instance = None

def get_monitor(config=None, blockchain=None) -> QNetMonitor:
    """
    Get or create the singleton monitor instance.
    
    Args:
        config: Optional configuration
        blockchain: Optional blockchain instance
        
    Returns:
        QNetMonitor instance
    """
    global _monitor_instance
    if _monitor_instance is None:
        _monitor_instance = QNetMonitor(config, blockchain)
    return _monitor_instance