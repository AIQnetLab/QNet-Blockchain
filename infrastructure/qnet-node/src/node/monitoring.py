#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
QNet Node Monitoring - API Only (Production Simplified)
Simplified monitoring for QNet nodes - External API only.
Removed internal monitoring threads for production efficiency.
"""

import os
import json
import logging
import time
import psutil
from typing import Dict, Any, List, Optional
from dataclasses import dataclass, asdict

@dataclass
class NodeMetrics:
    """Essential node metrics for external monitoring."""
    timestamp: int = 0
    height: int = 0
    peers: int = 0
    mempool_size: int = 0
    tps: float = 0.0
    cpu_percent: float = 0.0
    memory_percent: float = 0.0
    uptime_seconds: int = 0

class QNetMonitoringAPI:
    """
    Simplified monitoring API for QNet nodes.
    Provides only external API methods - no internal monitoring threads.
    """
    
    def __init__(self, node_ref=None):
        """Initialize monitoring API."""
        self.node_ref = node_ref
        self.start_time = int(time.time())
        logging.info("QNet monitoring API initialized (simplified)")
    
    def get_current_metrics(self) -> NodeMetrics:
        """Get current node metrics on demand."""
        metrics = NodeMetrics()
        metrics.timestamp = int(time.time())
        
        try:
            # System metrics
            metrics.cpu_percent = psutil.cpu_percent(interval=0.1)
            metrics.memory_percent = psutil.virtual_memory().percent
            metrics.uptime_seconds = int(time.time()) - self.start_time
            
            # Node metrics (if node reference available)
            if self.node_ref:
                # In production: Get actual metrics from node
                metrics.height = getattr(self.node_ref, 'height', 0)
                metrics.peers = getattr(self.node_ref, 'peer_count', 0)
                metrics.mempool_size = getattr(self.node_ref, 'mempool_size', 0)
                metrics.tps = getattr(self.node_ref, 'current_tps', 0.0)
            
        except Exception as e:
            logging.error(f"Error collecting metrics: {e}")
        
        return metrics
    
    def get_metrics_json(self) -> str:
        """Get metrics as JSON string for API responses."""
        metrics = self.get_current_metrics()
        return json.dumps(asdict(metrics))
    
    def get_health_status(self) -> Dict[str, Any]:
        """Get node health status."""
        metrics = self.get_current_metrics()
        
        # Simple health checks
        is_healthy = (
            metrics.cpu_percent < 90.0 and
            metrics.memory_percent < 85.0 and
            metrics.peers > 0
        )
        
        return {
            "healthy": is_healthy,
            "cpu_ok": metrics.cpu_percent < 90.0,
            "memory_ok": metrics.memory_percent < 85.0,
            "peers_ok": metrics.peers > 0,
            "uptime": metrics.uptime_seconds,
            "last_check": metrics.timestamp
        }
    
    def get_performance_summary(self) -> Dict[str, Any]:
        """Get performance summary for dashboard."""
        metrics = self.get_current_metrics()
        
        return {
            "current_tps": metrics.tps,
            "microblock_height": metrics.height,
            "connected_peers": metrics.peers,
            "mempool_pending": metrics.mempool_size,
            "system_load": {
                "cpu": metrics.cpu_percent,
                "memory": metrics.memory_percent
            },
            "node_uptime": metrics.uptime_seconds,
            "timestamp": metrics.timestamp
        }

# Singleton instance for easy access
_api_instance = None

def get_monitoring_api(node_ref=None) -> QNetMonitoringAPI:
    """Get singleton monitoring API instance."""
    global _api_instance
    if _api_instance is None:
        _api_instance = QNetMonitoringAPI(node_ref)
    return _api_instance 