#!/usr/bin/env python3
"""
Live Network Monitor for QNet
Shows real-time network topology and health
"""

import json
import urllib.request
import time
import os
import sys
from datetime import datetime
from collections import defaultdict

# ANSI color codes
RED = '\033[91m'
GREEN = '\033[92m'
YELLOW = '\033[93m'
BLUE = '\033[94m'
MAGENTA = '\033[95m'
CYAN = '\033[96m'
WHITE = '\033[97m'
RESET = '\033[0m'
BOLD = '\033[1m'

def clear_screen():
    os.system('cls' if os.name == 'nt' else 'clear')

def call_rpc(port, method, params=None):
    """Call RPC method on node"""
    url = f"http://localhost:{port}/rpc"
    data = {
        "jsonrpc": "2.0",
        "method": method,
        "params": params or {},
        "id": 1
    }
    
    try:
        req = urllib.request.Request(
            url,
            data=json.dumps(data).encode('utf-8'),
            headers={'Content-Type': 'application/json'}
        )
        
        with urllib.request.urlopen(req, timeout=1) as response:
            result = json.loads(response.read().decode('utf-8'))
            return result.get('result')
    except:
        return None

def get_node_color(node_type):
    """Get color for node type"""
    colors = {
        'super': GREEN,
        'full': BLUE,
        'light': MAGENTA
    }
    return colors.get(node_type.lower(), WHITE)

def get_region_symbol(region):
    """Get symbol for region"""
    symbols = {
        'na': '🇺🇸',
        'eu': '🇪🇺',
        'asia': '🇨🇳',
        'sa': '🇧🇷',
        'africa': '🇿🇦',
        'oceania': '🇦🇺'
    }
    return symbols.get(region.lower(), '🌍')

def monitor_network():
    """Monitor network in real-time"""
    
    # Port ranges for different node types
    port_ranges = [
        # Super nodes
        (12002, 12602, 100),  # One per region
        # Full nodes
        (12021, 12622, 100),  # Two per region
        (12022, 12623, 100),
        # Light nodes
        (12041, 12643, 100),  # Three per region
        (12042, 12644, 100),
        (12043, 12645, 100),
    ]
    
    regions = ['na', 'eu', 'asia', 'sa', 'africa', 'oceania']
    
    while True:
        clear_screen()
        
        # Header
        print(f"{BOLD}{CYAN}=== QNet Live Network Monitor ==={RESET}")
        print(f"Time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        print(f"{'-' * 60}")
        
        # Collect node data
        total_nodes = 0
        online_nodes = 0
        total_peers = 0
        nodes_by_type = defaultdict(int)
        nodes_by_region = defaultdict(int)
        offline_nodes = []
        isolated_nodes = []
        
        # Network map
        network_map = defaultdict(lambda: defaultdict(list))
        
        for base_port, _, step in port_ranges:
            for i, region in enumerate(regions):
                port = base_port + (i * step)
                
                info = call_rpc(port, "node_getInfo")
                if info:
                    online_nodes += 1
                    node_type = info.get('node_type', 'unknown')
                    peers = info.get('peers', 0)
                    
                    nodes_by_type[node_type] += 1
                    nodes_by_region[region] += 1
                    total_peers += peers
                    
                    network_map[region][node_type].append({
                        'port': port,
                        'peers': peers,
                        'height': info.get('height', 0)
                    })
                    
                    if peers == 0:
                        isolated_nodes.append(f"{node_type}-{region}:{port}")
                else:
                    offline_nodes.append(f"{region}:{port}")
                
                total_nodes += 1
        
        # Display network topology
        print(f"\n{BOLD}Network Topology:{RESET}")
        for region in regions:
            print(f"\n{get_region_symbol(region)} {region.upper()}:")
            
            for node_type in ['super', 'full', 'light']:
                nodes = network_map[region].get(node_type, [])
                if nodes:
                    color = get_node_color(node_type)
                    print(f"  {color}{node_type.capitalize()}: {len(nodes)} nodes{RESET}", end="")
                    
                    # Show peer counts
                    peer_counts = [n['peers'] for n in nodes]
                    if peer_counts:
                        avg_peers = sum(peer_counts) / len(peer_counts)
                        print(f" (avg peers: {avg_peers:.1f})")
                    else:
                        print()
        
        # Summary statistics
        print(f"\n{BOLD}Network Statistics:{RESET}")
        print(f"Total Nodes: {total_nodes}")
        print(f"Online: {GREEN}{online_nodes}{RESET} ({online_nodes/total_nodes*100:.1f}%)")
        print(f"Offline: {RED}{len(offline_nodes)}{RESET}")
        print(f"Isolated: {YELLOW}{len(isolated_nodes)}{RESET}")
        print(f"Total Connections: {total_peers // 2}")  # Divide by 2 for bidirectional
        
        # Node distribution
        print(f"\n{BOLD}Node Distribution:{RESET}")
        print("By Type:")
        for node_type, count in nodes_by_type.items():
            color = get_node_color(node_type)
            print(f"  {color}{node_type.capitalize()}: {count}{RESET}")
        
        print("\nBy Region:")
        for region, count in nodes_by_region.items():
            print(f"  {get_region_symbol(region)} {region.upper()}: {count}")
        
        # Warnings
        if isolated_nodes:
            print(f"\n{YELLOW}⚠️  Isolated Nodes:{RESET}")
            for node in isolated_nodes[:5]:  # Show first 5
                print(f"  - {node}")
            if len(isolated_nodes) > 5:
                print(f"  ... and {len(isolated_nodes) - 5} more")
        
        if offline_nodes:
            print(f"\n{RED}❌ Offline Nodes: {len(offline_nodes)}{RESET}")
        
        # Health check
        health_score = (online_nodes / total_nodes) * 100
        if health_score >= 95:
            health_color = GREEN
            health_status = "EXCELLENT"
        elif health_score >= 80:
            health_color = YELLOW
            health_status = "GOOD"
        else:
            health_color = RED
            health_status = "CRITICAL"
        
        print(f"\n{BOLD}Network Health: {health_color}{health_status} ({health_score:.1f}%){RESET}")
        
        # Critical issues
        if health_score < 80:
            print(f"\n{RED}{BOLD}⚠️  CRITICAL ISSUES DETECTED!{RESET}")
            if len(offline_nodes) > total_nodes * 0.2:
                print(f"{RED}  - More than 20% of nodes are offline!{RESET}")
            if len(isolated_nodes) > total_nodes * 0.1:
                print(f"{RED}  - More than 10% of nodes are isolated!{RESET}")
        
        print(f"\n{'-' * 60}")
        print("Press Ctrl+C to exit | Refreshing every 5 seconds...")
        
        try:
            time.sleep(5)
        except KeyboardInterrupt:
            print(f"\n{CYAN}Monitor stopped.{RESET}")
            break

if __name__ == "__main__":
    try:
        monitor_network()
    except KeyboardInterrupt:
        print(f"\n{CYAN}Monitor stopped.{RESET}")
        sys.exit(0) 