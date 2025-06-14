#!/usr/bin/env python3
"""
1DEV Token Simulator for Testing
Simulates 1DEV token operations without requiring Solana CLI
"""

import json
import hashlib
import time
import random
from pathlib import Path
from typing import Dict, List, Optional

class MockSolanaToken:
    def __init__(self):
        self.token_address = "DEV1111111111111111111111111111111111111111"
        self.total_supply = 1_000_000_000  # 1 billion
        self.decimals = 6
        self.balances: Dict[str, int] = {}
        self.burn_history: List[Dict] = []
        self.transaction_history: List[Dict] = []
        
        # Initialize faucet with full supply
        self.faucet_address = "FAUCET1111111111111111111111111111111111111"
        self.balances[self.faucet_address] = self.total_supply * (10 ** self.decimals)
        
    def create_wallet(self) -> str:
        """Create a mock Solana wallet address"""
        random_bytes = random.randbytes(32)
        return hashlib.sha256(random_bytes).hexdigest()[:44]
    
    def get_balance(self, wallet_address: str) -> int:
        """Get token balance for wallet"""
        return self.balances.get(wallet_address, 0)
    
    def transfer(self, from_addr: str, to_addr: str, amount: int) -> str:
        """Transfer tokens between wallets"""
        if self.get_balance(from_addr) < amount:
            raise ValueError(f"Insufficient balance: {self.get_balance(from_addr)} < {amount}")
        
        # Execute transfer
        self.balances[from_addr] = self.balances.get(from_addr, 0) - amount
        self.balances[to_addr] = self.balances.get(to_addr, 0) + amount
        
        # Generate transaction hash
        tx_data = f"{from_addr}:{to_addr}:{amount}:{time.time()}"
        tx_hash = hashlib.sha256(tx_data.encode()).hexdigest()
        
        # Record transaction
        self.transaction_history.append({
            "hash": tx_hash,
            "from": from_addr,
            "to": to_addr,
            "amount": amount,
            "timestamp": time.time(),
            "type": "transfer"
        })
        
        return tx_hash
    
    def burn(self, from_addr: str, amount: int) -> str:
        """Burn tokens (send to null address)"""
        burn_address = "11111111111111111111111111111112"
        tx_hash = self.transfer(from_addr, burn_address, amount)
        
        # Record burn
        self.burn_history.append({
            "hash": tx_hash,
            "wallet": from_addr,
            "amount": amount,
            "timestamp": time.time()
        })
        
        # Update transaction type
        for tx in self.transaction_history:
            if tx["hash"] == tx_hash:
                tx["type"] = "burn"
                break
        
        return tx_hash
    
    def faucet_claim(self, wallet_address: str, amount: int) -> str:
        """Claim tokens from faucet"""
        return self.transfer(self.faucet_address, wallet_address, amount)
    
    def get_total_burned(self) -> int:
        """Get total amount of tokens burned"""
        burn_address = "11111111111111111111111111111112"
        return self.get_balance(burn_address)
    
    def get_burn_percentage(self) -> float:
        """Get percentage of total supply burned"""
        total_burned = self.get_total_burned()
        total_supply_raw = self.total_supply * (10 ** self.decimals)
        return (total_burned / total_supply_raw) * 100

