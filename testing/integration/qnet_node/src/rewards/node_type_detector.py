"""
Node Type Detector for QNet Network
Automatically determines what to ping: mobile device or server
"""

import logging
import time
from typing import Dict, Optional, Tuple
from dataclasses import dataclass
from enum import Enum

logger = logging.getLogger(__name__)

class NodeType(Enum):
    """Node types for ping routing"""
    LIGHT = "light"     # Mobile Light node - ping mobile device
    FULL = "full"       # Server Full node - ping server directly  
    SUPER = "super"     # Server Super node - ping server directly

class PingTarget(Enum):
    """What to ping for rewards verification"""
    MOBILE_DEVICE = "mobile_device"    # Ping mobile device
    SERVER_ENDPOINT = "server_endpoint" # Ping server HTTP endpoint
    NO_PING = "no_ping"                # No ping (banned/inactive)

@dataclass
class NodeInfo:
    """Node information for ping routing"""
    node_id: str
    node_type: NodeType
    ping_target: PingTarget
    target_address: str         # Mobile device ID or server URL
    backup_addresses: list      # Backup mobile devices or server mirrors
    last_successful_ping: int   # Last successful ping timestamp
    consecutive_failures: int   # Consecutive ping failures
    is_banned: bool            # Whether node is banned from rewards

