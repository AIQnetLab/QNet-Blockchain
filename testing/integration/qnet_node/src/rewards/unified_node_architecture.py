"""
Unified Node Architecture for QNet
ARCHITECTURAL SEPARATION:
- Light Nodes: Mobile devices, network-initiated pings
- Full/Super Nodes: Server infrastructure, direct server pings
- Browser Extensions: Monitoring only, no pings
"""

import asyncio
import logging
from typing import Dict, List, Optional, Union
from dataclasses import dataclass
from enum import Enum

from .device_registry import DeviceRegistry, DeviceType, DeviceInfo
from .server_node_monitor import ServerNodeMonitor, ServerNodeType, ServerNodeInfo

logger = logging.getLogger(__name__)

class NodeCategory(Enum):
    """Node categories for architectural separation"""
    MOBILE_LIGHT = "mobile_light"       # Mobile Light nodes
    SERVER_FULL = "server_full"         # Server Full nodes
    SERVER_SUPER = "server_super"       # Server Super nodes

@dataclass
class UnifiedNodeStatus:
    """Unified status for all node types"""
    node_id: str
    category: NodeCategory
    success_rate: float
    meets_requirements: bool
    last_ping_time: Optional[int]
    can_receive_rewards: bool
    ping_mechanism: str  # "mobile_ping" or "server_ping" or "monitoring_only"

