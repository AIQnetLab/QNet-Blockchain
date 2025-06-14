"""
Server Node Monitor for Full and Super Nodes
These nodes run on servers and are pinged directly on server infrastructure
NO mobile device pinging for Full/Super nodes!
"""

import time
import asyncio
import logging
from typing import Dict, List, Optional, Set
import psutil
import aiohttp
from dataclasses import dataclass
from enum import Enum

logger = logging.getLogger(__name__)

class ServerNodeType(Enum):
    """Server node types"""
    FULL = "full"       # Full node - 95% success rate required
    SUPER = "super"     # Super node - 98% success rate required

class ServerNodeStatus(Enum):
    """Server node status"""
    ACTIVE = "active"
    INACTIVE = "inactive"
    DEGRADED = "degraded"
    OFFLINE = "offline"

@dataclass
class ServerNodeInfo:
    """Information about a server node"""
    node_id: str
    node_type: ServerNodeType
    server_address: str         # Server IP/hostname
    server_port: int           # Server port
    last_ping_time: int        # Last successful ping timestamp
    success_rate: float        # Rolling success rate (0.0-1.0)
    status: ServerNodeStatus   # Current node status
    uptime: float             # Server uptime in seconds
    cpu_usage: float          # CPU usage percentage
    memory_usage: float       # Memory usage percentage
    disk_usage: float         # Disk usage percentage
    registration_time: int    # When server was registered
    consecutive_failures: int # Consecutive ping failures

