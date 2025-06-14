#!/usr/bin/env python3
"""
QNet CLI - Command line interface for QNet blockchain.
"""

import click
import json
import requests
import os
import sys
from pathlib import Path
from typing import Optional, Dict, Any

# Add parent directory to path for imports
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

# Configuration
DEFAULT_NODE_URL = "http://localhost:5000"
CONFIG_DIR = Path.home() / ".qnet"
CONFIG_FILE = CONFIG_DIR / "cli_config.json"

# Ensure config directory exists
CONFIG_DIR.mkdir(exist_ok=True)


class Config:
    """CLI configuration management."""
    
    def __init__(self):
        self.node_url = DEFAULT_NODE_URL
        self.wallet_path = None
        self.load()
    
    def load(self):
        """Load configuration from file."""
        if CONFIG_FILE.exists():
            with open(CONFIG_FILE, 'r') as f:
                data = json.load(f)
                self.node_url = data.get('node_url', DEFAULT_NODE_URL)
                self.wallet_path = data.get('wallet_path')
    
    def save(self):
        """Save configuration to file."""
        with open(CONFIG_FILE, 'w') as f:
            json.dump({
                'node_url': self.node_url,
                'wallet_path': self.wallet_path
            }, f, indent=2)


# Global config instance
config = Config()


@click.group()
@click.option('--node-url', default=None, help='QNet node URL')
def cli(node_url):
    """QNet CLI - Manage your QNet node and wallet."""
    if node_url:
        config.node_url = node_url
        config.save()


@cli.group()
def node():
    """Node management commands."""
    pass


@node.command()
@click.option('--type', 'node_type', type=click.Choice(['light', 'full', 'super']), 
              default='full', help='Node type')
@click.option('--region', default='auto', help='Geographic region')
@click.option('--data-dir', default='./data', help='Data directory')
def start(node_type, region, data_dir):
    """Start a QNet node."""
    click.echo(f"Starting {node_type} node in region {region}...")
    
    # TODO: Implement actual node start logic
    # For now, just show what would happen
    click.echo(f"Node configuration:")
    click.echo(f"  Type: {node_type}")
    click.echo(f"  Region: {region}")
    click.echo(f"  Data directory: {data_dir}")
    click.echo(f"  API endpoint: {config.node_url}")
    
    click.echo("\nNode would start with these settings.")
    click.echo("Note: Actual node startup not yet implemented.")


@node.command()
def status():
    """Check node status."""
    try:
        response = requests.get(f"{config.node_url}/api/node/status", timeout=5)
        if response.status_code == 200:
            data = response.json()
            
            click.echo("Node Status:")
            click.echo(f"  Node ID: {data.get('node_id', 'N/A')}")
            click.echo(f"  Type: {data.get('node_type', 'N/A')}")
            click.echo(f"  Address: {data.get('address', 'N/A')}")
            click.echo(f"  Blockchain Height: {data.get('blockchain_height', 0)}")
            click.echo(f"  Peers: {data.get('peers_count', 0)}")
            click.echo(f"  Mining: {data.get('is_mining', False)}")
            
            # Regional info if available
            if 'region' in data:
                region = data['region']
                click.echo(f"\nRegional Info:")
                click.echo(f"  Region: {region.get('name', 'N/A')}")
                click.echo(f"  Regional Sharding: {region.get('regional_sharding', False)}")
                
                if 'network_distribution' in region:
                    dist = region['network_distribution']
                    click.echo(f"  Network Distribution:")
                    click.echo(f"    Total Nodes: {dist.get('total_nodes', 0)}")
                    click.echo(f"    Active Regions: {dist.get('regions_active', 0)}")
                    click.echo(f"    Concentration Index: {dist.get('concentration_index', 0):.2f}")
        else:
            click.echo(f"Error: Node returned status {response.status_code}", err=True)
    except requests.exceptions.ConnectionError:
        click.echo("Error: Cannot connect to node. Is it running?", err=True)
    except Exception as e:
        click.echo(f"Error: {str(e)}", err=True)


