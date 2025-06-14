#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: node_discovery.py
Implements enhanced node discovery mechanisms for QNet with improved
resilience, performance, and security.
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
import hashlib
import ipaddress
import concurrent.futures
from typing import Dict, List, Set, Tuple, Optional, Any, Union
from collections import defaultdict
import miniupnpc
from urllib.parse import urlparse

# Configure logging
logging.basicConfig(level=logging.INFO,
                    format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

class NodeDiscoveryManager:
    """
    Enhanced node discovery manager for QNet with multiple discovery methods,
    better error handling, and optimized performance.
    """
    
    def __init__(self, own_address: str, peers_dict: Dict[str, float], config: Any):
        """
        Initialize node discovery manager.
        
        Args:
            own_address: Address of this node (ip:port)
            peers_dict: Dictionary of known peers (address -> last_seen)
            config: Configuration object
        """
        self.own_address = own_address
        self.peers = peers_dict
        self.config = config
        
        # Parse own address components
        self.own_host, self.own_port = self._parse_address(own_address)
        
        # Runtime state
        self.running = True
        self.verified_peers = set()  # Peers that have been successfully verified
        self.failed_verifications = {}  # Peer -> {count, last_attempt}
        self.potential_peers = []  # List of peers to try connecting to
        
        # Network configuration
        self.dns_seeds = self._parse_dns_seeds()
        self.upnp_enabled = self.config.getboolean('Network', 'use_upnp', fallback=True)
        self.broadcast_enabled = self.config.getboolean('Network', 'use_broadcast', fallback=True)
        self.discovery_interval = self.config.getint('Network', 'discovery_interval', fallback=300)
        
        # Port configuration
        self.internal_port = self.config.getint('Node', 'port', fallback=8000)
        self.external_port = int(os.environ.get('QNET_PORT', self.internal_port))
        
        # UPnP state
        self.port_mapped = False
        self.upnp_device = None
        
        # Blacklist for known bad IPs
        self.blacklist = self._load_blacklist()
        
        # Response cache to reduce network load
        self.response_cache = {}
        self.cache_expiry = 60  # seconds
        
        # Thread synchronization
        self.lock = threading.RLock()
        
        # Performance metrics for different discovery methods
        self.discovery_metrics = {
            "dns_discovered": 0,
            "broadcast_discovered": 0,
            "upnp_discovered": 0,
            "bootstrap_discovered": 0,
            "peer_exchange_discovered": 0
        }
        
        # Set up UPnP if enabled
        if self.upnp_enabled:
            self.setup_port_mapping()
        
        # Start discovery threads
        self.start_discovery_threads()
        
        logger.info(f"Node discovery manager initialized for {own_address}")
    
    def _parse_address(self, address: str) -> Tuple[str, int]:
        """
        Parse an address string into host and port.
        
        Args:
            address: Address string in format 'host:port'
            
        Returns:
            tuple: (host, port)
        """
        try:
            if ':' in address:
                host, port_str = address.split(':', 1)
                port = int(port_str)
                return host, port
            else:
                # Default port if not specified
                return address, self.config.getint('Node', 'port', fallback=8000)
        except (ValueError, TypeError) as e:
            logger.error(f"Error parsing address {address}: {e}")
            # Return default values
            return "127.0.0.1", 8000
    
    def _parse_dns_seeds(self) -> List[str]:
        """
        Parse DNS seeds from config.
        
        Returns:
            list: List of DNS seed hostnames
        """
        dns_seeds_str = self.config.get('Network', 'dns_seeds', fallback='')
        if not dns_seeds_str:
            return []
            
        # Split and strip whitespace
        return [seed.strip() for seed in dns_seeds_str.split(',') if seed.strip()]
    
    def _load_blacklist(self) -> Set[str]:
        """
        Load blacklisted IPs from file if available.
        
        Returns:
            set: Set of blacklisted IPs
        """
        blacklist = set()
        blacklist_file = os.path.join(
            os.environ.get('QNET_DATA_DIR', '/app/data'), 
            'discovery_blacklist.json'
        )
        
        if os.path.exists(blacklist_file):
            try:
                with open(blacklist_file, 'r') as f:
                    data = json.load(f)
                    if 'blacklist' in data and isinstance(data['blacklist'], list):
                        blacklist.update(data['blacklist'])
                logger.info(f"Loaded {len(blacklist)} IPs from discovery blacklist")
            except Exception as e:
                logger.error(f"Error loading blacklist: {e}")
        
        return blacklist
    
    def _save_blacklist(self):
        """Save blacklisted IPs to file."""
        try:
            blacklist_file = os.path.join(
                os.environ.get('QNET_DATA_DIR', '/app/data'), 
                'discovery_blacklist.json'
            )
            
            # Create directory if it doesn't exist
            os.makedirs(os.path.dirname(blacklist_file), exist_ok=True)
            
            with open(blacklist_file, 'w') as f:
                json.dump({
                    'blacklist': list(self.blacklist),
                    'updated_at': time.time()
                }, f)
                
            logger.debug(f"Saved {len(self.blacklist)} IPs to discovery blacklist")
        except Exception as e:
            logger.error(f"Error saving blacklist: {e}")
    
    def setup_port_mapping(self) -> bool:
        """
        Set up UPnP port mapping with improved error handling.
        
        Returns:
            bool: True if mapping is successful, False otherwise
        """
        if not self.upnp_enabled:
            return False
            
        try:
            logger.info("Setting up UPnP port mapping...")
            upnp = miniupnpc.UPnP()
            upnp.discoverdelay = 200  # Higher discovery delay to find devices
            
            # Discover UPnP devices
            devices = upnp.discover()
            if devices == 0:
                logger.warning("No UPnP devices found")
                return False
                
            logger.info(f"Found {devices} UPnP device(s)")
            
            # Select the IGD (Internet Gateway Device)
            upnp.selectigd()
            self.upnp_device = upnp
            
            # Try to get external IP address
            try:
                external_ip = upnp.externalipaddress()
                logger.info(f"UPnP device found. External IP: {external_ip}")
            except Exception as e:
                logger.warning(f"UPnP device found but couldn't get external IP: {e}")
            
            # Check if port is already mapped
            try:
                existing_mapping = upnp.getspecificportmapping(
                    self.external_port, 'TCP'
                )
                
                if existing_mapping:
                    desc = str(existing_mapping)
                    # Check if it's our mapping
                    if "QNet Node" in desc:
                        logger.info(f"Found existing UPnP mapping for QNet Node on port {self.external_port}")
                        self.port_mapped = True
                        return True
                    else:
                        # Port is mapped by another application, try another port
                        alternate_port = self.external_port + 1
                        logger.warning(
                            f"Port {self.external_port} already mapped to another application. "
                            f"Trying port {alternate_port}"
                        )
                        self.external_port = alternate_port
            except Exception as e:
                logger.debug(f"Error checking port mapping: {e}")
            
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
                logger.info(
                    f"Successfully mapped port {self.internal_port} (internal) "
                    f"to {self.external_port} (external)"
                )
                
                # Update own address if it uses internal port
                if self.own_port == self.internal_port:
                    self.own_address = f"{self.own_host}:{self.external_port}"
                    logger.info(f"Updated own address to: {self.own_address}")
                    
                return True
            except Exception as e:
                # Handle misleading error message in some UPnP implementations
                if "UPnP error: Success" in str(e):
                    logger.info("UPnP port mapping successful (despite error message)")
                    self.port_mapped = True
                    return True
                else:
                    logger.error(f"UPnP port mapping error: {e}")
                    return False
        except Exception as e:
            logger.error(f"Error setting up UPnP: {e}")
            return False
    
    def refresh_port_mapping(self) -> bool:
        """
        Refresh the UPnP port mapping to prevent expiration.
        
        Returns:
            bool: True if refresh was successful, False otherwise
        """
        if not self.port_mapped or not self.upnp_device:
            return False
            
        try:
            # Check if mapping still exists
            existing_mapping = self.upnp_device.getspecificportmapping(
                self.external_port, 'TCP'
            )
            
            if not existing_mapping:
                logger.warning("UPnP port mapping lost. Recreating...")
                return self.setup_port_mapping()
                
            # Refresh the mapping
            self.upnp_device.addportmapping(
                self.external_port,
                'TCP',
                self.upnp_device.lanaddr,
                self.internal_port,
                'QNet Node',
                ''
            )
            logger.debug("UPnP port mapping refreshed")
            return True
        except Exception as e:
            logger.error(f"Error refreshing UPnP mapping: {e}")
            
            # Try to recreate mapping
            self.port_mapped = False
            return self.setup_port_mapping()
    
    def remove_port_mapping(self) -> bool:
        """
        Remove UPnP port mapping when shutting down.
        
        Returns:
            bool: True if removal was successful, False otherwise
        """
        if self.port_mapped and self.upnp_device:
            try:
                self.upnp_device.deleteportmapping(self.external_port, 'TCP')
                logger.info(f"Port mapping {self.external_port} removed")
                self.port_mapped = False
                return True
            except Exception as e:
                logger.error(f"Error removing port mapping: {e}")
                return False
        return False
    
    def start_discovery_threads(self):
        """Start all discovery threads with improved reliability."""
        # Multiple discovery methods for redundancy
        threads = [
            threading.Thread(target=self._dns_discovery_loop, daemon=True),
            threading.Thread(target=self._bootstrap_nodes_discovery, daemon=True),
            threading.Thread(target=self._process_potential_peers_loop, daemon=True)
        ]
        
        # Add optional discovery methods based on configuration
        if self.broadcast_enabled:
            threads.append(threading.Thread(target=self._broadcast_discovery_loop, daemon=True))
        
        if self.upnp_enabled:
            threads.append(threading.Thread(target=self._upnp_refresh_loop, daemon=True))
        
        # Add maintenance threads
        threads.append(threading.Thread(target=self._peers_health_check, daemon=True))
        threads.append(threading.Thread(target=self._cache_cleanup_loop, daemon=True))
        
        # Add enhanced discovery methods
        threads.append(threading.Thread(target=self._network_scan_discovery, daemon=True))
        
        # Start all threads
        for thread in threads:
            thread.start()
            
        logger.info(f"Started {len(threads)} discovery mechanisms")
    
    def _dns_discovery_loop(self):
        """Periodically discover peers through DNS seeds."""
        while self.running:
            try:
                for seed in self.dns_seeds:
                    if not seed.strip():
                        continue
                        
                    # Check if seed is an IP address already
                    if self._is_ip_address(seed.strip()):
                        ip = seed.strip()
                        # Try multiple common ports
                        for port in [8000, 8001, 8002, 80, 443]:
                            peer_addr = f"{ip}:{port}"
                            if (peer_addr not in self.potential_peers and 
                                peer_addr != self.own_address and
                                peer_addr not in self.peers):
                                with self.lock:
                                    self.potential_peers.append(peer_addr)
                        continue
                        
                    # Perform DNS resolution with error handling
                    try:
                        logger.debug(f"Resolving DNS seed: {seed}")
                        answers = dns.resolver.resolve(seed.strip(), 'A')
                        for answer in answers:
                            ip = answer.to_text()
                            
                            # Skip blacklisted IPs
                            if ip in self.blacklist:
                                continue
                                
                            # Try multiple common ports
                            for port in [8000, 8001, 8002, 80, 443]:
                                peer_addr = f"{ip}:{port}"
                                if (peer_addr not in self.potential_peers and 
                                    peer_addr != self.own_address and
                                    peer_addr not in self.peers):
                                    with self.lock:
                                        self.potential_peers.append(peer_addr)
                                        self.discovery_metrics["dns_discovered"] += 1
                    except dns.exception.DNSException as e:
                        logger.warning(f"DNS resolution error for {seed}: {e}")
                    except Exception as e:
                        logger.error(f"Unexpected error resolving DNS seed {seed}: {e}")
            except Exception as e:
                logger.error(f"Error in DNS discovery: {e}")
                
            # Sleep for a random time to avoid synchronization issues
            sleep_time = self.discovery_interval + random.randint(-30, 30)
            time.sleep(max(60, sleep_time))  # At least 60 seconds
    
    def _bootstrap_nodes_discovery(self):
        """Use predefined bootstrap nodes from config."""
        while self.running:
            try:
                bootstrap_nodes = self.config.get('Network', 'bootstrap_nodes', fallback='').split(',')
                for node in bootstrap_nodes:
                    node = node.strip()
                    if node and node != self.own_address and node not in self.peers:
                        with self.lock:
                            if node not in self.potential_peers:
                                self.potential_peers.append(node)
                                self.discovery_metrics["bootstrap_discovered"] += 1
            except Exception as e:
                logger.error(f"Error processing bootstrap nodes: {e}")
                
            # Process potential peers
            self._process_potential_peers()
            
            # Sleep for a longer time as these are fixed
            time.sleep(300)  # 5 minutes
    
    def _broadcast_discovery_loop(self):
        """Discover peers through network broadcasts."""
        if not self.broadcast_enabled:
            return
            
        while self.running:
            try:
                # Send broadcast
                self._send_broadcast_discovery()
                
                # Also try mDNS/Bonjour discovery if available
                self._mdns_discovery()
            except Exception as e:
                logger.error(f"Error in broadcast discovery: {e}")
                
            # Process potential peers
            self._process_potential_peers()
                
            # Sleep for a random time to avoid synchronization issues
            sleep_time = self.discovery_interval + random.randint(-30, 30)
            time.sleep(max(60, sleep_time))  # At least 60 seconds
    
    def _upnp_refresh_loop(self):
        """Periodically refresh the UPnP mapping."""
        if not self.upnp_enabled:
            return
            
        while self.running:
            try:
                if self.port_mapped:
                    self.refresh_port_mapping()
            except Exception as e:
                logger.error(f"Error in UPnP refresh: {e}")
                
            time.sleep(300)  # Every 5 minutes
    
    def _peers_health_check(self):
        """Periodically check peer health and remove non-responding peers."""
        while self.running:
            try:
                current_peers = list(self.peers.keys())
                now = time.time()
                
                # Don't check too many peers at once to avoid overwhelming the network
                # Prioritize checking peers that haven't been seen in a while
                peers_to_check = sorted(
                    [(peer, self.peers.get(peer, 0)) for peer in current_peers],
                    key=lambda x: x[1]  # Sort by last seen time
                )
                
                # Limit to 10 peers per check
                peers_to_check = [peer for peer, _ in peers_to_check[:10]]
                
                # Check each peer in parallel using a thread pool
                with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
                    futures = {
                        executor.submit(self._check_peer_health, peer): peer 
                        for peer in peers_to_check
                    }
                    
                    for future in concurrent.futures.as_completed(futures):
                        peer = futures[future]
                        try:
                            is_alive = future.result()
                            if not is_alive and peer in self.peers:
                                logger.info(f"Removing dead peer: {peer}")
                                with self.lock:
                                    del self.peers[peer]
                        except Exception as e:
                            logger.error(f"Error checking peer {peer}: {e}")
            except Exception as e:
                logger.error(f"Error in peer health check: {e}")
                
            time.sleep(300)  # Check every 5 minutes
    
    def _check_peer_health(self, peer: str) -> bool:
        """
        Check if a peer is still alive and responsive.
        
        Args:
            peer: Peer address to check
            
        Returns:
            bool: True if peer is alive, False otherwise
        """
        try:
            # First try a fast HEAD request
            response = requests.head(f"http://{peer}/", timeout=2)
            if response.status_code == 200:
                # Update last seen time
                with self.lock:
                    self.peers[peer] = time.time()
                return True
                
            # If HEAD fails, try a more comprehensive check
            response = requests.get(f"http://{peer}/status", timeout=5)
            if response.status_code == 200:
                # Update last seen time
                with self.lock:
                    self.peers[peer] = time.time()
                return True
                
            # Both checks failed
            return False
        except Exception:
            # Any exception means peer is unresponsive
            return False
    
    def _network_scan_discovery(self):
        """Scan local network for other nodes."""
        while self.running:
            try:
                # Get local IP address
                local_ip = self._get_local_ip()
                if not local_ip:
                    time.sleep(300)
                    continue
                    
                # Extract subnet
                subnet = self._get_subnet_from_ip(local_ip)
                if not subnet:
                    time.sleep(300)
                    continue
                    
                logger.info(f"Scanning subnet {subnet}.x for QNet nodes")
                
                # Scan subnet (limited range to avoid excessive traffic)
                discovered_peers = self._scan_subnet(subnet)
                
                # Add discovered peers
                for peer in discovered_peers:
                    if peer != self.own_address and peer not in self.peers:
                        with self.lock:
                            if peer not in self.potential_peers:
                                self.potential_peers.append(peer)
            except Exception as e:
                logger.error(f"Error in network scan: {e}")
                
            time.sleep(1800)  # Run every 30 minutes
    
    def _scan_subnet(self, subnet: str) -> List[str]:
        """
        Scan a subnet for QNet nodes.
        
        Args:
            subnet: Subnet in format '192.168.1'
            
        Returns:
            list: List of discovered peer addresses
        """
        discovered_peers = []
        
        # Use a thread pool to scan in parallel
        with concurrent.futures.ThreadPoolExecutor(max_workers=20) as executor:
            # Scan only a limited range to avoid excessive traffic
            futures = {
                executor.submit(self._check_ip, f"{subnet}.{i}", self.internal_port): i
                for i in range(1, 50)  # Scan first 50 IPs in subnet
            }
            
            for future in concurrent.futures.as_completed(futures):
                try:
                    result = future.result()
                    if result:
                        discovered_peers.append(result)
                except Exception as e:
                    logger.debug(f"Error in subnet scan: {e}")
        
        # Also try known Docker subnet
        docker_subnet = "172.17.0"
        docker_futures = {}
        
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
            docker_futures = {
                executor.submit(self._check_ip, f"{docker_subnet}.{i}", self.internal_port): i
                for i in range(2, 20)  # Common Docker container IPs
            }
            
            for future in concurrent.futures.as_completed(docker_futures):
                try:
                    result = future.result()
                    if result:
                        discovered_peers.append(result)
                except Exception as e:
                    logger.debug(f"Error in Docker subnet scan: {e}")
        
        return discovered_peers
    
    def _check_ip(self, ip: str, port: int) -> Optional[str]:
        """
        Check if an IP:port combination is a QNet node.
        
        Args:
            ip: IP address to check
            port: Port to check
            
        Returns:
            str: Peer address if it's a QNet node, None otherwise
        """
        try:
            # Skip if IP is blacklisted
            if ip in self.blacklist:
                return None
                
            # Try to connect with short timeout
            address = f"{ip}:{port}"
            response = requests.head(f"http://{address}/", timeout=1)
            
            if response.status_code == 200:
                # Additional check to verify it's a QNet node
                try:
                    response = requests.get(f"http://{address}/status", timeout=2)
                    if response.status_code == 200:
                        data = response.json()
                        # Check for QNet-specific fields
                        if 'node_id' in data:
                            logger.info(f"Discovered QNet node at {address}")
                            return address
                except Exception:
                    pass
        except Exception:
            pass
            
        return None
    
    def _process_potential_peers_loop(self):
        """Background thread to process potential peers."""
        while self.running:
            try:
                self._process_potential_peers()
                time.sleep(30)  # Process every 30 seconds
            except Exception as e:
                logger.error(f"Error in potential peers processing: {e}")
                time.sleep(60)  # Wait longer on error
    
    def _process_potential_peers(self):
        """Process potential peers and try to connect to them."""
        # Processing a limited number of peers per batch to avoid overwhelming the network
        MAX_BATCH_SIZE = 10
        
        with self.lock:
            # Remove duplicates and filter out known peers
            unique_peers = []
            for peer in self.potential_peers:
                if (peer not in unique_peers and 
                    peer != self.own_address and 
                    peer not in self.peers and 
                    peer not in self.verified_peers):
                    # Parse and validate the peer address
                    try:
                        host, port = self._parse_address(peer)
                        if host in self.blacklist:
                            continue
                        unique_peers.append(peer)
                    except Exception:
                        # Invalid address format
                        continue
            
            # Process only a batch
            batch = unique_peers[:MAX_BATCH_SIZE]
            # Remove processed peers from potential peers list
            self.potential_peers = [p for p in self.potential_peers if p not in batch]
        
        # Process batch in parallel using a thread pool
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
            futures = {
                executor.submit(self.verify_and_add_peer, peer): peer 
                for peer in batch
            }
            
            for future in concurrent.futures.as_completed(futures):
                peer = futures[future]
                try:
                    success = future.result()
                    if success:
                        # Successful verification
                        with self.lock:
                            if peer in self.failed_verifications:
                                del self.failed_verifications[peer]
                    else:
                        # Failed verification, update backoff
                        with self.lock:
                            now = time.time()
                            if peer not in self.failed_verifications:
                                self.failed_verifications[peer] = {"count": 1, "last_attempt": now}
                            else:
                                self.failed_verifications[peer]["count"] += 1
                                self.failed_verifications[peer]["last_attempt"] = now
                                
                                # Add to blacklist after multiple failures
                                if self.failed_verifications[peer]["count"] >= 5:
                                    try:
                                        host, _ = self._parse_address(peer)
                                        self.blacklist.add(host)
                                    except Exception:
                                        pass
                except Exception as e:
                    logger.error(f"Error processing potential peer {peer}: {e}")
    
    def _cache_cleanup_loop(self):
        """Background thread to clean up expired cache entries."""
        while self.running:
            try:
                self._clean_cache()
                time.sleep(60)  # Clean up every minute
            except Exception as e:
                logger.error(f"Error in cache cleanup: {e}")
                time.sleep(300)  # Wait longer on error
    
    def _clean_cache(self):
        """Clean up expired cache entries."""
        with self.lock:
            now = time.time()
            keys_to_remove = []
            
            for key, entry in self.response_cache.items():
                if now - entry["timestamp"] > self.cache_expiry:
                    keys_to_remove.append(key)
                    
            for key in keys_to_remove:
                del self.response_cache[key]
                
            if keys_to_remove and logger.isEnabledFor(logging.DEBUG):
                logger.debug(f"Cleaned {len(keys_to_remove)} expired cache entries")
    
    def verify_peer(self, peer_addr: str, timeout: float = 2) -> bool:
        """
        Verify if a peer is responsive (used for health checks).
        
        Args:
            peer_addr: Peer address
            timeout: Connection timeout in seconds
            
        Returns:
            bool: True if peer is responsive, False otherwise
        """
        try:
            # Try to connect with reasonable timeout
            response = requests.head(f"http://{peer_addr}/", timeout=timeout)
            return response.status_code == 200
        except Exception:
            # Connection failed
            return False
    
    def verify_and_add_peer(self, peer_addr: str) -> bool:
        """
        Verify if address is a QNet node and add to peers if valid.
        
        Args:
            peer_addr: Peer address to verify
            
        Returns:
            bool: True if verified and added, False otherwise
        """
        try:
            # First try a fast HEAD request
            response = requests.head(f"http://{peer_addr}/", timeout=1)
            if response.status_code != 200:
                return False
                
            # Then verify it's actually a QNet node with more comprehensive check
            response = requests.get(f"http://{peer_addr}/status", timeout=3)
            if response.status_code == 200:
                try:
                    data = response.json()
                    
                    # Verify it's a QNet node by checking specific fields
                    if 'node_id' in data and 'blockchain_height' in data:
                        logger.info(f"Discovered and verified peer: {peer_addr}")
                        
                        # Add to peers dictionary
                        with self.lock:
                            self.peers[peer_addr] = time.time()
                            self.verified_peers.add(peer_addr)
                            
                        # Try to get peer's peers
                        self._get_peers_from_peer(peer_addr)
                        
                        return True
                except json.JSONDecodeError:
                    # Not a valid JSON response
                    pass
        except Exception as e:
            logger.debug(f"Failed to verify peer {peer_addr}: {e}")
            
        return False
    
    def _get_peers_from_peer(self, peer_addr: str) -> bool:
        """
        Get peers from a peer for recursive discovery.
        
        Args:
            peer_addr: Peer to query
            
        Returns:
            bool: True if successful, False otherwise
        """
        try:
            # Check cache first
            cache_key = f"peers_{peer_addr}"
            with self.lock:
                if cache_key in self.response_cache:
                    cache_entry = self.response_cache[cache_key]
                    if time.time() - cache_entry["timestamp"] < self.cache_expiry:
                        # Use cached data
                        new_peers = cache_entry["data"].get("peers", [])
                        
                        # Process new peers
                        for new_peer in new_peers:
                            if (new_peer and new_peer != self.own_address and 
                                new_peer not in self.peers and
                                new_peer not in self.potential_peers):
                                self.potential_peers.append(new_peer)
                                self.discovery_metrics["peer_exchange_discovered"] += 1
                        
                        return True
            
            # Not in cache, make request
            response = requests.get(f"http://{peer_addr}/get_peers", timeout=3)
            if response.status_code == 200:
                data = response.json()
                
                # Cache the response
                with self.lock:
                    self.response_cache[cache_key] = {
                        "data": data,
                        "timestamp": time.time()
                    }
                
                new_peers = data.get("peers", [])
                peer_count = 0
                
                # Process new peers
                for new_peer in new_peers:
                    if (new_peer and new_peer != self.own_address and 
                        new_peer not in self.peers and
                        new_peer not in self.potential_peers):
                        with self.lock:
                            self.potential_peers.append(new_peer)
                            peer_count += 1
                            self.discovery_metrics["peer_exchange_discovered"] += 1
                
                if peer_count > 0:
                    logger.info(f"Got {peer_count} new peers from {peer_addr}")
                    
                return True
        except Exception as e:
            logger.debug(f"Failed to get peers from {peer_addr}: {e}")
            
        return False
    
    def _send_broadcast_discovery(self):
        """Send UDP broadcast to discover peers in local network."""
        if not self.broadcast_enabled:
            return
            
        try:
            # Create UDP socket
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                # Enable broadcasting
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
                
                # Discovery message with security measures
                discovery_msg = {
                    "action": "discovery",
                    "node_address": self.own_address,
                    "timestamp": time.time(),
                    "version": "1.0.0",  # Protocol version
                    "nonce": random.randint(1000000, 9999999)  # Prevent replay
                }
                
                # Add signature if key_manager is available
                try:
                    from key_manager import get_key_manager
                    key_manager = get_key_manager()
                    message_data = json.dumps(discovery_msg, sort_keys=True)
                    discovery_msg["signature"] = key_manager.sign_message(
                        message_data, 
                        self.config.get('node_id', 'unknown')
                    )
                except (ImportError, AttributeError):
                    pass
                
                # Encode the message
                message = json.dumps(discovery_msg).encode()
                
                # Send to multiple broadcast addresses
                broadcast_addresses = [
                    '255.255.255.255',  # Global broadcast
                    '172.17.255.255',   # Docker default subnet broadcast
                    '172.20.255.255',   # Docker custom subnet broadcast
                    '10.255.255.255'    # Common private network broadcast
                ]
                
                # Add local subnet broadcast address
                local_ip = self._get_local_ip()
                if local_ip:
                    subnet = self._get_subnet_from_ip(local_ip)
                    if subnet:
                        broadcast_addresses.append(f"{subnet}.255")
                
                for addr in broadcast_addresses:
                    try:
                        sock.sendto(message, (addr, self.internal_port))
                    except OSError:
                        # Ignore errors for individual addresses
                        pass
                        
                logger.debug("Sent broadcast discovery messages")
        except Exception as e:
            logger.error(f"Failed to send broadcast discovery: {e}")
    
    def _mdns_discovery(self):
        """Try mDNS/Bonjour discovery if available."""
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
                            # Extract IP and port
                            try:
                                addr = socket.inet_ntoa(info.addresses[0])
                                port = info.port
                                peer = f"{addr}:{port}"
                                
                                # Add to potential peers
                                if (peer not in self.parent.potential_peers and 
                                    peer != self.parent.own_address):
                                    with self.parent.lock:
                                        self.parent.potential_peers.append(peer)
                                        self.parent.discovery_metrics["broadcast_discovered"] += 1
                                    logger.info(f"mDNS discovered peer: {peer}")
                            except Exception as e:
                                logger.debug(f"Error processing mDNS service: {e}")
                
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
            logger.debug(f"mDNS discovery error: {e}")
    
    def _get_local_ip(self) -> Optional[str]:
        """
        Get local IP address with multiple fallbacks.
        
        Returns:
            str: Local IP address or None if not found
        """
        try:
            # Preferred method - connect to external server
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(('8.8.8.8', 80))
            ip = s.getsockname()[0]
            s.close()
            return ip
        except Exception:
            pass
            
        # Fallback 1: Get hostname
        try:
            hostname = socket.gethostname()
            ip = socket.gethostbyname(hostname)
            if ip != "127.0.0.1":
                return ip
        except Exception:
            pass
            
        # Fallback 2: Try common interfaces
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
                # Check if we're in a docker container
                docker_ip = socket.gethostbyname('host.docker.internal')
                if docker_ip and docker_ip != "127.0.0.1":
                    return docker_ip
            except socket.gaierror:
                pass
        
        # If all else fails
        return None
    
    def _get_subnet_from_ip(self, ip: str) -> Optional[str]:
        """
        Extract subnet from IP address.
        
        Args:
            ip: IP address
            
        Returns:
            str: Subnet in format '192.168.1' or None if invalid
        """
        try:
            parts = ip.split('.')
            if len(parts) != 4:
                return None
                
            return f"{parts[0]}.{parts[1]}.{parts[2]}"
        except Exception:
            return None
    
    def _is_ip_address(self, addr: str) -> bool:
        """
        Check if a string is an IP address.
        
        Args:
            addr: String to check
            
        Returns:
            bool: True if IP address, False otherwise
        """
        try:
            # Remove port if present
            ip_part = addr.split(":")[0]
            socket.inet_aton(ip_part)
            return True
        except socket.error:
            return False
    
    def add_peer(self, peer_addr: str) -> bool:
        """
        Add a peer to the peers dictionary.
        
        Args:
            peer_addr: Peer address to add
            
        Returns:
            bool: True if added, False otherwise
        """
        if not peer_addr or peer_addr == self.own_address:
            return False
            
        with self.lock:
            if peer_addr not in self.peers:
                self.peers[peer_addr] = time.time()
                logger.info(f"Added peer: {peer_addr}")
                return True
            else:
                # Just update timestamp
                self.peers[peer_addr] = time.time()
                return False
    
    def get_metrics(self) -> Dict[str, Any]:
        """
        Get discovery metrics.
        
        Returns:
            dict: Discovery metrics
        """
        with self.lock:
            metrics = self.discovery_metrics.copy()
            metrics.update({
                "peers_count": len(self.peers),
                "verified_peers": len(self.verified_peers),
                "blacklisted_ips": len(self.blacklist),
                "upnp_enabled": self.upnp_enabled,
                "port_mapped": self.port_mapped,
                "external_port": self.external_port if self.port_mapped else None,
                "potential_peers": len(self.potential_peers)
            })
            return metrics
    
    def stop(self):
        """Stop all discovery activities and clean up."""
        self.running = False
        
        # Remove UPnP port mapping
        if self.port_mapped:
            self.remove_port_mapping()
            
        # Save blacklist
        self._save_blacklist()
        
        logger.info("Node discovery manager stopped")


# UDP server for handling broadcast discovery requests
class DiscoveryUDPServer:
    """Server to handle UDP discovery broadcasts and responses."""
    
    def __init__(self, own_address: str, peers_dict: Dict[str, float], port: int = 8000):
        """
        Initialize UDP server for discovery.
        
        Args:
            own_address: Address of this node
            peers_dict: Dictionary of peers
            port: Port to listen on
        """
        self.own_address = own_address
        self.peers = peers_dict
        self.port = port
        self.running = True
        self.server_thread = None
        
        # Track recent messages to prevent duplicates
        self.recent_messages = {}
        self.lock = threading.RLock()
        
        # Load security module if available
        try:
            from security import get_security_manager
            self.security_manager = get_security_manager()
        except ImportError:
            self.security_manager = None
    
    def start(self):
        """Start UDP server in a separate thread."""
        self.server_thread = threading.Thread(target=self._run_server, daemon=True)
        self.server_thread.start()
        logging.info(f"Discovery UDP server started on port {self.port}")
        
        # Start cleanup thread
        cleanup_thread = threading.Thread(target=self._cleanup_loop, daemon=True)
        cleanup_thread.start()
    
    def _run_server(self):
        """Run UDP server to listen for discovery broadcasts."""
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                # Enable socket reuse
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                
                # Bind to all interfaces
                sock.bind(('0.0.0.0', self.port))
                sock.settimeout(1.0)  # 1 second timeout for graceful shutdown
                
                while self.running:
                    try:
                        data, addr = sock.recvfrom(1024)
                        self._handle_request(data, addr)
                    except socket.timeout:
                        continue  # Just a timeout, continue loop
                    except Exception as e:
                        logging.error(f"Error in UDP server: {e}")
        except Exception as e:
            logging.error(f"Failed to start UDP server: {e}")
    
    def _cleanup_loop(self):
        """Clean up old messages periodically."""
        while self.running:
            try:
                with self.lock:
                    now = time.time()
                    to_remove = [msg_hash for msg_hash, timestamp in self.recent_messages.items()
                                if now - timestamp > 60]
                    
                    for msg_hash in to_remove:
                        del self.recent_messages[msg_hash]
            except Exception as e:
                logging.error(f"Error cleaning recent messages: {e}")
                
            time.sleep(30)  # Run every 30 seconds
    
    def _handle_request(self, data: bytes, addr: Tuple[str, int]):
        """
        Handle incoming discovery request.
        
        Args:
            data: Received data
            addr: Sender address (ip, port)
        """
        try:
            # Security check - reject packets that are too large
            if len(data) > 2048:
                return
                
            # Try to parse as JSON
            try:
                message = json.loads(data.decode())
            except json.JSONDecodeError:
                return
                
            # Check for required fields
            if not isinstance(message, dict) or 'action' not in message or 'node_address' not in message:
                return
                
            # Check action type
            if message['action'] != 'discovery':
                return
                
            # Get sender information
            sender_addr = message.get('node_address')
            sender_ip = addr[0]
            timestamp = message.get('timestamp', 0)
            
            # Check if message is recent
            now = time.time()
            if now - timestamp > 60:  # Older than 1 minute
                return
                
            # Validate signature if present
            if 'signature' in message and hasattr(self, 'security_manager'):
                try:
                    # Create message data for verification
                    message_data = {k: v for k, v in message.items() if k != 'signature'}
                    message_str = json.dumps(message_data, sort_keys=True)
                    
                    # Verify signature
                    if not self.security_manager.verify_signature(
                        message_str, 
                        message['signature'], 
                        message.get('public_key')
                    ):
                        logging.warning(f"Invalid signature in discovery message from {sender_addr}")
                        return
                except Exception as e:
                    logging.debug(f"Error verifying signature: {e}")
                    return
            
            # Generate message hash to prevent duplicates
            msg_hash = hashlib.md5(data).hexdigest()
            
            with self.lock:
                # Check if we've seen this message recently
                if msg_hash in self.recent_messages:
                    return
                
                # Record that we've seen this message
                self.recent_messages[msg_hash] = now
            
            # Valid message, add the peer
            if sender_addr and sender_addr != self.own_address and sender_addr not in self.peers:
                with self.lock:
                    self.peers[sender_addr] = now
                    logging.info(f"Added peer from discovery broadcast: {sender_addr}")
                
                # Send response back to the source IP/port
                self._send_response(sender_ip, message['node_address'])
        except Exception as e:
            logging.error(f"Error handling discovery request: {e}")
    
    def _send_response(self, target_ip: str, target_addr: str):
        """
        Send response to the discovery request.
        
        Args:
            target_ip: Target IP address
            target_addr: Target node address
        """
        try:
            # Extract port from target_addr
            if ":" in target_addr:
                _, port_str = target_addr.split(":")
                try:
                    port = int(port_str)
                except ValueError:
                    # Default port if parsing fails
                    port = 8000
            else:
                # Default port if not in address
                port = 8000
                
            # Prepare response
            response = {
                "action": "discovery_response",
                "node_address": self.own_address,
                "peers": list(self.peers.keys())[:20],  # Limit to 20 peers
                "timestamp": time.time()
            }
            
            # Encode response
            encoded = json.dumps(response).encode()
            
            # Send via UDP
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                sock.sendto(encoded, (target_ip, port))
                
            logging.debug(f"Sent discovery response to {target_ip}:{port}")
        except Exception as e:
            logging.debug(f"Failed to send discovery response: {e}")
    
    def stop(self):
        """Stop the UDP server."""
        self.running = False
        
        if self.server_thread:
            self.server_thread.join(timeout=2)
            
        logging.info("Discovery UDP server stopped")