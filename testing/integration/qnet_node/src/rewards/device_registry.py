"""
Device Registry System for QNet Nodes
Handles multiple devices with same wallet/node_id
ARCHITECTURAL SEPARATION: Mobile Light Nodes vs Server Full/Super Nodes
"""

import time
import logging
from typing import Dict, List, Optional, Set
from dataclasses import dataclass
from enum import Enum

logger = logging.getLogger(__name__)

class DeviceType(Enum):
    """Device types for ping routing"""
    MOBILE_LIGHT = "mobile_light"       # Mobile Light node - gets pinged
    BROWSER_MONITOR = "browser_monitor" # Browser extension - NO PINGS, monitoring only
    SERVER_FULL = "server_full"         # Server Full node - pings handled by server
    SERVER_SUPER = "server_super"       # Server Super node - pings handled by server

class DeviceStatus(Enum):
    """Device status for ping routing"""
    ACTIVE = "active"           # Device is active and can receive pings
    INACTIVE = "inactive"       # Device is temporarily offline
    BLOCKED = "blocked"         # Device blocked due to issues
    MONITORING_ONLY = "monitoring_only" # Browser extension - monitoring only

@dataclass
class DeviceInfo:
    """Information about a registered device - PRIVACY COMPLIANT"""
    device_id: str              # Anonymous hash (NOT personal data)
    node_id: str               # Associated node/wallet ID (public key hash)
    device_type: DeviceType    # Type of device (mobile/browser/server)
    platform: str              # "android", "ios", "web", "server"
    push_token: str            # Push notification token (mobile only) - encrypted
    ip_address: str            # Last known IP address (hashed for privacy)
    last_seen: int             # Last activity timestamp
    last_ping_response: int    # Last successful ping response
    status: DeviceStatus       # Current device status
    ping_success_rate: float   # Success rate for CURRENT 4-hour window only
    registration_time: int     # When device was first registered
    can_be_pinged: bool        # Whether this device can receive pings

