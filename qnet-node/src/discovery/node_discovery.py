#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: node_discovery.py
Implements advanced node discovery mechanisms for QNet.
"""

import socket
import logging
import dns.resolver
import requests
import threading
import time
import random
import json
import os
import miniupnpc
from ipaddress import ip_address, ip_network
import hashlib

class NodeDiscoveryManager:
    def __init__(self, own_address, peers_dict, config):
        """Initialize node discovery manager"""
        self.own_address = own_address
        self.peers = peers_dict
        self.config = config
        self.running = True
        self.dns_seeds = self.config.get('Network', 'dns_seeds', fallback='').split(',')
        self.upnp_enabled = self.config.getboolean('Network', 'use_upnp', fallback=True)
        self.broadcast_enabled = self.config.getboolean('Network', 'use_broadcast', fallback=True)
        self.discovery_interval = self.config.getint('Network', 'discovery_interval', fallback=300)
        
        # Get port configuration
        self.internal_port = self.config.getint('Node', 'port', fallback=8000)
        self.external_port = int(os.environ.get('QNET_PORT', self.internal_port))
        
        # Create a list to store all potential peers
        self.potential_peers = []
        
        # Tracks verified peers to avoid excessive verification
        self.verified_peers = set()
        
        # Use exponential backoff for failed verifications
        self.failed_verifications = {}
        
        # Port mapping via UPnP
        self.port_mapped = False
        self.upnp_device = None
        if self.upnp_enabled:
            self.setup_port_mapping()
            
        # Start discovery mechanisms
        self.start_discovery_threads()
        
    def setup_port_mapping(self):
        """Setup UPnP port mapping with better error handling"""
        try:
            upnp = miniupnpc.UPnP()
            upnp.discoverdelay = 200  # Higher discovery delay to find devices
            devices = upnp.discover()
            if devices == 0:
                logging.warning("No UPnP devices found")
                return False
                
            upnp.selectigd()
            self.upnp_device = upnp
            
            # Get external IP address
            try:
                external_ip = upnp.externalipaddress()
                logging.info(f"UPnP device found. External IP: {external_ip}")
            except Exception as e:
                logging.warning(f"UPnP device found but couldn't get external IP: {e}")
                
            # Check if port is already mapped
            try:
                existing_mapping = upnp.getspecificportmapping(self.external_port, 'TCP')
                if existing_mapping:
                    # Port is already mapped. Check if it's ours
                    if "QNet Node" in str(existing_mapping):
                        logging.info(f"Found existing UPnP mapping for QNet Node on port {self.external_port}")
                        self.port_mapped = True
                        return True
                    else:
                        # Port is mapped by another application, try another port
                        alternate_port = self.external_port + 1
                        logging.warning(f"Port {self.external_port} already mapped. Trying port {alternate_port}")
                        self.external_port = alternate_port
            except Exception as e:
                logging.debug(f"Error checking port mapping: {e}")
            
            # Add port mapping
            try:
                upnp.addportmapping(
                    self.external_port,
                    'TCP',
                    upnp.lanaddr,
                    self.internal_port,
                    'QNet Node',
                    ''
                )
                self.port_mapped = True
                logging.info(f"Successfully mapped port {self.internal_port} (internal) to {self.external_port} (external)")
                # Update own address if it uses internal port
                if self.own_address.endswith(f":{self.internal_port}"):
                    parts = self.own_address.split(":")
                    if len(parts) == 2:
                        host = parts[0]
                        self.own_address = f"{host}:{self.external_port}"
                        logging.info(f"Updated own address to: {self.own_address}")
                return True
            except Exception as e:
                if "UPnP error: Success" in str(e):
                    # This is a misleading error message in some UPnP implementations
                    # The mapping was actually successful
                    logging.info("UPnP port mapping successful")
                    self.port_mapped = True
                    return True
                else:
                    logging.error(f"UPnP port mapping error: {e}")
                    return False
        except Exception as e:
            logging.error(f"UPnP setup error: {e}")
            return False
            
    def refresh_port_mapping(self):
        """Refresh the UPnP port mapping periodically"""
        if not self.port_mapped or not self.upnp_device:
            return False
            
        try:
            # First check if mapping still exists
            existing_mapping = self.upnp_device.getspecificportmapping(self.external_port, 'TCP')
            if not existing_mapping:
                logging.warning("UPnP port mapping lost. Recreating...")
                self.setup_port_mapping()
                return True
                
            # Refresh the mapping by adding it again
            self.upnp_device.addportmapping(
                self.external_port,
                'TCP',
                self.upnp_device.lanaddr,
                self.internal_port,
                'QNet Node',
                ''
            )
            logging.debug("UPnP port mapping refreshed")
            return True
        except Exception as e:
            logging.error(f"Error refreshing UPnP mapping: {e}")
            # Try to recreate mapping
            self.port_mapped = False
            self.setup_port_mapping()
            return False
        
    def remove_port_mapping(self):
        """Remove UPnP port mapping when shutting down"""
        if self.port_mapped and self.upnp_device:
            try:
                self.upnp_device.deleteportmapping(self.external_port, 'TCP')
                logging.info(f"Port mapping {self.external_port} removed")
                self.port_mapped = False
                return True
            except Exception as e:
                logging.error(f"Error removing port mapping: {e}")
                return False
        return False
    
    def start_discovery_threads(self):
        """Start discovery threads"""
        # Multiple discovery methods for redundancy
        threads = [
            threading.Thread(target=self.dns_discovery_loop, daemon=True),
            threading.Thread(target=self.broadcast_discovery_loop, daemon=True),
            threading.Thread(target=self.predefined_peers_discovery, daemon=True),
            threading.Thread(target=self.network_scan_discovery, daemon=True),
            # New periodic tasks
            threading.Thread(target=self.upnp_refresh_loop, daemon=True),
            threading.Thread(target=self.peers_health_check, daemon=True)
        ]
        
        for thread in threads:
            thread.start()
            
        logging.info(f"Started {len(threads)} discovery mechanisms")
    
    def upnp_refresh_loop(self):
        """Periodically refresh the UPnP mapping"""
        while self.running:
            if self.port_mapped and self.upnp_enabled:
                self.refresh_port_mapping()
            time.sleep(300)  # Every 5 minutes
    
    def peers_health_check(self):
        """Periodically check peer health and remove non-responding peers"""
        while self.running:
            try:
                current_peers = list(self.peers.keys())
                now = time.time()
                
                for peer in current_peers:
                    # Only check peers that haven't been seen for a while
                    last_seen = self.peers.get(peer, 0)
                    if now - last_seen > 3600:  # 1 hour
                        # Try to connect
                        if not self.verify_peer(peer):
                            # If connection fails, remove peer
                            if peer in self.peers:
                                logging.info(f"Removing dead peer: {peer}")
                                del self.peers[peer]
            except Exception as e:
                logging.error(f"Error in peer health check: {e}")
                
            time.sleep(1800)  # Check every 30 minutes
            
    def dns_discovery_loop(self):
        """Periodically discover peers through DNS seeds"""
        while self.running:
            try:
                for seed in self.dns_seeds:
                    if not seed.strip():
                        continue
                        
                    # Check if seed is an IP address already
                    if self.is_ip_address(seed.strip()):
                        ip = seed.strip()
                        # Try multiple common ports
                        for port in [8000, 8001, 8002, 80, 443]:
                            peer_addr = f"{ip}:{port}"
                            if peer_addr not in self.potential_peers and peer_addr != self.own_address:
                                self.potential_peers.append(peer_addr)
                        continue
                        
                    # Otherwise try DNS resolution
                    try:
                        answers = dns.resolver.resolve(seed.strip(), 'A')
                        for answer in answers:
                            ip = answer.to_text()
                            # Try multiple common ports
                            for port in [8000, 8001, 8002, 80, 443]:
                                peer_addr = f"{ip}:{port}"
                                if peer_addr not in self.potential_peers and peer_addr != self.own_address:
                                    self.potential_peers.append(peer_addr)
                    except dns.exception.DNSException as e:
                        logging.warning(f"DNS resolution error for {seed}: {e}")
            except Exception as e:
                logging.error(f"Error in DNS discovery: {e}")
                
            # Process potential peers
            self.process_potential_peers()
                
            # Sleep for a random time to avoid synchronization issues
            sleep_time = self.discovery_interval + random.randint(-30, 30)
            time.sleep(max(60, sleep_time))  # At least 60 seconds
    
    def predefined_peers_discovery(self):
        """Use predefined peers from bootstrap_nodes"""
        while self.running:
            try:
                bootstrap_nodes = self.config.get('Network', 'bootstrap_nodes', fallback='').split(',')
                for node in bootstrap_nodes:
                    if node.strip() and node.strip() != self.own_address:
                        if node.strip() not in self.potential_peers:
                            self.potential_peers.append(node.strip())
            except Exception as e:
                logging.error(f"Error processing bootstrap nodes: {e}")
                
            # Process potential peers
            self.process_potential_peers()
            
            # Sleep for longer time as these are fixed
            time.sleep(300)  # 5 minutes
    
    def network_scan_discovery(self):
        """Scan local network for other nodes"""
        while self.running:
            try:
                # Get local network address
                local_ip = self.get_local_ip()
                if not local_ip:
                    time.sleep(300)
                    continue
                    
                # Extract subnet
                parts = local_ip.split('.')
                if len(parts) != 4:
                    time.sleep(300)
                    continue
                    
                subnet = f"{parts[0]}.{parts[1]}.{parts[2]}"
                
                # Scan for common Docker and VM addresses
                scan_ips = [
                    # Docker default subnet
                    "172.17.0.2", "172.17.0.3", "172.17.0.4", "172.17.0.5",
                    # Common VM/container addresses
                    f"{subnet}.1", f"{subnet}.2", f"{subnet}.3", f"{subnet}.100", f"{subnet}.101",
                    # Docker custom network
                    "172.20.0.2", "172.20.0.3", "172.20.0.4"
                ]
                
                # Also scan a few local network addresses
                for i in range(2, 20):
                    scan_ips.append(f"{subnet}.{i}")
                
                for ip in scan_ips:
                    if ip != local_ip.split(':')[0]:  # Don't scan ourselves
                        # Try common ports
                        for port in [8000, 8001, 8002]:
                            peer_addr = f"{ip}:{port}"
                            if peer_addr != self.own_address and peer_addr not in self.potential_peers:
                                self.potential_peers.append(peer_addr)
            except Exception as e:
                logging.error(f"Error in network scan: {e}")
                
            # Process potential peers
            self.process_potential_peers()
                
            # Sleep between scans to avoid network flooding
            time.sleep(600)  # 10 minutes between scans
    
    def process_potential_peers(self):
        """Process potential peers and try to connect to them"""
        # Processing a limited number of peers per batch to avoid overwhelming the network
        MAX_BATCH_SIZE = 10
        
        # Remove duplicates and filter out known peers
        unique_peers = []
        for peer in self.potential_peers:
            if (peer not in unique_peers and 
                peer != self.own_address and 
                peer not in self.peers and 
                peer not in self.verified_peers):
                unique_peers.append(peer)
        
        # Process only a batch
        batch = unique_peers[:MAX_BATCH_SIZE]
        # Remove processed peers from potential peers list
        self.potential_peers = [p for p in self.potential_peers if p not in batch]
        
        # Try to connect to each potential peer
        for peer_addr in batch:
            now = time.time()
            
            # Check if we've tried this peer recently and failed
            last_attempt = self.failed_verifications.get(peer_addr, 0)
            backoff_time = min(3600, 2 ** (self.failed_verifications.get(peer_addr + "_count", 0)) * 60)
            
            if now - last_attempt < backoff_time:
                # Skip this peer for now due to backoff
                continue
                
            # Try to verify and add peer
            if self.verify_and_add_peer(peer_addr):
                # Successful verification, remove from failed list
                if peer_addr in self.failed_verifications:
                    del self.failed_verifications[peer_addr]
                if peer_addr + "_count" in self.failed_verifications:
                    del self.failed_verifications[peer_addr + "_count"]
            else:
                # Failed verification, update backoff
                self.failed_verifications[peer_addr] = now
                self.failed_verifications[peer_addr + "_count"] = self.failed_verifications.get(peer_addr + "_count", 0) + 1
    
    def verify_peer(self, peer_addr, timeout=2):
        """Verify if a peer is responsive (used for health checks)"""
        try:
            # Try to connect with reasonable timeout
            response = requests.head(f"http://{peer_addr}/", timeout=timeout)
            return response.status_code == 200
        except Exception:
            # Connection failed
            return False
    
    def verify_and_add_peer(self, peer_addr):
        """Verify if address is a QNet node and add to peers if valid"""
        try:
            # First try a fast HEAD request
            response = requests.head(f"http://{peer_addr}/", timeout=1)
            if response.status_code != 200:
                return False
                
            # Then verify it's actually a QNet node
            response = requests.get(f"http://{peer_addr}/chain", timeout=3)
            if response.status_code == 200:
                data = response.json()
                if "chain" in data and "length" in data:
                    # Looks like a valid QNet node
                    logging.info(f"Discovered and verified peer: {peer_addr}")
                    self.add_peer(peer_addr)
                    self.verified_peers.add(peer_addr)
                    return True
        except Exception as e:
            logging.debug(f"Failed to verify peer {peer_addr}: {e}")
            
        return False
    
    def get_local_ip(self):
        """Get local IP address with multiple fallbacks"""
        try:
            # Try preferred method
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(('8.8.8.8', 80))
            ip = s.getsockname()[0]
            s.close()
            return ip
        except Exception:
            # Fallback 1: Get hostname
            try:
                hostname = socket.gethostname()
                ip = socket.gethostbyname(hostname)
                if ip != "127.0.0.1":
                    return ip
            except Exception:
                pass
            
            # Fallback 2: Iterate through interfaces
            try:
                import netifaces
                for interface in netifaces.interfaces():
                    addrs = netifaces.ifaddresses(interface)
                    if netifaces.AF_INET in addrs:
                        for addr in addrs[netifaces.AF_INET]:
                            if 'addr' in addr and addr['addr'] != '127.0.0.1':
                                return addr['addr']
            except ImportError:
                # netifaces not available, try another approach
                try:
                    # Check common interfaces
                    import subprocess
                    for cmd in [
                        "ifconfig | grep 'inet ' | grep -v '127.0.0.1' | awk '{print $2}'",
                        "ip addr | grep 'inet ' | grep -v '127.0.0.1' | awk '{print $2}' | cut -d'/' -f1"
                    ]:
                        try:
                            result = subprocess.check_output(cmd, shell=True).decode().strip()
                            if result:
                                return result.split("\n")[0]
                        except:
                            continue
                except:
                    pass
            
            # Last resort fallback
            return "172.17.0.2"  # Common Docker IP
    
    def is_ip_address(self, addr):
        """Check if the address is an IP address (improved version)"""
        try:
            # Remove port if present
            ip_part = addr.split(":")[0]
            socket.inet_aton(ip_part)
            return True
        except socket.error:
            return False
            
    def broadcast_discovery_loop(self):
        """Periodically discover peers through network broadcasts"""
        while self.running:
            try:
                if self.broadcast_enabled:
                    # Send broadcast
                    self.send_broadcast_discovery()
                    
                    # Also try mDNS/Bonjour discovery if available
                    self.mdns_discovery()
            except Exception as e:
                logging.error(f"Error in broadcast discovery: {e}")
                
            # Process potential peers
            self.process_potential_peers()
                
            # Sleep for a random time to avoid synchronization issues
            sleep_time = self.discovery_interval + random.randint(-30, 30)
            time.sleep(max(60, sleep_time))  # At least 60 seconds
    
    def send_broadcast_discovery(self):
        """Send UDP broadcast to discover peers in local network"""
        try:
            # Create UDP socket
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                # Enable broadcasting
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
                
                # Discovery message
                discovery_msg = {
                    "action": "discovery",
                    "node_address": self.own_address,
                    "timestamp": time.time(),
                    "version": "1.0.0" # Protocol version
                }
                
                # Send to multiple broadcast addresses
                broadcast_addresses = [
                    '255.255.255.255',  # Global broadcast
                    '172.17.255.255',   # Docker default subnet broadcast
                    '172.20.255.255',   # Docker custom subnet broadcast
                    '10.255.255.255'    # Common private network broadcast
                ]
                
                # Get local subnet for directed broadcast
                local_ip = self.get_local_ip()
                if local_ip:
                    parts = local_ip.split('.')
                    if len(parts) == 4:
                        subnet = f"{parts[0]}.{parts[1]}.{parts[2]}.255"
                        broadcast_addresses.append(subnet)
                
                for addr in broadcast_addresses:
                    try:
                        sock.sendto(json.dumps(discovery_msg).encode(), (addr, self.internal_port))
                    except:
                        pass  # Ignore errors for individual addresses
                        
                logging.debug("Sent broadcast discovery messages")
        except Exception as e:
            logging.error(f"Failed to send broadcast discovery: {e}")
    
    def mdns_discovery(self):
        """Try mDNS/Bonjour discovery if available"""
        try:
            # Check if zeroconf is available
            import importlib.util
            zeroconf_spec = importlib.util.find_spec("zeroconf")
            
            if zeroconf_spec is not None:
                # Zeroconf is available
                from zeroconf import ServiceBrowser, Zeroconf
                
                class QNetListener:
                    def __init__(self, parent):
                        self.parent = parent
                        
                    def add_service(self, zc, type_, name):
                        info = zc.get_service_info(type_, name)
                        if info:
                            addr = socket.inet_ntoa(info.addresses[0])
                            port = info.port
                            peer = f"{addr}:{port}"
                            
                            if peer not in self.parent.potential_peers and peer != self.parent.own_address:
                                self.parent.potential_peers.append(peer)
                                logging.info(f"mDNS discovered peer: {peer}")
                
                # Create browser and start browsing for QNet services
                zeroconf = Zeroconf()
                listener = QNetListener(self)
                browser = ServiceBrowser(zeroconf, "_qnet._tcp.local.", listener)
                
                # Give it some time to discover services
                time.sleep(2)
                
                # Clean up
                browser.cancel()
                zeroconf.close()
                
        except ImportError:
            # zeroconf not available, skip
            pass
        except Exception as e:
            logging.debug(f"mDNS discovery error: {e}")
    
    def add_peer(self, peer_addr):
        """Add discovered peer to the peers list"""
        if peer_addr not in self.peers and peer_addr != self.own_address:
            self.peers[peer_addr] = time.time()
            
            # Try to connect to peer
            try:
                response = requests.get(f"http://{peer_addr}/chain", timeout=5)
                if response.status_code == 200:
                    logging.info(f"Successfully connected to peer {peer_addr}")
                    
                    # After successful connection, try to get peer's peers
                    self.get_peers_peers(peer_addr)
                    
                    return True
            except Exception as e:
                logging.debug(f"Failed to connect to discovered peer {peer_addr}: {e}")
                
            return False
        return False
    
    def get_peers_peers(self, peer_addr):
        """Get peers from a peer (recursively discover network)"""
        try:
            response = requests.get(f"http://{peer_addr}/get_peers", timeout=5)
            if response.status_code == 200:
                data = response.json()
                new_peers = data.get("peers", {})
                
                # Add these to potential peers
                peer_count = 0
                for new_peer in new_peers:
                    if new_peer != self.own_address and new_peer not in self.peers:
                        self.potential_peers.append(new_peer)
                        peer_count += 1
                        
                if peer_count > 0:
                    logging.info(f"Got {peer_count} additional peers from {peer_addr}")
                    
                return True
        except Exception as e:
            logging.debug(f"Failed to get peers from {peer_addr}: {e}")
            
        return False
    
    def stop(self):
        """Stop discovery and clean up"""
        self.running = False
        if self.port_mapped:
            self.remove_port_mapping()


# UDP server for handling broadcast discovery requests
class DiscoveryUDPServer:
    def __init__(self, own_address, peers_dict, port=8000):
        """Initialize UDP server for discovery"""
        self.own_address = own_address
        self.peers = peers_dict
        self.port = port
        self.running = True
        self.server_thread = None
        
        # Keep track of recently seen messages by hash to prevent duplicates
        self.recent_messages = {}
        self.recent_messages_lock = threading.Lock()
        
    def start(self):
        """Start UDP server in a separate thread"""
        self.server_thread = threading.Thread(target=self.run_server, daemon=True)
        self.server_thread.start()
        logging.info(f"Discovery UDP server started on port {self.port}")
        
        # Start a thread to clean up recent messages periodically
        cleanup_thread = threading.Thread(target=self.clean_recent_messages, daemon=True)
        cleanup_thread.start()
        
    def run_server(self):
        """Run UDP server to listen for discovery broadcasts"""
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                # Set socket options to allow reuse of address
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                
                # Bind to all interfaces
                sock.bind(('0.0.0.0', self.port))
                sock.settimeout(1.0)  # 1 second timeout for graceful shutdown
                
                while self.running:
                    try:
                        data, addr = sock.recvfrom(1024)
                        self.handle_request(data, addr)
                    except socket.timeout:
                        continue  # Just a timeout, continue the loop
                    except Exception as e:
                        logging.error(f"Error in UDP server: {e}")
        except Exception as e:
            logging.error(f"Failed to start UDP server: {e}")
            
    def clean_recent_messages(self):
        """Clean up old messages from the recent messages cache"""
        while self.running:
            try:
                now = time.time()
                to_remove = []
                
                with self.recent_messages_lock:
                    for msg_hash, timestamp in self.recent_messages.items():
                        if now - timestamp > 60:  # Remove messages older than 1 minute
                            to_remove.append(msg_hash)
                            
                    for msg_hash in to_remove:
                        del self.recent_messages[msg_hash]
            except Exception as e:
                logging.error(f"Error cleaning recent messages: {e}")
                
            time.sleep(30)  # Run every 30 seconds
            
    def handle_request(self, data, addr):
        """Handle incoming discovery request"""
        try:
            # Parse the message
            message = json.loads(data.decode())
            
            if message.get("action") == "discovery":
                sender_addr = message.get("node_address")
                timestamp = message.get("timestamp", 0)
                
                # Check if the message is recent (within last minute)
                if time.time() - timestamp > 60:
                    return
                
                # Calculate message hash to prevent duplicates
                msg_hash = hashlib.md5(data).hexdigest()
                
                with self.recent_messages_lock:
                    # Check if we've seen this message recently
                    if msg_hash in self.recent_messages:
                        return
                    
                    # Record that we've seen this message
                    self.recent_messages[msg_hash] = time.time()
                
                # Add the peer if not already known
                if sender_addr and sender_addr != self.own_address and sender_addr not in self.peers:
                    self.peers[sender_addr] = time.time()
                    logging.info(f"Received discovery broadcast from {sender_addr}")
                    
                    # Send response
                    self.send_response(addr[0], sender_addr)
        except json.JSONDecodeError:
            logging.debug(f"Received invalid JSON data from {addr}")
        except Exception as e:
            logging.error(f"Error handling discovery request: {e}")
            
    def send_response(self, target_ip, target_addr):
        """Send response to the discovery request"""
        try:
            # Extract port from target_addr
            if ":" in target_addr:
                _, port = target_addr.split(":")
                target_url = f"http://{target_ip}:{port}/receive_peers"
                
                # Prepare a subset of peers to share (max 20)
                peers_to_share = list(self.peers.keys())
                if len(peers_to_share) > 20:
                    peers_to_share = random.sample(peers_to_share, 20)
                
                requests.post(
                    target_url,
                    json={
                        "peers": peers_to_share,
                        "peer_address": self.own_address,
                        "timestamp": time.time()
                    },
                    timeout=2
                )
                logging.debug(f"Sent discovery response to {target_addr}")
        except Exception as e:
            logging.debug(f"Failed to send discovery response: {e}")
            
    def stop(self):
        """Stop the UDP server"""
        self.running = False
        if self.server_thread:
            self.server_thread.join(timeout=2)