@node.command()
def stop():
    """Stop the node."""
    click.echo("Stopping node...")
    # TODO: Implement actual stop logic
    click.echo("Note: Node stop not yet implemented.")


@cli.group()
def wallet():
    """Wallet management commands."""
    pass


@wallet.command()
@click.option('--path', default=None, help='Wallet file path')
def create(path):
    """Create a new wallet."""
    wallet_path = path or (CONFIG_DIR / "wallet.json")
    
    if Path(wallet_path).exists():
        if not click.confirm(f"Wallet already exists at {wallet_path}. Overwrite?"):
            return
    
    click.echo(f"Creating new wallet at {wallet_path}...")
    
    # TODO: Implement actual wallet creation
    # For now, create a dummy wallet
    wallet_data = {
        "address": "qnet1" + "x" * 40,  # Dummy address
        "public_key": "dummy_public_key",
        "encrypted_private_key": "dummy_encrypted_key"
    }
    
    with open(wallet_path, 'w') as f:
        json.dump(wallet_data, f, indent=2)
    
    config.wallet_path = str(wallet_path)
    config.save()
    
    click.echo(f"Wallet created successfully!")
    click.echo(f"Address: {wallet_data['address']}")
    click.echo("\nIMPORTANT: Save your seed phrase securely!")
    click.echo("Note: Actual wallet creation not yet implemented.")


@wallet.command()
def balance():
    """Check wallet balance."""
    if not config.wallet_path or not Path(config.wallet_path).exists():
        click.echo("Error: No wallet found. Create one with 'qnet-cli wallet create'", err=True)
        return
    
    # Load wallet
    with open(config.wallet_path, 'r') as f:
        wallet_data = json.load(f)
    
    address = wallet_data.get('address')
    
    try:
        response = requests.get(f"{config.node_url}/api/balance/{address}", timeout=5)
        if response.status_code == 200:
            data = response.json()
            click.echo(f"Wallet Balance:")
            click.echo(f"  Address: {address}")
            click.echo(f"  Balance: {data.get('balance', 0)} QNC")
            click.echo(f"  Pending: {data.get('pending', 0)} QNC")
        else:
            click.echo(f"Error: Failed to get balance", err=True)
    except Exception as e:
        click.echo(f"Error: {str(e)}", err=True)


@wallet.command()
@click.argument('recipient')
@click.argument('amount', type=float)
def send(recipient, amount):
    """Send QNC to another address."""
    if not config.wallet_path or not Path(config.wallet_path).exists():
        click.echo("Error: No wallet found. Create one with 'qnet-cli wallet create'", err=True)
        return
    
    click.echo(f"Sending {amount} QNC to {recipient}...")
    
    # TODO: Implement actual transaction sending
    click.echo("Note: Transaction sending not yet implemented.")


@cli.group()
def rewards():
    """Rewards management commands."""
    pass


@rewards.command()
def check():
    """Check unclaimed rewards."""
    try:
        # TODO: Get node ID from config or wallet
        node_id = "dummy_node_id"
        
        response = requests.get(f"{config.node_url}/api/rewards/{node_id}", timeout=5)
        if response.status_code == 200:
            data = response.json()
            click.echo(f"Rewards Status:")
            click.echo(f"  Unclaimed: {data.get('unclaimed', 0)} QNC")
            click.echo(f"  Total Earned: {data.get('total_earned', 0)} QNC")
            click.echo(f"  Last Claim: {data.get('last_claim', 'Never')}")
        else:
            click.echo(f"Error: Failed to check rewards", err=True)
    except Exception as e:
        click.echo(f"Error: {str(e)}", err=True)


