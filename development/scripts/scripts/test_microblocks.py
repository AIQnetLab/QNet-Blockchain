#!/usr/bin/env python3
"""Test microblock functionality"""

import requests
import json
import time
import sys

def test_node_info(port=8545):
    """Get node info"""
    url = f"http://localhost:{port}/rpc"
    payload = {
        "jsonrpc": "2.0",
        "method": "node_getInfo",
        "params": [],
        "id": 1
    }
    
    try:
        response = requests.post(url, json=payload)
        result = response.json()
        if "result" in result:
            print(f"Node info: {json.dumps(result['result'], indent=2)}")
            return result['result']
        else:
            print(f"Error: {result.get('error', 'Unknown error')}")
            return None
    except Exception as e:
        print(f"Failed to connect to node: {e}")
        return None

def get_chain_height(port=8545):
    """Get current chain height"""
    url = f"http://localhost:{port}/rpc"
    payload = {
        "jsonrpc": "2.0",
        "method": "chain_getHeight",
        "params": [],
        "id": 1
    }
    
    try:
        response = requests.post(url, json=payload)
        result = response.json()
        if "result" in result:
            return result['result']['height']
        return 0
    except:
        return 0

def monitor_microblocks(port=8545, duration=60):
    """Monitor microblock production"""
    print(f"Monitoring microblock production for {duration} seconds...")
    print("Press Ctrl+C to stop\n")
    
    start_time = time.time()
    initial_height = get_chain_height(port)
    print(f"Initial height: {initial_height}")
    
    try:
        while time.time() - start_time < duration:
            current_height = get_chain_height(port)
            elapsed = int(time.time() - start_time)
            blocks_created = current_height - initial_height
            
            # Expected: 1 microblock per second
            expected_blocks = elapsed
            efficiency = (blocks_created / expected_blocks * 100) if expected_blocks > 0 else 0
            
            print(f"\rTime: {elapsed}s | Height: {current_height} | "
                  f"Blocks created: {blocks_created} | "
                  f"Expected: {expected_blocks} | "
                  f"Efficiency: {efficiency:.1f}%", end='', flush=True)
            
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n\nMonitoring stopped by user")
    
    print(f"\n\nFinal statistics:")
    final_height = get_chain_height(port)
    total_blocks = final_height - initial_height
    total_time = int(time.time() - start_time)
    
    print(f"Total time: {total_time} seconds")
    print(f"Total blocks created: {total_blocks}")
    print(f"Average block time: {total_time/total_blocks:.2f} seconds" if total_blocks > 0 else "No blocks created")
    print(f"TPS estimate: {total_blocks * 10000 / total_time:.0f}" if total_blocks > 0 else "N/A")

def main():
    port = 8545
    if len(sys.argv) > 1:
        port = int(sys.argv[1])
    
    print(f"Testing microblocks on port {port}\n")
    
    # Check node info
    info = test_node_info(port)
    if not info:
        print("Node is not running or not accessible")
        return
    
    # Monitor microblock production
    monitor_microblocks(port, 60)

if __name__ == "__main__":
    main() 