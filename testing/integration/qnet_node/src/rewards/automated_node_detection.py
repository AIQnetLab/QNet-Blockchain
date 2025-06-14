"""
Automated Node Detection for QNet Network
Network automatically determines: ping mobile device or server?
"""

import logging
from typing import Dict, Optional
from enum import Enum

logger = logging.getLogger(__name__)

class NodeType(Enum):
    LIGHT = "light"     # Ping mobile device
    FULL = "full"       # Ping server 
    SUPER = "super"     # Ping server

class NetworkPingRouter:
    """Network automatically determines what to ping for each node"""
    
    def determine_ping_target(self, node_id: str, registration_data: Dict) -> Dict:
        """Network logic: automatically determine what to ping (O(1) complexity - no network overload)"""
        
        # Extract registration info (simple dict lookups - no heavy computation)
        server_endpoint = registration_data.get('server_endpoint')
        mobile_devices = registration_data.get('mobile_devices', [])
        activation_amount = registration_data.get('activation_amount', 0)
        
        # PERFORMANCE: This analysis happens ONLY during node registration (not continuous)
        # Computational cost: 3 dict lookups + 2 if statements = O(1) complexity
        
        # NETWORK DECISION LOGIC:
        if server_endpoint:
            # Has server endpoint = ping server directly
            node_type = NodeType.SUPER if activation_amount >= 10000 else NodeType.FULL
            return {
                "ping_target": "server",
                "node_type": node_type.value,
                "endpoint": f"http://{server_endpoint}/ping",
                "success_rate_required": 0.98 if node_type == NodeType.SUPER else 0.95,
                "pings_per_4h_window": 60,
                "ping_interval_seconds": 240
            }
        
        elif mobile_devices:
            # Only mobile devices = ping mobile
            return {
                "ping_target": "mobile",
                "node_type": NodeType.LIGHT.value,
                "device_ids": mobile_devices[:3],  # Max 3 devices
                "success_rate_required": 1.0,  # Binary: respond or not
                "pings_per_4h_window": 1,
                "ping_interval_seconds": 14400  # Once per 4 hours
            }
        
        else:
            # Invalid registration
            return {
                "ping_target": "none",
                "error": "No valid ping target (no server endpoint or mobile devices)"
            }

# Network automatically routes pings based on node type
ping_router = NetworkPingRouter() 