class ServerNodeMonitor:
    """Monitor for server-based Full and Super nodes"""
    
    def __init__(self):
        # node_id -> ServerNodeInfo
        self.server_nodes: Dict[str, ServerNodeInfo] = {}
        
        # Ping configuration for server nodes
        self.ping_interval = 240  # 4 minutes (240 seconds) - more frequent than Light nodes
        self.ping_timeout = 30    # 30 seconds timeout for server pings
        self.max_consecutive_failures = 3
        
        # Success rate requirements (FOR CURRENT 4-HOUR REWARD WINDOW ONLY!)
        self.success_rate_requirements = {
            ServerNodeType.FULL: 0.95,   # 95% over current 4-hour window (60 pings)
            ServerNodeType.SUPER: 0.98,  # 98% over current 4-hour window (60 pings)
        }
        
        # Current reward window size (4 hours)
        self.reward_window_pings = 60  # 60 pings × 4 minutes = 240 minutes (4 hours)
        
        # Performance thresholds
        self.performance_thresholds = {
            "cpu_max": 80.0,      # 80% CPU max
            "memory_max": 85.0,   # 85% memory max
            "disk_max": 90.0,     # 90% disk max
        }
        
        logger.info("Server Node Monitor initialized")
    
    def register_server_node(self, node_id: str, node_type: ServerNodeType,
                           server_address: str, server_port: int) -> bool:
        """Register a server node for monitoring"""
        current_time = int(time.time())
        
        if node_id in self.server_nodes:
            # Update existing server node
            node = self.server_nodes[node_id]
            node.server_address = server_address
            node.server_port = server_port
            node.status = ServerNodeStatus.ACTIVE
            logger.info(f"Updated server node {node_id} ({node_type.value}) at {server_address}:{server_port}")
            return True
        
        # Create new server node entry
        server_node = ServerNodeInfo(
            node_id=node_id,
            node_type=node_type,
            server_address=server_address,
            server_port=server_port,
            last_ping_time=0,
            success_rate=1.0,  # Start with perfect rate
            status=ServerNodeStatus.ACTIVE,
            uptime=0.0,
            cpu_usage=0.0,
            memory_usage=0.0,
            disk_usage=0.0,
            registration_time=current_time,
            consecutive_failures=0
        )
        
        self.server_nodes[node_id] = server_node
        logger.info(f"Registered server node {node_id} ({node_type.value}) at {server_address}:{server_port}")
        return True
    
    async def ping_server_node(self, node_id: str) -> bool:
        """Ping a server node directly (not through mobile app!)"""
        if node_id not in self.server_nodes:
            logger.warning(f"Server node {node_id} not found for ping")
            return False
        
        node = self.server_nodes[node_id]
        
        try:
            # Create ping URL
            ping_url = f"http://{node.server_address}:{node.server_port}/ping"
            
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=self.ping_timeout)) as session:
                start_time = time.time()
                
                async with session.get(ping_url) as response:
                    if response.status == 200:
                        ping_data = await response.json()
                        
                        # Update node info with server metrics
                        node.uptime = ping_data.get('uptime', 0.0)
                        node.cpu_usage = ping_data.get('cpu_usage', 0.0)
                        node.memory_usage = ping_data.get('memory_usage', 0.0)
                        node.disk_usage = ping_data.get('disk_usage', 0.0)
                        
                        # Record successful ping
                        node.last_ping_time = int(time.time())
                        node.consecutive_failures = 0
                        
                        # Update success rate with exponential moving average
                        node.success_rate = 0.9 * node.success_rate + 0.1 * 1.0
                        
                        # Check performance thresholds
                        if (node.cpu_usage > self.performance_thresholds["cpu_max"] or
                            node.memory_usage > self.performance_thresholds["memory_max"] or
                            node.disk_usage > self.performance_thresholds["disk_max"]):
                            node.status = ServerNodeStatus.DEGRADED
                            logger.warning(f"Server node {node_id} performance degraded: CPU={node.cpu_usage}%, MEM={node.memory_usage}%, DISK={node.disk_usage}%")
                        else:
                            node.status = ServerNodeStatus.ACTIVE
                        
                        ping_time = (time.time() - start_time) * 1000
                        logger.debug(f"Server node {node_id} ping successful ({ping_time:.1f}ms)")
                        return True
                    
                    else:
                        logger.warning(f"Server node {node_id} ping failed: HTTP {response.status}")
                        return False
        
        except asyncio.TimeoutError:
            logger.warning(f"Server node {node_id} ping timeout after {self.ping_timeout}s")
            return False
        except Exception as e:
            logger.error(f"Server node {node_id} ping error: {e}")
            return False
        
        # Record failed ping
        node.consecutive_failures += 1
        node.success_rate = 0.9 * node.success_rate + 0.1 * 0.0
        
        # Update status based on failures
        required_success_rate = self.success_rate_requirements[node.node_type]
        if node.success_rate < required_success_rate:
            node.status = ServerNodeStatus.DEGRADED
            logger.warning(f"Server node {node_id} degraded: success rate {node.success_rate:.3f} < {required_success_rate}")
        
        if node.consecutive_failures >= self.max_consecutive_failures:
            node.status = ServerNodeStatus.OFFLINE
            logger.error(f"Server node {node_id} offline: {node.consecutive_failures} consecutive failures")
        
        return False
    
    async def ping_all_server_nodes(self) -> Dict[str, bool]:
        """Ping all registered server nodes"""
        results = {}
        
        # Create ping tasks for all server nodes
        ping_tasks = []
        node_ids = list(self.server_nodes.keys())
        
        for node_id in node_ids:
            task = asyncio.create_task(self.ping_server_node(node_id))
            ping_tasks.append((node_id, task))
        
        # Wait for all pings to complete
        for node_id, task in ping_tasks:
            try:
                success = await task
                results[node_id] = success
            except Exception as e:
                logger.error(f"Error pinging server node {node_id}: {e}")
                results[node_id] = False
        
        logger.info(f"Pinged {len(results)} server nodes: {sum(results.values())} successful")
        return results
    
    def get_server_node_status(self, node_id: str) -> Optional[Dict]:
        """Get detailed status of a server node"""
        if node_id not in self.server_nodes:
            return None
        
        node = self.server_nodes[node_id]
        current_time = int(time.time())
        
        return {
            "node_id": node.node_id,
            "node_type": node.node_type.value,
            "status": node.status.value,
            "server_address": node.server_address,
            "server_port": node.server_port,
            "success_rate": node.success_rate,
            "required_success_rate": self.success_rate_requirements[node.node_type],
            "meets_requirements": node.success_rate >= self.success_rate_requirements[node.node_type],
            "last_ping_ago": current_time - node.last_ping_time if node.last_ping_time > 0 else None,
            "consecutive_failures": node.consecutive_failures,
            "uptime": node.uptime,
            "performance": {
                "cpu_usage": node.cpu_usage,
                "memory_usage": node.memory_usage,
                "disk_usage": node.disk_usage,
                "performance_ok": (
                    node.cpu_usage <= self.performance_thresholds["cpu_max"] and
                    node.memory_usage <= self.performance_thresholds["memory_max"] and
                    node.disk_usage <= self.performance_thresholds["disk_max"]
                )
            },
            "registration_time": node.registration_time
        }
    
    def get_all_server_nodes_status(self) -> List[Dict]:
        """Get status of all server nodes"""
        return [
            self.get_server_node_status(node_id)
            for node_id in self.server_nodes.keys()
        ]
    
    def get_server_nodes_summary(self) -> Dict:
        """Get summary statistics for server nodes"""
        if not self.server_nodes:
            return {
                "total_nodes": 0,
                "full_nodes": 0,
                "super_nodes": 0,
                "active_nodes": 0,
                "offline_nodes": 0,
                "degraded_nodes": 0,
                "average_success_rate": 0.0
            }
        
        full_nodes = [n for n in self.server_nodes.values() if n.node_type == ServerNodeType.FULL]
        super_nodes = [n for n in self.server_nodes.values() if n.node_type == ServerNodeType.SUPER]
        active_nodes = [n for n in self.server_nodes.values() if n.status == ServerNodeStatus.ACTIVE]
        offline_nodes = [n for n in self.server_nodes.values() if n.status == ServerNodeStatus.OFFLINE]
        degraded_nodes = [n for n in self.server_nodes.values() if n.status == ServerNodeStatus.DEGRADED]
        
        avg_success_rate = sum(n.success_rate for n in self.server_nodes.values()) / len(self.server_nodes)
        
        return {
            "total_nodes": len(self.server_nodes),
            "full_nodes": len(full_nodes),
            "super_nodes": len(super_nodes),
            "active_nodes": len(active_nodes),
            "offline_nodes": len(offline_nodes),
            "degraded_nodes": len(degraded_nodes),
            "average_success_rate": avg_success_rate,
            "success_rate_compliance": {
                "full_nodes_compliant": sum(1 for n in full_nodes if n.success_rate >= self.success_rate_requirements[ServerNodeType.FULL]),
                "super_nodes_compliant": sum(1 for n in super_nodes if n.success_rate >= self.success_rate_requirements[ServerNodeType.SUPER])
            }
        }
    
    def unregister_server_node(self, node_id: str) -> bool:
        """Unregister a server node"""
        if node_id in self.server_nodes:
            del self.server_nodes[node_id]
            logger.info(f"Unregistered server node {node_id}")
            return True
        return False
    
    async def start_monitoring_loop(self):
        """Start the server node monitoring loop"""
        logger.info("Starting server node monitoring loop")
        
        while True:
            try:
                await self.ping_all_server_nodes()
                await asyncio.sleep(self.ping_interval)
            except Exception as e:
                logger.error(f"Error in server monitoring loop: {e}")
                await asyncio.sleep(60)  # Wait 1 minute before retry 