class DeviceRegistry:
    """Registry for managing multiple devices per node"""
    
    def __init__(self):
        # node_id -> list of device_info
        self.node_devices: Dict[str, List[DeviceInfo]] = {}
        
        # device_id -> node_id mapping for fast lookup
        self.device_to_node: Dict[str, str] = {}
        
        # Ping routing decisions (ONLY for mobile light nodes)
        self.last_pinged_device: Dict[str, str] = {}  # node_id -> device_id
        
        # Configuration
        self.max_mobile_devices_per_node = 3  # Maximum mobile devices per Light node
        self.max_browser_monitors = 10        # Maximum browser monitors (no limit practically)
        self.device_inactive_threshold = 24 * 60 * 60  # 24 hours
        
        # Success rate requirements by device type (FOR CURRENT 4-HOUR REWARD WINDOW ONLY!)
        self.success_rate_requirements = {
            DeviceType.MOBILE_LIGHT: 1.0,   # 100% for current 4-hour window (binary: respond or not)
            DeviceType.SERVER_FULL: 0.95,   # 95% over current 4-hour window (60 pings)
            DeviceType.SERVER_SUPER: 0.98,  # 98% over current 4-hour window (60 pings)
            DeviceType.BROWSER_MONITOR: 0.0 # Not applicable - no pings
        }
        
        # Window sizes for current reward period (4 hours)
        self.current_window_requirements = {
            DeviceType.MOBILE_LIGHT: 1,     # 1 ping per 4-hour window (binary success)
            DeviceType.SERVER_FULL: 60,     # 60 pings per 4-hour window (240min ÷ 4min)
            DeviceType.SERVER_SUPER: 60,    # 60 pings per 4-hour window (240min ÷ 4min)
            DeviceType.BROWSER_MONITOR: 0   # Not applicable
        }
        
        logger.info("Device Registry initialized with architectural separation")
    
    def register_device(self, node_id: str, device_id: str, device_type: DeviceType,
                       platform: str, push_token: str, ip_address: str) -> bool:
        """Register a new device for a node with proper architectural separation"""
        current_time = int(time.time())
        
        # Initialize node devices list if needed
        if node_id not in self.node_devices:
            self.node_devices[node_id] = []
        
        # CRITICAL: Determine node type to enforce architecture rules
        node_type = self._determine_node_type(node_id)
        
        # ARCHITECTURAL RULE: Full/Super nodes CAN have mobile devices but ONLY for monitoring!
        if node_type in ['full', 'super'] and device_type == DeviceType.MOBILE_LIGHT:
            logger.warning(f"Full/Super node {node_id} trying to register mobile device for pings - CONVERTING to monitoring only")
            device_type = DeviceType.BROWSER_MONITOR  # Force to monitoring only
        
        # Auto-cleanup inactive devices before checking limits
        self._cleanup_inactive_devices_for_node(node_id)
        
        # Check if device already exists
        for device in self.node_devices[node_id]:
            if device.device_id == device_id:
                # Update existing device
                device.push_token = self._hash_token(push_token) if push_token else ""
                device.ip_address = self._hash_ip(ip_address)
                device.last_seen = current_time
                device.status = DeviceStatus.ACTIVE if device.can_be_pinged else DeviceStatus.MONITORING_ONLY
                logger.info(f"Updated device {device_id} ({device_type.value}) for node {node_id}")
                return True
        
        # Determine if device can be pinged
        can_be_pinged = device_type == DeviceType.MOBILE_LIGHT
        
        # Check device limits based on type
        if device_type == DeviceType.MOBILE_LIGHT:
            mobile_devices = [d for d in self.node_devices[node_id] 
                            if d.device_type == DeviceType.MOBILE_LIGHT and d.status == DeviceStatus.ACTIVE]
            if len(mobile_devices) >= self.max_mobile_devices_per_node:
                logger.warning(f"Light node {node_id} already has {len(mobile_devices)} mobile devices (limit: {self.max_mobile_devices_per_node})")
                return False
        
        elif device_type == DeviceType.BROWSER_MONITOR:
            browser_devices = [d for d in self.node_devices[node_id] 
                             if d.device_type == DeviceType.BROWSER_MONITOR]
            if len(browser_devices) >= self.max_browser_monitors:
                logger.warning(f"Node {node_id} already has {len(browser_devices)} monitoring devices (limit: {self.max_browser_monitors})")
                return False
        
        # Create new device
        device_info = DeviceInfo(
            device_id=device_id,
            node_id=node_id,
            device_type=device_type,
            platform=platform,
            push_token=push_token if can_be_pinged else "",
            ip_address=ip_address,
            last_seen=current_time,
            last_ping_response=0,
            status=DeviceStatus.ACTIVE if can_be_pinged else DeviceStatus.MONITORING_ONLY,
            ping_success_rate=1.0,  # Start with perfect rate
            registration_time=current_time,
            can_be_pinged=can_be_pinged
        )
        
        self.node_devices[node_id].append(device_info)
        self.device_to_node[device_id] = node_id
        
        logger.info(f"Registered new device {device_id} ({device_type.value}) for node {node_id} on {platform}")
        return True
    
    def get_best_device_for_ping(self, node_id: str) -> Optional[DeviceInfo]:
        """Get the best device to ping for a given node (ONLY mobile Light nodes)"""
        if node_id not in self.node_devices:
            return None
        
        devices = self.node_devices[node_id]
        
        # CRITICAL: Only mobile Light nodes can be pinged!
        pingable_devices = [d for d in devices 
                          if d.device_type == DeviceType.MOBILE_LIGHT and 
                             d.status == DeviceStatus.ACTIVE and 
                             d.can_be_pinged]
        
        if not pingable_devices:
            logger.warning(f"No pingable mobile devices for Light node {node_id}")
            return None
        
        current_time = int(time.time())
        
        # Filter out devices that are too old
        recent_devices = [
            d for d in pingable_devices 
            if current_time - d.last_seen < self.device_inactive_threshold
        ]
        
        if not recent_devices:
            logger.warning(f"No recent mobile devices for Light node {node_id}")
            return None
        
        # Filter by success rate (90% for mobile Light nodes)
        min_success_rate = self.success_rate_requirements[DeviceType.MOBILE_LIGHT]
        reliable_devices = [
            d for d in recent_devices 
            if d.ping_success_rate >= min_success_rate
        ]
        
        # If no reliable devices, use recent ones anyway
        candidate_devices = reliable_devices if reliable_devices else recent_devices
        
        # Ping routing strategy: Round-robin with preference for most recent
        last_pinged = self.last_pinged_device.get(node_id)
        
        if last_pinged:
            # Try to find next device in rotation
            try:
                current_index = next(i for i, d in enumerate(candidate_devices) if d.device_id == last_pinged)
                next_index = (current_index + 1) % len(candidate_devices)
                selected_device = candidate_devices[next_index]
            except StopIteration:
                # Last pinged device not found, select most recent
                selected_device = max(candidate_devices, key=lambda d: d.last_seen)
        else:
            # First ping for this node, select most recent device
            selected_device = max(candidate_devices, key=lambda d: d.last_seen)
        
        # Update last pinged device
        self.last_pinged_device[node_id] = selected_device.device_id
        
        logger.debug(f"Selected mobile device {selected_device.device_id} for ping Light node {node_id}")
        return selected_device
    
    def record_ping_response(self, device_id: str, success: bool) -> bool:
        """Record ping response from a device"""
        if device_id not in self.device_to_node:
            logger.warning(f"Unknown device {device_id} attempted ping response")
            return False
        
        node_id = self.device_to_node[device_id]
        device = self._find_device(node_id, device_id)
        
        if not device:
            return False
        
        current_time = int(time.time())
        
        if success:
            device.last_ping_response = current_time
            # Update success rate with exponential moving average
            device.ping_success_rate = 0.9 * device.ping_success_rate + 0.1 * 1.0
        else:
            # Update success rate with failure
            device.ping_success_rate = 0.9 * device.ping_success_rate + 0.1 * 0.0
        
        device.last_seen = current_time
        
        # Block device if success rate too low
        if device.ping_success_rate < self.success_rate_requirements[device.device_type]:
            device.status = DeviceStatus.BLOCKED
            logger.warning(f"Device {device_id} blocked due to low success rate: {device.ping_success_rate:.2f}")
        
        logger.debug(f"Recorded ping response for device {device_id}: success={success}, rate={device.ping_success_rate:.2f}")
        return True
    
    def _find_device(self, node_id: str, device_id: str) -> Optional[DeviceInfo]:
        """Find device by node_id and device_id"""
        if node_id not in self.node_devices:
            return None
        
        for device in self.node_devices[node_id]:
            if device.device_id == device_id:
                return device
        
        return None
    
    def unregister_device(self, device_id: str) -> bool:
        """Unregister a device"""
        if device_id not in self.device_to_node:
            return False
        
        node_id = self.device_to_node[device_id]
        
        # Remove device from node's device list
        if node_id in self.node_devices:
            self.node_devices[node_id] = [
                d for d in self.node_devices[node_id] 
                if d.device_id != device_id
            ]
        
        # Remove from device mapping
        del self.device_to_node[device_id]
        
        # Clear last pinged if it was this device
        if self.last_pinged_device.get(node_id) == device_id:
            del self.last_pinged_device[node_id]
        
        logger.info(f"Unregistered device {device_id}")
        return True
    
    def cleanup_inactive_devices(self) -> int:
        """Remove devices that haven't been seen for too long"""
        current_time = int(time.time())
        cleaned = 0
        
        for node_id, devices in self.node_devices.items():
            original_count = len(devices)
            
            # Keep only recent devices
            self.node_devices[node_id] = [
                d for d in devices 
                if current_time - d.last_seen < self.device_inactive_threshold
            ]
            
            # Update device mapping
            for device in devices:
                if current_time - device.last_seen >= self.device_inactive_threshold:
                    if device.device_id in self.device_to_node:
                        del self.device_to_node[device.device_id]
            
            cleaned += original_count - len(self.node_devices[node_id])
        
        if cleaned > 0:
            logger.info(f"Cleaned up {cleaned} inactive devices")
        
        return cleaned
    
    def get_node_devices(self, node_id: str) -> List[DeviceInfo]:
        """Get all devices for a node"""
        return self.node_devices.get(node_id, [])
    
    def get_device_stats(self, node_id: str) -> Dict:
        """Get device statistics for a node with architectural separation"""
        devices = self.get_node_devices(node_id)
        
        if not devices:
            return {
                "total_devices": 0, 
                "mobile_devices": 0,
                "browser_monitors": 0,
                "server_nodes": 0,
                "average_success_rate": 0.0
            }
        
        mobile_devices = [d for d in devices if d.device_type == DeviceType.MOBILE_LIGHT]
        browser_monitors = [d for d in devices if d.device_type == DeviceType.BROWSER_MONITOR]
        server_nodes = [d for d in devices if d.device_type in [DeviceType.SERVER_FULL, DeviceType.SERVER_SUPER]]
        
        # Calculate success rate only for pingable devices
        pingable_devices = [d for d in devices if d.can_be_pinged]
        avg_success_rate = sum(d.ping_success_rate for d in pingable_devices) / len(pingable_devices) if pingable_devices else 0.0
        
        return {
            "total_devices": len(devices),
            "mobile_devices": len(mobile_devices),
            "browser_monitors": len(browser_monitors),
            "server_nodes": len(server_nodes),
            "average_success_rate": avg_success_rate,
            "devices": [
                {
                    "device_id": d.device_id,
                    "device_type": d.device_type.value,
                    "platform": d.platform,
                    "status": d.status.value,
                    "success_rate": d.ping_success_rate if d.can_be_pinged else None,
                    "can_be_pinged": d.can_be_pinged,
                    "last_seen": d.last_seen
                }
                for d in devices
            ]
        }
    
    def is_server_node(self, node_id: str) -> bool:
        """Check if node has server-type devices (Full/Super nodes)"""
        devices = self.get_node_devices(node_id)
        return any(d.device_type in [DeviceType.SERVER_FULL, DeviceType.SERVER_SUPER] for d in devices)
    
    def get_node_type_from_devices(self, node_id: str) -> Optional[str]:
        """Determine node type from registered devices"""
        devices = self.get_node_devices(node_id)
        
        if not devices:
            return None
        
        # Check for server nodes first
        for device in devices:
            if device.device_type == DeviceType.SERVER_SUPER:
                return "super"
            elif device.device_type == DeviceType.SERVER_FULL:
                return "full"
        
        # Check for mobile Light nodes
        if any(d.device_type == DeviceType.MOBILE_LIGHT for d in devices):
            return "light"
        
        return "unknown"
    
    def _determine_node_type(self, node_id: str) -> str:
        """Determine node type (light/full/super) - simplified logic for production"""
        # In production, this would query node registration database
        # For now, use simple heuristics
        
        # Check if node has server components registered
        devices = self.get_node_devices(node_id)
        for device in devices:
            if device.device_type == DeviceType.SERVER_FULL:
                return "full"
            elif device.device_type == DeviceType.SERVER_SUPER:
                return "super"
        
        # Default to light node
        return "light"
    
    def _hash_ip(self, ip_address: str) -> str:
        """Hash IP address for privacy compliance (NOT personal data)"""
        import hashlib
        # Use first 8 characters of hash for privacy while maintaining functionality
        return hashlib.sha256(ip_address.encode()).hexdigest()[:8]
    
    def _hash_token(self, token: str) -> str:
        """Hash push token for privacy compliance"""
        import hashlib
        # Store hash of token, not raw token
        return hashlib.sha256(token.encode()).hexdigest()[:16]
    
    def _cleanup_inactive_devices_for_node(self, node_id: str):
        """Auto-cleanup inactive devices for a specific node to free slots"""
        if node_id not in self.node_devices:
            return
        
        current_time = int(time.time())
        original_count = len(self.node_devices[node_id])
        
        # Remove devices that haven't been seen for too long
        active_devices = []
        for device in self.node_devices[node_id]:
            if current_time - device.last_seen < self.device_inactive_threshold:
                active_devices.append(device)
            else:
                # Remove from device mapping
                if device.device_id in self.device_to_node:
                    del self.device_to_node[device.device_id]
                logger.info(f"Auto-removed inactive device {device.device_id} from node {node_id}")
        
        self.node_devices[node_id] = active_devices
        
        removed_count = original_count - len(active_devices)
        if removed_count > 0:
            logger.info(f"Auto-cleaned {removed_count} inactive devices for node {node_id}")
    
    def can_node_have_mobile_devices_for_pings(self, node_id: str) -> bool:
        """Check if node can have mobile devices for ping participation"""
        node_type = self._determine_node_type(node_id)
        # ONLY Light nodes can have mobile devices for pings
        return node_type == "light"
    
    def can_node_have_monitoring_devices(self, node_id: str) -> bool:
        """Check if node can have monitoring devices (always yes)"""
        # ANY node type can have unlimited monitoring devices
        return True 