class QNetNodeActivator:
    def __init__(self, token: MockSolanaToken):
        self.token = token
        self.activations: Dict[str, Dict] = {}
        self.node_requirements = {
            "light": 1500 * (10 ** 6),   # 1500 tokens with 6 decimals
            "full": 1500 * (10 ** 6),
            "super": 1500 * (10 ** 6)
        }
    
    def activate_node(self, wallet_address: str, node_type: str) -> Dict:
        """Activate a node by burning tokens"""
        if node_type not in self.node_requirements:
            raise ValueError(f"Invalid node type: {node_type}")
        
        required_amount = self.node_requirements[node_type]
        
        # Check balance
        if self.token.get_balance(wallet_address) < required_amount:
            raise ValueError(f"Insufficient balance for {node_type} node activation")
        
        # Burn tokens
        burn_tx_hash = self.token.burn(wallet_address, required_amount)
        
        # Generate activation code
        activation_code = self._generate_activation_code(burn_tx_hash, wallet_address, node_type)
        
        # Generate node ID
        node_id = f"node_{node_type}_{hashlib.sha256(wallet_address.encode()).hexdigest()[:8]}"
        
        # Store activation
        activation_record = {
            "node_id": node_id,
            "wallet_address": wallet_address,
            "node_type": node_type,
            "burn_tx_hash": burn_tx_hash,
            "burn_amount": required_amount,
            "activation_code": activation_code,
            "timestamp": time.time(),
            "status": "active"
        }
        
        self.activations[node_id] = activation_record
        
        return activation_record
    
    def _generate_activation_code(self, burn_tx_hash: str, wallet_address: str, node_type: str) -> str:
        """Generate activation code from burn transaction"""
        salt = "QNET_NODE_ACTIVATION_V1"
        data = f"{burn_tx_hash}:{wallet_address}:{node_type}:{salt}"
        hash_val = hashlib.sha256(data.encode()).hexdigest()
        code = hash_val[:12].upper()
        return f"QNET-{code[:4]}-{code[4:8]}-{code[8:12]}"
    
    def get_activation_by_code(self, activation_code: str) -> Optional[Dict]:
        """Get activation record by code"""
        for activation in self.activations.values():
            if activation["activation_code"] == activation_code:
                return activation
        return None

