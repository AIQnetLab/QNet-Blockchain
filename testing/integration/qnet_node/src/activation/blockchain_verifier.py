"""
Blockchain verification for node activations.
Ensures one wallet = one node policy and prevents duplicate activations.
"""

import json
import time
from typing import Optional, Dict, Set
from dataclasses import dataclass
from enum import Enum

from ..blockchain.transaction import Transaction, TransactionType
from ..blockchain.state import State
from .seed_generator import SeedGenerator


class NodeType(Enum):
    """Node types with their burn requirements."""
    LIGHT = ("light", 1500)
    FULL = ("full", 1500)
    SUPER = ("super", 1500)
    
    def __init__(self, name: str, burn_amount: int):
        self.node_name = name
        self.burn_amount = burn_amount


@dataclass
class ActivationRecord:
    """Record of a node activation."""
    burn_tx_hash: str
    wallet_address: str
    node_public_key: str
    node_type: str
    activation_time: int
    block_height: int
    
    def to_dict(self) -> dict:
        """Convert to dictionary."""
        return {
            'burn_tx_hash': self.burn_tx_hash,
            'wallet_address': self.wallet_address,
            'node_public_key': self.node_public_key,
            'node_type': self.node_type,
            'activation_time': self.activation_time,
            'block_height': self.block_height
        }


class ActivationVerifier:
    """Verifies and tracks node activations on blockchain."""
    
    # Special key in state for activation registry
    ACTIVATION_REGISTRY_KEY = "NODE_ACTIVATIONS"
    WALLET_REGISTRY_KEY = "WALLET_ACTIVATIONS"
    
    def __init__(self, state: State):
        """Initialize verifier with blockchain state.
        
        Args:
            state: Blockchain state manager
        """
        self.state = state
        self.seed_generator = SeedGenerator()
        
        # Initialize registries if not exists
        if not self.state.get(self.ACTIVATION_REGISTRY_KEY):
            self.state.set(self.ACTIVATION_REGISTRY_KEY, {})
        if not self.state.get(self.WALLET_REGISTRY_KEY):
            self.state.set(self.WALLET_REGISTRY_KEY, {})
    
    def verify_activation(self, 
                         burn_tx_hash: str,
                         wallet_address: str,
                         node_public_key: str,
                         node_type: str,
                         signature: str) -> tuple[bool, str]:
        """Verify a node activation request.
        
        Args:
            burn_tx_hash: Hash of burn transaction
            wallet_address: Address that burned tokens
            node_public_key: Public key of the node
            node_type: Type of node being activated
            signature: Signature proving ownership of node key
            
        Returns:
            Tuple of (success, error_message)
        """
        # Check if wallet already activated a node
        wallet_registry = self.state.get(self.WALLET_REGISTRY_KEY)
        if wallet_address in wallet_registry:
            return False, f"Wallet {wallet_address} already activated a node"
        
        # Check if burn transaction already used
        activation_registry = self.state.get(self.ACTIVATION_REGISTRY_KEY)
        if burn_tx_hash in activation_registry:
            return False, f"Burn transaction {burn_tx_hash} already used"
        
        # Verify node type is valid
        valid_types = [t.node_name for t in NodeType]
        if node_type not in valid_types:
            return False, f"Invalid node type: {node_type}"
        
        # TODO: Verify burn transaction on Solana/QNet
        # This would involve checking the actual burn transaction
        # For now, we'll assume it's valid if not already used
        
        # TODO: Verify signature matches node_public_key
        # This proves the activator owns the private key
        
        return True, ""
    
    def activate_node(self,
                     burn_tx_hash: str,
                     wallet_address: str,
                     node_public_key: str,
                     node_type: str,
                     block_height: int) -> ActivationRecord:
        """Activate a node and record in blockchain.
        
        Args:
            burn_tx_hash: Hash of burn transaction
            wallet_address: Address that burned tokens
            node_public_key: Public key of the node
            node_type: Type of node being activated
            block_height: Current block height
            
        Returns:
            ActivationRecord
        """
        # Create activation record
        record = ActivationRecord(
            burn_tx_hash=burn_tx_hash,
            wallet_address=wallet_address,
            node_public_key=node_public_key,
            node_type=node_type,
            activation_time=int(time.time()),
            block_height=block_height
        )
        
        # Update registries
        activation_registry = self.state.get(self.ACTIVATION_REGISTRY_KEY)
        wallet_registry = self.state.get(self.WALLET_REGISTRY_KEY)
        
        activation_registry[burn_tx_hash] = record.to_dict()
        wallet_registry[wallet_address] = {
            'node_public_key': node_public_key,
            'burn_tx_hash': burn_tx_hash,
            'activation_time': record.activation_time
        }
        
        # Save to state
        self.state.set(self.ACTIVATION_REGISTRY_KEY, activation_registry)
        self.state.set(self.WALLET_REGISTRY_KEY, wallet_registry)
        
        return record
    
    def get_activation_by_wallet(self, wallet_address: str) -> Optional[dict]:
        """Get activation record by wallet address.
        
        Args:
            wallet_address: Wallet address to lookup
            
        Returns:
            Activation info or None
        """
        wallet_registry = self.state.get(self.WALLET_REGISTRY_KEY)
        return wallet_registry.get(wallet_address)
    
    def get_activation_by_burn(self, burn_tx_hash: str) -> Optional[dict]:
        """Get activation record by burn transaction.
        
        Args:
            burn_tx_hash: Burn transaction hash
            
        Returns:
            Activation record or None
        """
        activation_registry = self.state.get(self.ACTIVATION_REGISTRY_KEY)
        return activation_registry.get(burn_tx_hash)
    
    def is_node_active(self, node_public_key: str) -> bool:
        """Check if a node is active.
        
        Args:
            node_public_key: Node's public key
            
        Returns:
            True if active, False otherwise
        """
        activation_registry = self.state.get(self.ACTIVATION_REGISTRY_KEY)
        for record in activation_registry.values():
            if record['node_public_key'] == node_public_key:
                return True
        return False
    
    def get_active_nodes_count(self) -> Dict[str, int]:
        """Get count of active nodes by type.
        
        Returns:
            Dictionary with node type counts
        """
        counts = {'light': 0, 'full': 0, 'super': 0}
        activation_registry = self.state.get(self.ACTIVATION_REGISTRY_KEY)
        
        for record in activation_registry.values():
            node_type = record['node_type']
            if node_type in counts:
                counts[node_type] += 1
        
        return counts
    
    def create_activation_transaction(self,
                                    burn_tx_hash: str,
                                    wallet_address: str,
                                    node_public_key: str,
                                    node_type: str,
                                    signature: str) -> Transaction:
        """Create an activation transaction for the blockchain.
        
        Args:
            burn_tx_hash: Hash of burn transaction
            wallet_address: Address that burned tokens
            node_public_key: Public key of the node
            node_type: Type of node
            signature: Activation signature
            
        Returns:
            Activation transaction
        """
        data = {
            'burn_tx_hash': burn_tx_hash,
            'wallet_address': wallet_address,
            'node_public_key': node_public_key,
            'node_type': node_type,
            'signature': signature
        }
        
        # Create special activation transaction
        tx = Transaction(
            sender=wallet_address,
            receiver="ACTIVATION",  # Special address
            amount=0,  # No transfer
            fee=0,  # No fee for activation
            gas_price=1,  # Minimal gas price for activation
            gas_limit=50000,  # Higher limit for activation tx
            data=json.dumps(data),
            transaction_type=TransactionType.NODE_ACTIVATION
        )
        
        return tx


