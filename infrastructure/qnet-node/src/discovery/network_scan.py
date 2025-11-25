# network_scan.py
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: network_scan.py
Tool for scanning local network for QNet nodes.
"""

import os
import sys
import time
import socket
import requests
import logging
import threading
import subprocess
from concurrent.futures import ThreadPoolExecutor

def get_docker_subnet():
    """Get the Docker subnet"""
    try:
        # Try to get Docker bridge network subnet
        output = subprocess.check_output(["docker", "network", "inspect", "bridge"]).decode()
        import json
        data = json.loads(output)
        if data and data[0] and "IPAM" in data[0] and "Config" in data[0]["IPAM"]:
            for config in data[0]["IPAM"]["Config"]:
                if "Subnet" in config:
                    subnet = config["Subnet"]
                    # Return the first three octets, e.g., 172.17.0 from 172.17.0.0/16
                    return ".".join(subnet.split(".")[0:3])
    except Exception as e:
        logging.debug(f"Error getting Docker subnet: {e}")
    
    # Default Docker subnet
    return "172.17.0"

def get_local_ip():
    """Get local IP address"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
        return local_ip
    except Exception as e:
        logging.debug(f"Error getting local IP: {e}")
        return "127.0.0.1"

def is_qnet_node(ip, port=8000, timeout=1.0):
    """Check if IP:port is a QNet node"""
    try:
        # First try a HEAD request which is faster
        response = requests.head(f"http://{ip}:{port}/", timeout=timeout)
        if response.status_code == 200:
            # Now check if it's actually a QNet node
            response = requests.get(f"http://{ip}:{port}/get_peers", timeout=timeout)
            if response.status_code == 200:
                return True
    except Exception:
        pass
    return False

def scan_subnet(subnet, start=1, end=10, port=8000, timeout=0.5):
    """Scan a subnet for QNet nodes"""
    found_nodes = []
    
    def check_ip(i):
        ip = f"{subnet}.{i}"
        if is_qnet_node(ip, port, timeout):
            found_nodes.append(f"{ip}:{port}")
            logging.info(f"Found QNet node at {ip}:{port}")
    
    # Scan in parallel for faster results
    with ThreadPoolExecutor(max_workers=20) as executor:
        executor.map(check_ip, range(start, end + 1))
    
    return found_nodes

def scan_for_nodes(port=8000):
    """Scan local network for QNet nodes"""
    found_nodes = []
    
    # Scan Docker subnet
    docker_subnet = get_docker_subnet()
    logging.info(f"Scanning Docker subnet {docker_subnet}.x")
    docker_nodes = scan_subnet(docker_subnet, 1, 50, port)
    found_nodes.extend(docker_nodes)
    
    # Scan local subnet
    local_ip = get_local_ip()
    local_subnet = ".".join(local_ip.split(".")[0:3])
    if local_subnet != docker_subnet:
        logging.info(f"Scanning local subnet {local_subnet}.x")
        local_nodes = scan_subnet(local_subnet, 1, 50, port)
        found_nodes.extend(local_nodes)
    
    # Add known node addresses
    known_addresses = [
        "95.164.7.199",
        "5.189.130.160"
    ]
    
    for addr in known_addresses:
        node_addr = f"{addr}:{port}"
        if node_addr not in found_nodes and is_qnet_node(addr, port, 2.0):
            found_nodes.append(node_addr)
            logging.info(f"Found known QNet node at {node_addr}")
    
    return found_nodes

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO,
                        format='%(asctime)s [%(levelname)s] %(message)s')
    
    start_time = time.time()
    nodes = scan_for_nodes()
    elapsed = time.time() - start_time
    
    print(f"Scan completed in {elapsed:.2f} seconds. Found {len(nodes)} nodes:")
    for node in nodes:
        print(f"  - {node}")