def main():
    """Main simulation function"""
    print("🚀 QNet 1DEV Token Simulator")
    print("=" * 50)
    
    # Initialize token and activator
    token = MockSolanaToken()
    activator = QNetNodeActivator(token)
    
    print(f"✅ Mock 1DEV token created:")
    print(f"   Address: {token.token_address}")
    print(f"   Total Supply: {token.total_supply:,} tokens")
    print(f"   Decimals: {token.decimals}")
    print(f"   Faucet Balance: {token.get_balance(token.faucet_address) / (10**6):,.0f} tokens")
    
    # Test 1: Create test wallets and claim from faucet
    print(f"\n📋 Test 1: Faucet Claims")
    test_wallets = []
    for i in range(5):
        wallet = token.create_wallet()
        test_wallets.append(wallet)
        
        # Claim 1500 tokens from faucet
        claim_amount = 1500 * (10 ** 6)
        tx_hash = token.faucet_claim(wallet, claim_amount)
        
        print(f"   Wallet {i+1}: {wallet[:20]}... claimed 1,500 1DEV (TX: {tx_hash[:16]}...)")
    
    # Test 2: Node activations
    print(f"\n📋 Test 2: Node Activations")
    node_types = ["light", "full", "super", "light", "full"]
    
    for i, (wallet, node_type) in enumerate(zip(test_wallets, node_types)):
        try:
            activation = activator.activate_node(wallet, node_type)
            print(f"   ✅ {node_type.capitalize()} node activated:")
            print(f"      Node ID: {activation['node_id']}")
            print(f"      Activation Code: {activation['activation_code']}")
            print(f"      Burn TX: {activation['burn_tx_hash'][:16]}...")
        except Exception as e:
            print(f"   ❌ Failed to activate {node_type} node: {e}")
    
    # Test 3: Token statistics
    print(f"\n📋 Test 3: Token Statistics")
    total_burned = token.get_total_burned()
    burn_percentage = token.get_burn_percentage()
    
    print(f"   Total Burned: {total_burned / (10**6):,.0f} 1DEV")
    print(f"   Burn Percentage: {burn_percentage:.2f}%")
    print(f"   Active Nodes: {len(activator.activations)}")
    print(f"   Transactions: {len(token.transaction_history)}")
    
    # Test 4: Activation code verification
    print(f"\n📋 Test 4: Activation Code Verification")
    if activator.activations:
        test_activation = list(activator.activations.values())[0]
        test_code = test_activation["activation_code"]
        
        verified = activator.get_activation_by_code(test_code)
        if verified:
            print(f"   ✅ Code verification successful: {test_code}")
            print(f"      Node ID: {verified['node_id']}")
            print(f"      Node Type: {verified['node_type']}")
        else:
            print(f"   ❌ Code verification failed")
    
    # Test 5: Phase transition simulation
    print(f"\n📋 Test 5: Phase Transition Simulation")
    
    # Simulate massive burn to trigger phase transition
    print(f"   Simulating large-scale adoption...")
    
    # Create 1000 more wallets and activate nodes
    for i in range(1000):
        wallet = token.create_wallet()
        claim_amount = 1500 * (10 ** 6)
        
        try:
            # Claim and burn
            token.faucet_claim(wallet, claim_amount)
            node_type = random.choice(["light", "full", "super"])
            activator.activate_node(wallet, node_type)
            
            if (i + 1) % 100 == 0:
                current_burn = token.get_burn_percentage()
                print(f"      Progress: {i+1:,} nodes, {current_burn:.1f}% burned")
                
                # Check if we hit 90% threshold
                if current_burn >= 90:
                    print(f"   🎯 Phase transition threshold reached!")
                    print(f"      90% of tokens burned - transitioning to Phase 2")
                    break
                    
        except Exception as e:
            # Faucet might run out of tokens
            if "Insufficient balance" in str(e):
                print(f"   ⚠️ Faucet depleted after {i} additional activations")
                break
    
    # Final statistics
    print(f"\n📊 Final Statistics")
    print(f"=" * 50)
    
    final_burned = token.get_total_burned()
    final_burn_percentage = token.get_burn_percentage()
    total_nodes = len(activator.activations)
    
    print(f"Total Nodes Activated: {total_nodes:,}")
    print(f"Total Tokens Burned: {final_burned / (10**6):,.0f} 1DEV")
    print(f"Burn Percentage: {final_burn_percentage:.2f}%")
    print(f"Remaining Supply: {(token.total_supply * (10**6) - final_burned) / (10**6):,.0f} 1DEV")
    
    # Node type distribution
    node_counts = {"light": 0, "full": 0, "super": 0}
    for activation in activator.activations.values():
        node_counts[activation["node_type"]] += 1
    
    print(f"\nNode Distribution:")
    print(f"  Light Nodes: {node_counts['light']:,}")
    print(f"  Full Nodes: {node_counts['full']:,}")
    print(f"  Super Nodes: {node_counts['super']:,}")
    
    # Phase status
    if final_burn_percentage >= 90:
        print(f"\n🎯 Phase Status: TRANSITION TO PHASE 2")
        print(f"   Condition: 90% tokens burned ✅")
        print(f"   Next: Switch to QNC activation costs model")
    else:
        print(f"\n⏳ Phase Status: PHASE 1 ACTIVE")
        print(f"   Progress: {final_burn_percentage:.1f}% / 90% burned")
        print(f"   Remaining: {90 - final_burn_percentage:.1f}% to phase transition")
    
    # Save simulation results
    results = {
        "token_info": {
            "address": token.token_address,
            "total_supply": token.total_supply,
            "total_burned": final_burned,
            "burn_percentage": final_burn_percentage
        },
        "activations": activator.activations,
        "transactions": token.transaction_history,
        "node_distribution": node_counts,
        "phase_status": {
            "current_phase": 2 if final_burn_percentage >= 90 else 1,
            "transition_ready": final_burn_percentage >= 90
        }
    }
    
    with open("1dev_simulation_results.json", "w") as f:
        json.dump(results, f, indent=2, default=str)
    
    print(f"\n✅ Simulation complete! Results saved to 1dev_simulation_results.json")
    
    # Update config.ini with simulated token address
    config_path = Path("config/config.ini")
    if config_path.exists():
        with open(config_path, 'r') as f:
            content = f.read()
        
        updated_content = content.replace(
            'PLACEHOLDER_TO_BE_CREATED', 
            token.token_address
        )
        
        with open(config_path, 'w') as f:
            f.write(updated_content)
        
        print(f"✅ Updated config.ini with simulated token address")
    
    return results

if __name__ == "__main__":
    main() 