class SolanaVerifier:
    """Verifies burn transactions on Solana (Phase 1)."""
    
    def __init__(self, rpc_url: str = "https://api.mainnet-beta.solana.com"):
        """Initialize Solana verifier.
        
        Args:
            rpc_url: Solana RPC endpoint
        """
        self.rpc_url = rpc_url
        # TODO: Initialize Solana client
    
    def verify_burn(self, 
                   tx_hash: str,
                   expected_wallet: str,
                   expected_amount: int,
                   node_type: str) -> tuple[bool, str]:
        """Verify a burn transaction on Solana.
        
        Args:
            tx_hash: Transaction hash to verify
            expected_wallet: Expected sender wallet
            expected_amount: Expected burn amount
            node_type: Node type being activated
            
        Returns:
            Tuple of (valid, error_message)
        """
        # TODO: Implement actual Solana verification
        # For now, return mock success
        return True, ""
    
    def get_burn_details(self, tx_hash: str) -> Optional[dict]:
        """Get details of a burn transaction.
        
        Args:
            tx_hash: Transaction hash
            
        Returns:
            Burn details or None
        """
        # TODO: Implement Solana transaction lookup
        return {
            'tx_hash': tx_hash,
            'wallet': 'mock_wallet',
            'amount': 1500,
            'timestamp': int(time.time()),
            'confirmed': True
        }


class QNetVerifier:
    """Verifies burn transactions on QNet (Phase 2)."""
    
    def __init__(self, state: State):
        """Initialize QNet verifier.
        
        Args:
            state: Blockchain state
        """
        self.state = state
    
    def verify_burn(self,
                   tx_hash: str,
                   expected_wallet: str,
                   expected_amount: int,
                   node_type: str) -> tuple[bool, str]:
        """Verify a burn transaction on QNet.
        
        Args:
            tx_hash: Transaction hash to verify
            expected_wallet: Expected sender wallet
            expected_amount: Expected burn amount
            node_type: Node type being activated
            
        Returns:
            Tuple of (valid, error_message)
        """
        # Look up transaction in QNet blockchain
        # TODO: Implement QNet transaction verification
        return True, "" 