#!/usr/bin/env python3
"""
QNet CLI - Simple version without external dependencies.
"""

import sys
import json
import urllib.request
import urllib.error
from pathlib import Path


class SimpleCLI:
    """Simple CLI for QNet without external dependencies."""
    
    def __init__(self):
        self.node_url = "http://localhost:5000"
        self.commands = {
            'node': {
                'status': self.node_status,
                'start': self.node_start,
                'stop': self.node_stop,
            },
            'wallet': {
                'create': self.wallet_create,
                'balance': self.wallet_balance,
            },
            'rewards': {
                'check': self.rewards_check,
                'claim': self.rewards_claim,
            },
            'network': {
                'peers': self.network_peers,
                'stats': self.network_stats,
            },
            'help': self.show_help,
            'version': self.show_version,
        }
    
    def run(self, args):
        """Run CLI with given arguments."""
        if len(args) < 2:
            self.show_help()
            return
        
        command = args[1]
        
        if command in ['help', '--help', '-h']:
            self.show_help()
        elif command == 'version':
            self.show_version()
        elif command in self.commands and len(args) > 2:
            subcommand = args[2]
            if subcommand in self.commands[command]:
                self.commands[command][subcommand](args[3:])
            else:
                print(f"Unknown subcommand: {subcommand}")
                self.show_help()
        else:
            print(f"Unknown command: {command}")
            self.show_help()
    
    def show_help(self, args=None):
        """Show help message."""
        print("QNet CLI - Command line interface for QNet blockchain")
        print("\nUsage: qnet-cli <command> <subcommand> [options]")
        print("\nCommands:")
        print("  node status        - Check node status")
        print("  node start         - Start a node")
        print("  node stop          - Stop the node")
        print("  wallet create      - Create a new wallet")
        print("  wallet balance     - Check wallet balance")
        print("  rewards check      - Check unclaimed rewards")
        print("  rewards claim      - Claim accumulated rewards")
        print("  network peers      - List connected peers")
        print("  network stats      - Show network statistics")
        print("  version            - Show version")
        print("  help               - Show this help")
    
    def show_version(self, args=None):
        """Show version."""
        print("QNet CLI v0.1.0")
        print("QNet Protocol v1.0.0")
    
    def _api_request(self, endpoint, method="GET", data=None):
        """Make API request to node."""
        try:
            url = f"{self.node_url}{endpoint}"
            
            if method == "GET":
                with urllib.request.urlopen(url, timeout=5) as response:
                    return json.loads(response.read().decode())
            elif method == "POST":
                post_data = json.dumps(data or {}).encode('utf-8')
                headers = {'Content-Type': 'application/json'}
                
                req = urllib.request.Request(url, data=post_data, headers=headers)
                req.get_method = lambda: 'POST'
                
                with urllib.request.urlopen(req, timeout=5) as response:
                    return json.loads(response.read().decode())
            else:
                raise ValueError(f"Unsupported HTTP method: {method}")
                
        except urllib.error.URLError as e:
            print(f"Error: Cannot connect to node at {self.node_url}")
            return {"error": f"Connection failed: {e}"}
        except Exception as e:
            print(f"Error: {str(e)}")
            return {"error": str(e)}
    
    def node_status(self, args):
        """Check node status."""
        data = self._api_request("/api/node/status")
        if data and 'error' not in data:
            print("Node Status:")
            print(f"  Node ID: {data.get('node_id', 'N/A')}")
            print(f"  Type: {data.get('node_type', 'N/A')}")
            print(f"  Address: {data.get('address', 'N/A')}")
            print(f"  Blockchain Height: {data.get('blockchain_height', 0)}")
            print(f"  Peers: {data.get('peers_count', 0)}")
            print(f"  Mining: {data.get('is_mining', False)}")
            print(f"  Uptime: {data.get('uptime_seconds', 0)} seconds")
            
            # Performance metrics
            if 'performance' in data:
                perf = data['performance']
                print(f"\nPerformance:")
                print(f"  Current TPS: {perf.get('current_tps', 0)}")
                print(f"  Peak TPS: {perf.get('peak_tps', 0)}")
                print(f"  Mempool Size: {perf.get('mempool_size', 0)}")
            
            # Regional info if available
            if 'region' in data:
                region = data['region']
                print(f"\nRegional Info:")
                print(f"  Region: {region.get('name', 'N/A')}")
                print(f"  Regional Sharding: {region.get('regional_sharding', False)}")
        else:
            print(f"Failed to get node status: {data.get('error', 'Unknown error')}")
    
    def node_start(self, args):
        """Start a node."""
        node_type = 'full'
        region = 'auto'
        producer = False
        
        # Parse arguments
        i = 0
        while i < len(args):
            if args[i] == '--type' and i + 1 < len(args):
                node_type = args[i + 1]
                i += 2
            elif args[i] == '--region' and i + 1 < len(args):
                region = args[i + 1]
                i += 2
            elif args[i] == '--producer':
                producer = True
                i += 1
            else:
                i += 1
        
        print(f"Starting {node_type} node in region {region}...")
        if producer:
            print("  Mode: Block producer enabled")
        
        # Send start request to API
        data = self._api_request("/api/node/start", method="POST", data={
            "node_type": node_type,
            "region": region,
            "producer": producer
        })
        
        if data and 'error' not in data:
            print(f"✅ Node started successfully!")
            print(f"  Node ID: {data.get('node_id', 'N/A')}")
            print(f"  P2P Port: {data.get('p2p_port', 'N/A')}")
            print(f"  RPC Port: {data.get('rpc_port', 'N/A')}")
        else:
            print(f"❌ Failed to start node: {data.get('error', 'Unknown error')}")
    
    def node_stop(self, args):
        """Stop the node."""
        print("Stopping node...")
        
        data = self._api_request("/api/node/stop", method="POST")
        
        if data and 'error' not in data:
            print("✅ Node stopped successfully!")
        else:
            print(f"❌ Failed to stop node: {data.get('error', 'Unknown error')}")
    
    def wallet_create(self, args):
        """Create a new wallet."""
        wallet_path = Path.home() / ".qnet" / "wallet.json"
        wallet_path.parent.mkdir(exist_ok=True)
        
        if wallet_path.exists():
            print(f"Wallet already exists at {wallet_path}")
            return
        
        print(f"Creating new wallet at {wallet_path}...")
        
        # Request wallet creation from node
        data = self._api_request("/api/wallet/create", method="POST")
        
        if data and 'error' not in data:
            wallet_data = {
                "address": data.get('address'),
                "public_key": data.get('public_key'),
                "encrypted_private_key": data.get('encrypted_private_key'),
                "created_at": data.get('created_at')
            }
            
            with open(wallet_path, 'w') as f:
                json.dump(wallet_data, f, indent=2)
            
            print(f"✅ Wallet created successfully!")
            print(f"Address: {wallet_data['address']}")
            print(f"Public Key: {wallet_data['public_key'][:20]}...")
            print("\nIMPORTANT: Save your seed phrase securely!")
            if 'seed_phrase' in data:
                print(f"Seed Phrase: {data['seed_phrase']}")
        else:
            print(f"❌ Failed to create wallet: {data.get('error', 'Wallet creation service unavailable')}")
    
    def wallet_balance(self, args):
        """Check wallet balance."""
        wallet_path = Path.home() / ".qnet" / "wallet.json"
        
        if not wallet_path.exists():
            print("Error: No wallet found. Create one with 'qnet-cli wallet create'")
            return
        
        with open(wallet_path, 'r') as f:
            wallet_data = json.load(f)
        
        address = wallet_data.get('address')
        data = self._api_request(f"/api/balance/{address}")
        
        if data and 'error' not in data:
            print(f"Wallet Balance:")
            print(f"  Address: {address}")
            print(f"  Balance: {data.get('balance', 0)} QNC")
            print(f"  Pending: {data.get('pending', 0)} QNC")
            print(f"  Staked: {data.get('staked', 0)} QNC")
            print(f"  Total: {data.get('total', 0)} QNC")
        else:
            print(f"❌ Failed to get balance: {data.get('error', 'Unknown error')}")
    
    def rewards_check(self, args):
        """Check unclaimed rewards."""
        try:
            # Get node ID from local node configuration
            node_config = self._get_node_config()
            node_id = node_config.get('node_id', 'unknown')
            
            data = self._api_request(f"/api/rewards/{node_id}")
            
            if data and 'error' not in data:
                print(f"Rewards Status for Node {node_id}:")
                print(f"  Unclaimed: {data.get('unclaimed', 0)} QNC")
                print(f"  Total Earned: {data.get('total_earned', 0)} QNC") 
                print(f"  Last Claim: {data.get('last_claim', 'Never')}")
                print(f"  Next Claim Available: {data.get('next_claim_time', 'Now')}")
            else:
                print(f"Could not retrieve rewards for node {node_id}")
                print(f"Error: {data.get('error', 'Unknown error')}")
        except Exception as e:
            print(f"Error checking rewards: {e}")
    
    def rewards_claim(self, args):
        """Claim accumulated rewards."""
        try:
            node_config = self._get_node_config()
            node_id = node_config.get('node_id', 'unknown')
            
            print(f"Claiming rewards for node {node_id}...")
            
            # Make claim request
            data = self._api_request(f"/api/rewards/claim", method="POST", 
                                   data={"node_id": node_id})
            
            if data and 'error' not in data:
                print(f"✅ Rewards claimed successfully!")
                print(f"  Amount: {data.get('claimed_amount', 0)} QNC")
                print(f"  Transaction ID: {data.get('tx_id', 'pending')}")
                print(f"  New Balance: {data.get('new_balance', 0)} QNC")
            else:
                print(f"❌ Reward claim failed: {data.get('error', 'Unknown error')}")
        except Exception as e:
            print(f"Error claiming rewards: {e}")
            
    def _get_node_config(self):
        """Get local node configuration."""
        import os
        import json
        
        config_paths = [
            os.path.expanduser("~/.qnet/node_config.json"),
            "./node_config.json",
            "./node1_data/config.json"
        ]
        
        for path in config_paths:
            if os.path.exists(path):
                try:
                    with open(path, 'r') as f:
                        return json.load(f)
                except:
                    continue
                    
        # Generate temporary node ID if no config found
        import hashlib
        import socket
        hostname = socket.gethostname()
        node_id = hashlib.sha256(hostname.encode()).hexdigest()[:16]
        return {"node_id": f"node_{node_id}"}
    
    def network_peers(self, args):
        """List connected peers."""
        data = self._api_request("/api/peers")
        
        if data:
            if not data:
                print("No peers connected.")
                return
            
            print(f"Connected Peers ({len(data)}):")
            for peer in data:
                print(f"  - {peer.get('id', 'Unknown')} @ {peer.get('address', 'Unknown')}")
                if 'region' in peer:
                    print(f"    Region: {peer['region']}")
    
    def network_stats(self, args):
        """Show network statistics."""
        data = self._api_request("/api/network/stats")
        
        if data:
            print("Network Statistics:")
            print(f"  Total Nodes: {data.get('total_nodes', 0)}")
            print(f"  Active Nodes: {data.get('active_nodes', 0)}")
            print(f"  Current TPS: {data.get('current_tps', 0)}")
            print(f"  Peak TPS: {data.get('peak_tps', 0)}")
            print(f"  Total Transactions: {data.get('total_transactions', 0)}")
            
            if 'regional_distribution' in data:
                print("\nRegional Distribution:")
                for region, count in data['regional_distribution'].items():
                    print(f"  {region}: {count} nodes")


if __name__ == '__main__':
    cli = SimpleCLI()
    cli.run(sys.argv) 