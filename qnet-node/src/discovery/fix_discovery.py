#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Improved script to fix node discovery issues in QNet
"""

import os
import fileinput
import sys
import re
import shutil
import subprocess
import logging

# Configure logging
logging.basicConfig(level=logging.INFO,
                    format='%(asctime)s [%(levelname)s] %(message)s',
                    handlers=[logging.StreamHandler()])

def backup_file(file_path):
    """Creates a backup of a file before modifying it"""
    if os.path.exists(file_path):
        backup_path = file_path + '.backup'
        try:
            shutil.copy2(file_path, backup_path)
            logging.info(f"Created backup at {backup_path}")
            return True
        except Exception as e:
            logging.error(f"Error creating backup of {file_path}: {e}")
            return False
    else:
        logging.error(f"File {file_path} not found")
        return False

def fix_node_discovery_py():
    """Fixes issues in node_discovery.py"""
    file_path = "node_discovery.py"
    if not os.path.exists(file_path):
        logging.error(f"Error: file {file_path} not found")
        return False
    
    # Create backup of the file
    if not backup_file(file_path):
        return False
    
    try:
        # Changes to make
        changes = [
            # Fix connection timeout
            (r'timeout = self.config.getint\(\'Network\', \'connection_timeout\', fallback=5\)', 
             'timeout = self.config.getint(\'Network\', \'connection_timeout\', fallback=10)  # Increased timeout for better connectivity'),
            
            # Fix port issues in DNS resolution
            (r'peer_addr = f"{ip}:{port}"', 
             'peer_addr = f"{ip}:{port}" if ":" not in ip else ip'),
            
            # Fix IP check for is_ip_address
            (r'def is_ip_address\(self, addr\):(.*?)return False', 
             'def is_ip_address(self, addr):\\n        try:\\n            # Remove port if present\\n            ip_part = addr.split(":")[0]\\n            socket.inet_aton(ip_part)\\n            return True\\n        except socket.error:\\n            return False', re.DOTALL),
             
            # Fix UPnP logging error
            (r'logging.error\("UPnP error: Success"\)', 
             'logging.info("UPnP port mapping successful")'),
             
            # Improve UPnP port mapping setup
            (r'def setup_port_mapping\(self\):(.*?)except Exception as e:(.*?)logging.error\(f"UPnP error: {e}"\)', 
             'def setup_port_mapping(self):\\n        """Setup UPnP port mapping with better error handling"""\\n        try:\\n            upnp = miniupnpc.UPnP()\\n            upnp.discoverdelay = 200  # Higher discovery delay to find devices\\n            devices = upnp.discover()\\n            if devices == 0:\\n                logging.warning("No UPnP devices found")\\n                return False\\n                \\n            upnp.selectigd()\\n            self.upnp_device = upnp\\n            \\n            # Get external IP address\\n            try:\\n                external_ip = upnp.externalipaddress()\\n                logging.info(f"UPnP device found. External IP: {external_ip}")\\n            except Exception as e:\\n                logging.warning(f"UPnP device found but couldn\'t get external IP: {e}")\\n                \\n            # Check if port is already mapped\\n            try:\\n                existing_mapping = upnp.getspecificportmapping(self.external_port, \'TCP\')\\n                if existing_mapping:\\n                    # Port is already mapped. Check if it\'s ours\\n                    if "QNet Node" in str(existing_mapping):\\n                        logging.info(f"Found existing UPnP mapping for QNet Node on port {self.external_port}")\\n                        self.port_mapped = True\\n                        return True\\n                    else:\\n                        # Port is mapped by another application, try another port\\n                        alternate_port = self.external_port + 1\\n                        logging.warning(f"Port {self.external_port} already mapped. Trying port {alternate_port}")\\n                        self.external_port = alternate_port\\n            except Exception as e:\\n                logging.debug(f"Error checking port mapping: {e}")\\n            \\n            # Add port mapping\\n            try:\\n                upnp.addportmapping(\\n                    self.external_port,\\n                    \'TCP\',\\n                    upnp.lanaddr,\\n                    self.internal_port,\\n                    \'QNet Node\',\\n                    \'\'\\n                )\\n                self.port_mapped = True\\n                logging.info(f"Successfully mapped port {self.internal_port} (internal) to {self.external_port} (external)")\\n                # Update own address if it uses internal port\\n                if self.own_address.endswith(f":{self.internal_port}"):\\n                    parts = self.own_address.split(":")\\n                    if len(parts) == 2:\\n                        host = parts[0]\\n                        self.own_address = f"{host}:{self.external_port}"\\n                        logging.info(f"Updated own address to: {self.own_address}")\\n                return True\\n            except Exception as e:\\n                if "UPnP error: Success" in str(e):\\n                    # This is a misleading error message in some UPnP implementations\\n                    # The mapping was actually successful\\n                    logging.info("UPnP port mapping successful")\\n                    self.port_mapped = True\\n                    return True\\n                else:\\n                    logging.error(f"UPnP port mapping error: {e}")', re.DOTALL),
             
            # Enhance discovery threads
            (r'def start_discovery_threads\(self\):(.*?)logging.info\(f"Started {len\(threads\)} discovery mechanisms"\)', 
             'def start_discovery_threads(self):\\n        """Start discovery threads"""\\n        # Multiple discovery methods for redundancy\\n        threads = [\\n            threading.Thread(target=self.dns_discovery_loop, daemon=True),\\n            threading.Thread(target=self.broadcast_discovery_loop, daemon=True),\\n            threading.Thread(target=self.predefined_peers_discovery, daemon=True),\\n            threading.Thread(target=self.network_scan_discovery, daemon=True),\\n            # New periodic tasks\\n            threading.Thread(target=self.upnp_refresh_loop, daemon=True),\\n            threading.Thread(target=self.peers_health_check, daemon=True)\\n        ]\\n        \\n        for thread in threads:\\n            thread.start()\\n            \\n        logging.info(f"Started {len(threads)} discovery mechanisms")', re.DOTALL),
             
            # Add new methods for improved discovery
            (r'def stop\(self\):(.*?)', 
             'def upnp_refresh_loop(self):\\n        """Periodically refresh the UPnP mapping"""\\n        while self.running:\\n            if self.port_mapped and self.upnp_enabled:\\n                self.refresh_port_mapping()\\n            time.sleep(300)  # Every 5 minutes\\n    \\n    def peers_health_check(self):\\n        """Periodically check peer health and remove non-responding peers"""\\n        while self.running:\\n            try:\\n                current_peers = list(self.peers.keys())\\n                now = time.time()\\n                \\n                for peer in current_peers:\\n                    # Only check peers that haven\'t been seen for a while\\n                    last_seen = self.peers.get(peer, 0)\\n                    if now - last_seen > 3600:  # 1 hour\\n                        # Try to connect\\n                        if not self.verify_peer(peer):\\n                            # If connection fails, remove peer\\n                            if peer in self.peers:\\n                                logging.info(f"Removing dead peer: {peer}")\\n                                del self.peers[peer]\\n            except Exception as e:\\n                logging.error(f"Error in peer health check: {e}")\\n                \\n            time.sleep(1800)  # Check every 30 minutes\\n            \\n    def stop(self):', re.DOTALL),
            
            # Add verify_peer method
            (r'def verify_and_add_peer\(self, peer_addr\):', 
             'def verify_peer(self, peer_addr, timeout=2):\\n        """Verify if a peer is responsive (used for health checks)"""\\n        try:\\n            # Try to connect with reasonable timeout\\n            response = requests.head(f"http://{peer_addr}/", timeout=timeout)\\n            return response.status_code == 200\\n        except Exception:\\n            # Connection failed\\n            return False\\n    \\n    def verify_and_add_peer(self, peer_addr):', re.DOTALL),
            
            # Improve peer verification method
            (r'def verify_and_add_peer\(self, peer_addr\):(.*?)return False', 
             'def verify_and_add_peer(self, peer_addr):\\n        """Verify if address is a QNet node and add to peers if valid"""\\n        try:\\n            # First try a fast HEAD request\\n            response = requests.head(f"http://{peer_addr}/", timeout=1)\\n            if response.status_code != 200:\\n                return False\\n                \\n            # Then verify it\'s actually a QNet node\\n            response = requests.get(f"http://{peer_addr}/chain", timeout=3)\\n            if response.status_code == 200:\\n                data = response.json()\\n                if "chain" in data and "length" in data:\\n                    # Looks like a valid QNet node\\n                    logging.info(f"Discovered and verified peer: {peer_addr}")\\n                    self.add_peer(peer_addr)\\n                    self.verified_peers.add(peer_addr)\\n                    return True\\n        except Exception as e:\\n            logging.debug(f"Failed to verify peer {peer_addr}: {e}")\\n            \\n        return False', re.DOTALL),
        ]
        
        content = ""
        with open(file_path, 'r') as f:
            content = f.read()
        
        for pattern, replacement in changes:
            content = re.sub(pattern, replacement, content)
        
        with open(file_path, 'w') as f:
            f.write(content)
        
        logging.info(f"Successfully updated {file_path}")
        return True
        
    except Exception as e:
        logging.error(f"Error fixing {file_path}: {e}")
        return False

def fix_node_py():
    """Fixes issues in node.py"""
    file_path = "node.py"
    if not os.path.exists(file_path):
        logging.error(f"Error: {file_path} not found")
        return False
    
    # Create backup of the file
    if not backup_file(file_path):
        return False
    
    try:
        # Changes to make
        changes = [
            # Fix sync_from_peer
            (r'def sync_from_peer\(peer, timeout\):(.*?)return False', 
             'def sync_from_peer(peer, timeout):\\n    """\\n    Syncs from a single peer\\n    """\\n    try:\\n        # First check if peer is reachable with a ping\\n        response = requests.head(f"http://{peer}/", timeout=timeout/2)\\n        # If ping successful, proceed with chain sync\\n        if response.status_code >= 200:\\n            response = requests.get(f"http://{peer}/chain", timeout=timeout)\\n            if response.status_code == 200:\\n                # Successfully connected to peer\\n                config.peers[peer] = time.time()\\n                return True\\n            return False\\n    except Exception as e:\\n        logging.debug(f"Failed to sync from peer {peer}: {e}")\\n        return False', re.DOTALL),
            
            # Improve auto_discover_peers
            (r'for peer in current_peers:(.*?)logging.error\(f"Error gossiping to {peer}: {e}"\)(.*?)error_count \+= 1', 
             'for peer in current_peers:\\n            try:\\n                # First check if peer is alive\\n                ping_response = requests.head(f"http://{peer}/", timeout=timeout/2)\\n                if ping_response.status_code < 200 or ping_response.status_code >= 500:\\n                    continue  # Skip unresponsive peers\\n                    \\n                url = f"http://{peer}/receive_peers"\\n                payload = {\\n                    "peers": current_peers,\\n                    "timestamp": time.time(),\\n                    "peer_address": config.own_address,\\n                    "node_id": config.node_id\\n                }\\n                response = requests.post(url, json=payload, timeout=timeout)\\n                if response.status_code == 200:\\n                    config.peers[peer] = time.time()\\n                    logging.info(f"Gossiped to {peer}: {payload}")\\n                    success_count += 1\\n                else:\\n                    error_count += 1\\n            except Exception as e:\\n                logging.debug(f"Error gossiping to {peer}: {e}")\\n                error_count += 1', re.DOTALL),
            
            # Add improved network scan integration
            (r'def auto_discover_peers\(\):(.*?)# Discover peers from others', 
             'def auto_discover_peers():\\n    # Get gossip interval from config\\n    GOSSIP_INTERVAL = app_config.getint(\'Network\', \'gossip_interval\', fallback=30)\\n    error_count = 0\\n    success_count = 0\\n\\n    # Perform network scan every 5 minutes\\n    scan_interval = 300\\n    last_scan = 0\\n\\n    while True:\\n        time.sleep(GOSSIP_INTERVAL)\\n        current_time = time.time()\\n        \\n        # Periodically scan network for QNet nodes\\n        if current_time - last_scan > scan_interval:\\n            try:\\n                logging.info("Scanning network for QNet nodes...")\\n                found_nodes = scan_for_nodes()\\n                for node_addr in found_nodes:\\n                    if node_addr not in config.peers and node_addr != config.own_address:\\n                        config.peers[node_addr] = time.time()\\n                        config.reputation[node_addr] = 1.0\\n                        logging.info(f"Discovered new peer via scan: {node_addr}")\\n                last_scan = current_time\\n            except Exception as e:\\n                logging.error(f"Error scanning for nodes: {e}")\\n\\n        current_peers = list(config.peers.keys())\\n        # Send our peer info (with node_id) to others', re.DOTALL),
        ]
        
        content = ""
        with open(file_path, 'r') as f:
            content = f.read()
        
        for pattern, replacement in changes:
            content = re.sub(pattern, replacement, content)
        
        with open(file_path, 'w') as f:
            f.write(content)
        
        logging.info(f"Successfully updated {file_path}")
        return True
        
    except Exception as e:
        logging.error(f"Error fixing {file_path}: {e}")
        return False

def install_required_packages():
    """Installs any required packages for node discovery"""
    try:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "dnspython", "miniupnpc", "requests"])
        logging.info("Successfully installed required packages")
        return True
    except Exception as e:
        logging.error(f"Error installing packages: {e}")
        return False

if __name__ == "__main__":
    logging.info("Fixing QNet node discovery issues...")
    install_required_packages()
    fix_node_discovery_py()
    fix_node_py()
    logging.info("Fixes completed. Please rebuild the container.")