class NodeTypeDetector:
    """Detects node type and determines ping targets"""
    
    def __init__(self):
        # Node registration database (in production: external database)
        self.node_registry: Dict[str, NodeInfo] = {}
        
        # Detection rules
        self.detection_timeout = 30  # 30 seconds for type detection
        self.max_detection_attempts = 3
        
        logger.info("Node Type Detector initialized")
    
    def register_node(self, node_id: str, registration_data: Dict) -> NodeType:
        """Register node and detect its type automatically"""
        
        # Extract registration information
        activation_amount = registration_data.get('activation_amount', 0)
        server_endpoint = registration_data.get('server_endpoint')
        mobile_devices = registration_data.get('mobile_devices', [])
        declared_type = registration_data.get('node_type')
        
        # AUTOMATIC TYPE DETECTION LOGIC
        detected_type = self._detect_node_type(
            activation_amount=activation_amount,
            server_endpoint=server_endpoint,
            mobile_devices=mobile_devices,
            declared_type=declared_type
        )
        
        # Determine ping target based on detected type
        ping_target, target_address, backups = self._determine_ping_target(
            detected_type, server_endpoint, mobile_devices
        )
        
        # Create node info
        node_info = NodeInfo(
            node_id=node_id,
            node_type=detected_type,
            ping_target=ping_target,
            target_address=target_address,
            backup_addresses=backups,
            last_successful_ping=0,
            consecutive_failures=0,
            is_banned=False
        )
        
        # Store in registry
        self.node_registry[node_id] = node_info
        
        logger.info(f"Node {node_id} registered as {detected_type.value}, ping target: {ping_target.value}")
        return detected_type
    
    def _detect_node_type(self, activation_amount: int, server_endpoint: Optional[str], 
                         mobile_devices: list, declared_type: Optional[str]) -> NodeType:
        """Detect node type based on registration data"""
        
        # Rule 1: Server endpoint provided = Full or Super node
        if server_endpoint:
            # Check activation amount to distinguish Full vs Super
            if activation_amount >= 10000:  # 10k+ QNC = Super node
                logger.info(f"Detected Super node: server endpoint + {activation_amount} QNC")
                return NodeType.SUPER
            elif activation_amount >= 7500:  # 7.5k+ QNC = Full node
                logger.info(f"Detected Full node: server endpoint + {activation_amount} QNC")
                return NodeType.FULL
            else:
                logger.warning(f"Server endpoint provided but low activation amount: {activation_amount}")
                return NodeType.FULL  # Default to Full if server provided
        
        # Rule 2: Only mobile devices = Light node
        if mobile_devices and not server_endpoint:
            logger.info(f"Detected Light node: {len(mobile_devices)} mobile devices, no server")
            return NodeType.LIGHT
        
        # Rule 3: Declared type validation
        if declared_type:
            if declared_type.lower() == 'super' and activation_amount >= 10000:
                logger.warning("Declared Super node but no server endpoint - requiring server")
                return NodeType.SUPER
            elif declared_type.lower() == 'full' and activation_amount >= 7500:
                logger.warning("Declared Full node but no server endpoint - requiring server")  
                return NodeType.FULL
        
        # Rule 4: Default based on activation amount
        if activation_amount >= 10000:
            logger.warning(f"High activation amount ({activation_amount}) but no server - defaulting to Light")
            return NodeType.LIGHT
        elif activation_amount >= 7500:
            logger.warning(f"Medium activation amount ({activation_amount}) but no server - defaulting to Light")
            return NodeType.LIGHT
        
        # Default: Light node
        logger.info(f"Defaulting to Light node: {activation_amount} QNC, mobile devices: {len(mobile_devices)}")
        return NodeType.LIGHT
    
    def _determine_ping_target(self, node_type: NodeType, server_endpoint: Optional[str], 
                              mobile_devices: list) -> Tuple[PingTarget, str, list]:
        """Determine what to ping for this node"""
        
        if node_type in [NodeType.FULL, NodeType.SUPER]:
            # Server nodes: ping server endpoint
            if server_endpoint:
                return PingTarget.SERVER_ENDPOINT, server_endpoint, []
            else:
                logger.error(f"Server node without endpoint - cannot ping!")
                return PingTarget.NO_PING, "", []
        
        elif node_type == NodeType.LIGHT:
            # Light nodes: ping mobile device
            if mobile_devices:
                primary_device = mobile_devices[0]
                backup_devices = mobile_devices[1:] if len(mobile_devices) > 1 else []
                return PingTarget.MOBILE_DEVICE, primary_device, backup_devices
            else:
                logger.error(f"Light node without mobile devices - cannot ping!")
                return PingTarget.NO_PING, "", []
        
        return PingTarget.NO_PING, "", []
    
    def get_ping_instruction(self, node_id: str) -> Optional[Dict]:
        """Get ping instruction for network to execute"""
        if node_id not in self.node_registry:
            logger.warning(f"Node {node_id} not registered")
            return None
        
        node_info = self.node_registry[node_id]
        
        # Check if node is banned
        if node_info.is_banned:
            return {
                "action": "no_ping",
                "reason": "node_banned",
                "node_id": node_id
            }
        
        # Generate ping instruction based on target type
        if node_info.ping_target == PingTarget.SERVER_ENDPOINT:
            return {
                "action": "ping_server",
                "node_id": node_id,
                "node_type": node_info.node_type.value,
                "server_url": f"http://{node_info.target_address}/ping",
                "timeout": 30,
                "required_success_rate": 0.98 if node_info.node_type == NodeType.SUPER else 0.95,
                "pings_per_window": 60  # 60 pings per 4-hour window
            }
        
        elif node_info.ping_target == PingTarget.MOBILE_DEVICE:
            return {
                "action": "ping_mobile",
                "node_id": node_id,
                "node_type": node_info.node_type.value,
                "device_id": node_info.target_address,
                "backup_devices": node_info.backup_addresses,
                "timeout": 60,
                "required_success_rate": 1.0,  # 100% (binary)
                "pings_per_window": 1  # 1 ping per 4-hour window
            }
        
        else:
            return {
                "action": "no_ping",
                "reason": "no_valid_target",
                "node_id": node_id
            }
    
    def record_ping_result(self, node_id: str, success: bool) -> bool:
        """Record ping result and update node status"""
        if node_id not in self.node_registry:
            return False
        
        node_info = self.node_registry[node_id]
        current_time = int(time.time())
        
        if success:
            node_info.last_successful_ping = current_time
            node_info.consecutive_failures = 0
            logger.debug(f"Successful ping for node {node_id}")
        else:
            node_info.consecutive_failures += 1
            logger.warning(f"Failed ping for node {node_id}, consecutive failures: {node_info.consecutive_failures}")
        
        # Check for banning (different rules for different node types)
        should_ban = self._should_ban_node(node_info)
        if should_ban and not node_info.is_banned:
            node_info.is_banned = True
            logger.error(f"Node {node_id} BANNED due to excessive failures")
        
        return True
    
    def _should_ban_node(self, node_info: NodeInfo) -> bool:
        """Determine if node should be banned based on failures (PRODUCTION-REALISTIC THRESHOLDS)"""
        
        # PRODUCTION-REALISTIC ban thresholds (considering real-world scenarios)
        if node_info.node_type == NodeType.LIGHT:
            # Light nodes: Ban after 24 consecutive reward windows (4 days offline)
            # Reasoning: Mobile devices can be offline due to travel, battery, airplane mode, no service
            return node_info.consecutive_failures >= 24
        
        elif node_info.node_type == NodeType.FULL:
            # Full nodes: Ban after 180 consecutive ping failures (12 hours offline)  
            # Reasoning: Servers can have maintenance windows, updates, network issues, hardware failures
            return node_info.consecutive_failures >= 180
        
        elif node_info.node_type == NodeType.SUPER:
            # Super nodes: Ban after 90 consecutive ping failures (6 hours offline)
            # Reasoning: Backbone infrastructure needs high availability but allow for maintenance
            return node_info.consecutive_failures >= 90
        
        return False
    
    def get_network_ping_schedule(self) -> Dict:
        """Get complete ping schedule for network to execute"""
        current_time = int(time.time())
        
        # Separate by ping type
        server_pings = []
        mobile_pings = []
        
        for node_id, node_info in self.node_registry.items():
            if node_info.is_banned:
                continue
            
            ping_instruction = self.get_ping_instruction(node_id)
            if not ping_instruction:
                continue
            
            if ping_instruction["action"] == "ping_server":
                server_pings.append(ping_instruction)
            elif ping_instruction["action"] == "ping_mobile":
                mobile_pings.append(ping_instruction)
        
        return {
            "timestamp": current_time,
            "server_pings": server_pings,
            "mobile_pings": mobile_pings,
            "total_nodes": len(self.node_registry),
            "active_nodes": len(server_pings) + len(mobile_pings),
            "banned_nodes": sum(1 for n in self.node_registry.values() if n.is_banned)
        }
    
    def unban_node(self, node_id: str, reason: str = "manual_unban") -> bool:
        """Unban a node (admin function)"""
        if node_id not in self.node_registry:
            return False
        
        node_info = self.node_registry[node_id]
        if node_info.is_banned:
            node_info.is_banned = False
            node_info.consecutive_failures = 0
            logger.info(f"Node {node_id} unbanned: {reason}")
            return True
        
        return False
    
    def get_node_status(self, node_id: str) -> Optional[Dict]:
        """Get detailed node status"""
        if node_id not in self.node_registry:
            return None
        
        node_info = self.node_registry[node_id]
        current_time = int(time.time())
        
        return {
            "node_id": node_id,
            "node_type": node_info.node_type.value,
            "ping_target": node_info.ping_target.value,
            "target_address": node_info.target_address,
            "backup_addresses": node_info.backup_addresses,
            "is_banned": node_info.is_banned,
            "consecutive_failures": node_info.consecutive_failures,
            "last_successful_ping": node_info.last_successful_ping,
            "seconds_since_last_ping": current_time - node_info.last_successful_ping if node_info.last_successful_ping > 0 else None,
            "ban_threshold": self._get_ban_threshold(node_info.node_type),
            "ready_for_rewards": not node_info.is_banned and self._is_eligible_for_rewards(node_info)
        }
    
    def _get_ban_threshold(self, node_type: NodeType) -> int:
        """Get ban threshold for node type (PRODUCTION-REALISTIC)"""
        thresholds = {
            NodeType.LIGHT: 24,   # 24 missed reward windows (4 days)
            NodeType.FULL: 180,   # 180 consecutive ping failures (12 hours)
            NodeType.SUPER: 90    # 90 consecutive ping failures (6 hours)
        }
        return thresholds.get(node_type, 24)
    
    def _is_eligible_for_rewards(self, node_info: NodeInfo) -> bool:
        """Check if node is eligible for rewards in current window"""
        if node_info.is_banned:
            return False
        
        current_time = int(time.time())
        current_window_start = (current_time // 14400) * 14400  # 4-hour window start
        
        # Light nodes: Must have responded in current window
        if node_info.node_type == NodeType.LIGHT:
            return node_info.last_successful_ping >= current_window_start
        
        # Server nodes: Must have high enough success rate in current window
        # (This would require tracking success rate over current window)
        # For now, just check if not failing consecutively
        return node_info.consecutive_failures < 3 