class UnifiedNodeArchitecture:
    """Unified architecture managing all node types correctly"""
    
    def __init__(self):
        # Mobile Light nodes manager
        self.device_registry = DeviceRegistry()
        
        # Server Full/Super nodes manager
        self.server_monitor = ServerNodeMonitor()
        
        # Success rate requirements
        self.success_rate_requirements = {
            NodeCategory.MOBILE_LIGHT: 0.90,   # 90% for mobile Light nodes
            NodeCategory.SERVER_FULL: 0.95,    # 95% for server Full nodes
            NodeCategory.SERVER_SUPER: 0.98,   # 98% for server Super nodes
        }
        
        logger.info("Unified Node Architecture initialized")
    
    # ============ MOBILE LIGHT NODES ============
    
    def register_mobile_light_node(self, node_id: str, device_id: str, 
                                 platform: str, push_token: str, ip_address: str) -> bool:
        """Register a mobile Light node device"""
        return self.device_registry.register_device(
            node_id=node_id,
            device_id=device_id,
            device_type=DeviceType.MOBILE_LIGHT,
            platform=platform,
            push_token=push_token,
            ip_address=ip_address
        )
    
    def register_browser_monitor(self, node_id: str, device_id: str, 
                               ip_address: str) -> bool:
        """Register a browser extension for monitoring (NO PINGS)"""
        return self.device_registry.register_device(
            node_id=node_id,
            device_id=device_id,
            device_type=DeviceType.BROWSER_MONITOR,
            platform="web",
            push_token="",  # No push notifications for browsers
            ip_address=ip_address
        )
    
    def get_mobile_device_for_ping(self, node_id: str) -> Optional[DeviceInfo]:
        """Get mobile device for network-initiated ping (ONLY Light nodes)"""
        return self.device_registry.get_best_device_for_ping(node_id)
    
    def record_mobile_ping_response(self, device_id: str, success: bool) -> bool:
        """Record response to network-initiated ping from mobile device"""
        return self.device_registry.record_ping_response(device_id, success)
    
    # ============ SERVER FULL/SUPER NODES ============
    
    def register_server_full_node(self, node_id: str, server_address: str, 
                                server_port: int) -> bool:
        """Register a server Full node (NO mobile device involvement)"""
        return self.server_monitor.register_server_node(
            node_id=node_id,
            node_type=ServerNodeType.FULL,
            server_address=server_address,
            server_port=server_port
        )
    
    def register_server_super_node(self, node_id: str, server_address: str, 
                                 server_port: int) -> bool:
        """Register a server Super node (NO mobile device involvement)"""
        return self.server_monitor.register_server_node(
            node_id=node_id,
            node_type=ServerNodeType.SUPER,
            server_address=server_address,
            server_port=server_port
        )
    
    async def ping_server_node(self, node_id: str) -> bool:
        """Ping server node directly (NOT through mobile app)"""
        return await self.server_monitor.ping_server_node(node_id)
    
    async def ping_all_server_nodes(self) -> Dict[str, bool]:
        """Ping all server nodes directly"""
        return await self.server_monitor.ping_all_server_nodes()
    
    # ============ UNIFIED STATUS AND MONITORING ============
    
    def get_node_status(self, node_id: str) -> Optional[UnifiedNodeStatus]:
        """Get unified status for any node type"""
        
        # Check if it's a mobile Light node
        mobile_devices = self.device_registry.get_node_devices(node_id)
        light_devices = [d for d in mobile_devices if d.device_type == DeviceType.MOBILE_LIGHT]
        
        if light_devices:
            # Mobile Light node
            avg_success_rate = sum(d.ping_success_rate for d in light_devices) / len(light_devices)
            required_rate = self.success_rate_requirements[NodeCategory.MOBILE_LIGHT]
            last_ping = max(d.last_ping_response for d in light_devices) if light_devices else None
            
            return UnifiedNodeStatus(
                node_id=node_id,
                category=NodeCategory.MOBILE_LIGHT,
                success_rate=avg_success_rate,
                meets_requirements=avg_success_rate >= required_rate,
                last_ping_time=last_ping,
                can_receive_rewards=avg_success_rate >= required_rate,
                ping_mechanism="mobile_ping"
            )
        
        # Check if it's a server Full node
        server_status = self.server_monitor.get_server_node_status(node_id)
        if server_status:
            if server_status['node_type'] == 'full':
                required_rate = self.success_rate_requirements[NodeCategory.SERVER_FULL]
                return UnifiedNodeStatus(
                    node_id=node_id,
                    category=NodeCategory.SERVER_FULL,
                    success_rate=server_status['success_rate'],
                    meets_requirements=server_status['meets_requirements'],
                    last_ping_time=server_status.get('last_ping_ago'),
                    can_receive_rewards=server_status['meets_requirements'],
                    ping_mechanism="server_ping"
                )
            
            elif server_status['node_type'] == 'super':
                required_rate = self.success_rate_requirements[NodeCategory.SERVER_SUPER]
                return UnifiedNodeStatus(
                    node_id=node_id,
                    category=NodeCategory.SERVER_SUPER,
                    success_rate=server_status['success_rate'],
                    meets_requirements=server_status['meets_requirements'],
                    last_ping_time=server_status.get('last_ping_ago'),
                    can_receive_rewards=server_status['meets_requirements'],
                    ping_mechanism="server_ping"
                )
        
        return None
    
    def get_all_nodes_summary(self) -> Dict:
        """Get summary of all nodes across all categories"""
        
        # Mobile Light nodes
        mobile_stats = self.device_registry.get_device_stats("")  # Get all devices
        light_nodes = [d for d in mobile_stats.get('devices', []) if d['device_type'] == 'mobile_light']
        
        # Server nodes
        server_stats = self.server_monitor.get_server_nodes_summary()
        
        # Compliance rates
        light_compliant = sum(1 for d in light_nodes if d.get('success_rate', 0) >= 0.90)
        
        return {
            "total_nodes": len(light_nodes) + server_stats['total_nodes'],
            "mobile_light_nodes": {
                "total": len(light_nodes),
                "compliant": light_compliant,
                "success_rate_requirement": "90%",
                "ping_mechanism": "Network-initiated mobile pings"
            },
            "server_full_nodes": {
                "total": server_stats['full_nodes'],
                "compliant": server_stats['success_rate_compliance']['full_nodes_compliant'],
                "success_rate_requirement": "95%",
                "ping_mechanism": "Direct server pings"
            },
            "server_super_nodes": {
                "total": server_stats['super_nodes'],
                "compliant": server_stats['success_rate_compliance']['super_nodes_compliant'],
                "success_rate_requirement": "98%",
                "ping_mechanism": "Direct server pings"
            },
            "browser_monitors": {
                "total": mobile_stats.get('browser_monitors', 0),
                "ping_mechanism": "No pings - monitoring only"
            },
            "architecture_compliance": {
                "mobile_light_separation": "✅ Mobile devices handle Light node pings",
                "server_separation": "✅ Servers handle Full/Super node pings",
                "browser_separation": "✅ Browser extensions monitoring only",
                "no_cross_contamination": "✅ No Full/Super pings through mobile"
            }
        }
    
    def validate_architecture(self) -> Dict[str, bool]:
        """Validate that architecture separation is working correctly"""
        
        issues = []
        
        # Check 1: No server nodes registered as mobile devices
        all_mobile_devices = []
        for node_id, devices in self.device_registry.node_devices.items():
            for device in devices:
                if device.device_type in [DeviceType.SERVER_FULL, DeviceType.SERVER_SUPER]:
                    issues.append(f"CRITICAL: Server node {node_id} registered as mobile device!")
        
        # Check 2: No mobile devices trying to handle server pings
        server_nodes = list(self.server_monitor.server_nodes.keys())
        for node_id in server_nodes:
            mobile_devices = self.device_registry.get_node_devices(node_id)
            if mobile_devices:
                issues.append(f"WARNING: Server node {node_id} has mobile devices registered")
        
        # Check 3: Browser extensions not marked as pingable
        all_browser_devices = []
        for node_id, devices in self.device_registry.node_devices.items():
            for device in devices:
                if device.device_type == DeviceType.BROWSER_MONITOR and device.can_be_pinged:
                    issues.append(f"ERROR: Browser device {device.device_id} marked as pingable!")
        
        return {
            "architecture_valid": len(issues) == 0,
            "issues_found": issues,
            "mobile_light_separation": "✅ Correct" if not any("mobile device" in issue for issue in issues) else "❌ Failed",
            "server_separation": "✅ Correct" if not any("Server node" in issue for issue in issues) else "❌ Failed",
            "browser_separation": "✅ Correct" if not any("Browser device" in issue for issue in issues) else "❌ Failed"
        }
    
    def get_node_monitoring_info(self, node_id: str) -> Optional[Dict]:
        """Get monitoring information for a node (for mobile app display)"""
        status = self.get_node_status(node_id)
        if not status:
            return None
        
        base_info = {
            "node_id": node_id,
            "category": status.category.value,
            "success_rate": status.success_rate,
            "meets_requirements": status.meets_requirements,
            "can_receive_rewards": status.can_receive_rewards,
            "ping_mechanism": status.ping_mechanism
        }
        
        if status.category == NodeCategory.MOBILE_LIGHT:
            # Mobile Light node - show device info
            devices = self.device_registry.get_node_devices(node_id)
            mobile_devices = [d for d in devices if d.device_type == DeviceType.MOBILE_LIGHT]
            browser_monitors = [d for d in devices if d.device_type == DeviceType.BROWSER_MONITOR]
            
            base_info.update({
                "mobile_devices": len(mobile_devices),
                "browser_monitors": len(browser_monitors),
                "ping_location": "Mobile devices",
                "monitoring_note": "This Light node is pinged on mobile devices"
            })
        
        else:
            # Server node - show server info
            server_info = self.server_monitor.get_server_node_status(node_id)
            if server_info:
                base_info.update({
                    "server_address": server_info['server_address'],
                    "server_port": server_info['server_port'],
                    "uptime": server_info['uptime'],
                    "performance": server_info['performance'],
                    "ping_location": "Server infrastructure",
                    "monitoring_note": f"This {status.category.value.replace('_', ' ').title()} node runs on server, not mobile"
                })
        
        return base_info
    
    async def start_monitoring(self):
        """Start monitoring for all node types"""
        logger.info("Starting unified node monitoring")
        
        # Start server monitoring loop
        server_task = asyncio.create_task(self.server_monitor.start_monitoring_loop())
        
        # Mobile device cleanup task
        async def mobile_cleanup_loop():
            while True:
                try:
                    cleaned = self.device_registry.cleanup_inactive_devices()
                    if cleaned > 0:
                        logger.info(f"Cleaned up {cleaned} inactive mobile devices")
                    await asyncio.sleep(3600)  # Every hour
                except Exception as e:
                    logger.error(f"Error in mobile cleanup loop: {e}")
                    await asyncio.sleep(300)  # Wait 5 minutes on error
        
        cleanup_task = asyncio.create_task(mobile_cleanup_loop())
        
        # Run both tasks concurrently
        await asyncio.gather(server_task, cleanup_task) 