#!/usr/bin/env python3
import requests
import json

nodes = [
    {"name": "Node1", "port": 9877},
    {"name": "Node2", "port": 9879},
    {"name": "Node3", "port": 9881},
    {"name": "Node4", "port": 9883}
]

print("Checking node peers...")
print("-" * 40)

for node in nodes:
    try:
        response = requests.post(
            f"http://localhost:{node['port']}/rpc",
            json={
                "jsonrpc": "2.0",
                "method": "node_getPeers",
                "params": [],
                "id": 1
            }
        )
        result = response.json()
        if "result" in result:
            peers = result["result"]["count"]
            print(f"{node['name']}: {peers} peers")
        else:
            print(f"{node['name']}: Error - {result.get('error', 'Unknown error')}")
    except:
        print(f"{node['name']}: Not running") 