@rewards.command()
def claim():
    """Claim accumulated rewards (manual - operator controlled)."""
    if not config.wallet_path or not Path(config.wallet_path).exists():
        click.echo("Error: No wallet found. Create one with 'qnet-cli wallet create'", err=True)
        return
    
    click.echo("Claiming rewards...")
    
    try:
        # Get node ID from config
        with open(config.wallet_path, 'r') as f:
            wallet_data = json.load(f)
            node_id = wallet_data.get('node_id', 'unknown')
            wallet_address = wallet_data.get('address', 'unknown')
        
        # Check unclaimed rewards first
        response = requests.get(f"{config.node_url}/api/rewards/{node_id}", timeout=10)
        if response.status_code != 200:
            click.echo(f"Error: Failed to check rewards status", err=True)
            return
            
        reward_data = response.json()
        unclaimed = float(reward_data.get('unclaimed', 0))
        
        if unclaimed < 1.0:  # Minimum claim amount (no time restrictions)
            click.echo(f"Insufficient rewards to claim: {unclaimed:.3f} QNC (minimum: 1.0 QNC)")
            click.echo("💡 Tip: Let rewards accumulate longer for more convenient claiming")
            return
            
        # Confirm claim
        click.echo(f"Available to claim: {unclaimed:.3f} QNC")
        if not click.confirm("Proceed with claim?"):
            return
            
        # Submit claim request
        claim_data = {
            "node_id": node_id,
            "wallet_address": wallet_address,
            "amount": unclaimed
        }
        
        response = requests.post(f"{config.node_url}/api/rewards/claim", 
                               json=claim_data, timeout=10)
        
        if response.status_code == 200:
            result = response.json()
            claimed_amount = result.get('claimed', unclaimed)
            click.echo(f"✅ Successfully claimed {claimed_amount:.3f} QNC!")
            click.echo(f"   Transaction hash: {result.get('tx_hash', 'N/A')}")
        else:
            error_msg = response.json().get('error', 'Unknown error')
            click.echo(f"❌ Claim failed: {error_msg}", err=True)
            
    except Exception as e:
        click.echo(f"Error: {str(e)}", err=True)


@cli.group()
def network():
    """Network information commands."""
    pass


@network.command()
def peers():
    """List connected peers."""
    try:
        response = requests.get(f"{config.node_url}/api/peers", timeout=5)
        if response.status_code == 200:
            peers_list = response.json()
            
            if not peers_list:
                click.echo("No peers connected.")
                return
            
            click.echo(f"Connected Peers ({len(peers_list)}):")
            for peer in peers_list:
                click.echo(f"  - {peer.get('id', 'Unknown')} @ {peer.get('address', 'Unknown')}")
                if 'region' in peer:
                    click.echo(f"    Region: {peer['region']}")
        else:
            click.echo(f"Error: Failed to get peers", err=True)
    except Exception as e:
        click.echo(f"Error: {str(e)}", err=True)


@network.command()
def stats():
    """Show network statistics."""
    try:
        response = requests.get(f"{config.node_url}/api/network/stats", timeout=5)
        if response.status_code == 200:
            data = response.json()
            
            click.echo("Network Statistics:")
            click.echo(f"  Total Nodes: {data.get('total_nodes', 0)}")
            click.echo(f"  Active Nodes: {data.get('active_nodes', 0)}")
            click.echo(f"  Current TPS: {data.get('current_tps', 0)}")
            click.echo(f"  Peak TPS: {data.get('peak_tps', 0)}")
            click.echo(f"  Total Transactions: {data.get('total_transactions', 0)}")
            
            # Regional distribution
            if 'regional_distribution' in data:
                click.echo("\nRegional Distribution:")
                for region, count in data['regional_distribution'].items():
                    click.echo(f"  {region}: {count} nodes")
        else:
            click.echo(f"Error: Failed to get network stats", err=True)
    except Exception as e:
        click.echo(f"Error: {str(e)}", err=True)


@cli.command()
def version():
    """Show QNet CLI version."""
    click.echo("QNet CLI v0.1.0")
    click.echo("QNet Protocol v1.0.0")


if __name__ == '__main__':
    cli() 