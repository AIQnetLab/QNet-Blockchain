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
    
    def __init__(self, rpc_url: str = "https://api.devnet.solana.com"):
        """Initialize Solana verifier.
        
        Args:
            rpc_url: Solana RPC endpoint
        """
        self.rpc_url = rpc_url
        self.one_dev_mint = "62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ"  # Real 1DEV token
        self.burn_address = "1nc1nerator11111111111111111111111111111111"  # Solana incinerator
    
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
        try:
            # Get transaction details from Solana
            tx_details = self.get_burn_details(tx_hash)
            
            if not tx_details:
                return False, "Transaction not found on Solana"
            
            # Verify transaction is confirmed
            if not tx_details.get('confirmed', False):
                return False, "Transaction not confirmed on Solana"
            
            # Verify wallet matches
            if tx_details['wallet'] != expected_wallet:
                return False, f"Wallet mismatch: expected {expected_wallet}, got {tx_details['wallet']}"
            
            # Verify amount matches (Phase 1: universal 1500 1DEV pricing)
            if tx_details['amount'] != expected_amount:
                return False, f"Amount mismatch: expected {expected_amount}, got {tx_details['amount']}"
            
            # Verify it's a burn transaction to incinerator
            if not tx_details.get('is_burn', False):
                return False, "Transaction is not a burn to incinerator address"
            
            # Verify token is 1DEV
            if tx_details.get('token_mint') != self.one_dev_mint:
                return False, f"Wrong token: expected 1DEV ({self.one_dev_mint})"
            
            return True, "Burn transaction verified successfully"
            
        except Exception as e:
            return False, f"Verification failed: {str(e)}"
    
    def get_burn_details(self, tx_hash: str) -> Optional[dict]:
        """Get details of a burn transaction.
        
        Args:
            tx_hash: Transaction hash
            
        Returns:
            Burn details or None
        """
        try:
            import requests
            import json
            
            # Request transaction details from Solana RPC
            payload = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "getTransaction",
                "params": [
                    tx_hash,
                    {
                        "encoding": "jsonParsed",
                        "commitment": "confirmed",
                        "maxSupportedTransactionVersion": 0
                    }
                ]
            }
            
            response = requests.post(
                self.rpc_url,
                json=payload,
                headers={'Content-Type': 'application/json'},
                timeout=30
            )
            
            if response.status_code != 200:
                print(f"❌ RPC request failed: {response.status_code}")
                return None
            
            data = response.json()
            
            if 'error' in data:
                print(f"❌ RPC error: {data['error']}")
                return None
            
            if not data.get('result'):
                print(f"❌ Transaction not found: {tx_hash}")
                return None
            
            tx_data = data['result']
            
            # Parse transaction for burn details
            return self.parse_burn_transaction(tx_data)
            
        except Exception as e:
            print(f"❌ Error getting burn details: {e}")
            return None
    
    def parse_burn_transaction(self, tx_data: dict) -> Optional[dict]:
        """Parse Solana transaction for burn details"""
        try:
            # Extract metadata
            meta = tx_data.get('meta', {})
            transaction = tx_data.get('transaction', {})
            
            # Check if transaction succeeded
            if meta.get('err') is not None:
                return None
            
            # Get transaction message
            message = transaction.get('message', {})
            instructions = message.get('instructions', [])
            
            # Look for SPL token transfer to burn address
            for instruction in instructions:
                if instruction.get('program') == 'spl-token':
                    parsed = instruction.get('parsed', {})
                    if parsed.get('type') == 'transfer':
                        info = parsed.get('info', {})
                        
                        # Check if transfer is to burn address
                        destination = info.get('destination')
                        if destination == self.burn_address:
                            # Extract burn details
                            amount = int(info.get('amount', 0))
                            authority = info.get('authority')  # Sender wallet
                            mint = info.get('mint')  # Token mint
                            
                            return {
                                'tx_hash': tx_data.get('transaction', {}).get('signatures', [None])[0],
                                'wallet': authority,
                                'amount': amount,
                                'token_mint': mint,
                                'timestamp': tx_data.get('blockTime', 0),
                                'confirmed': True,
                                'is_burn': True,
                                'block_height': tx_data.get('slot', 0)
                            }
            
            return None
            
        except Exception as e:
            print(f"❌ Error parsing burn transaction: {e}")
            return None


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
        try:
            # Look up transaction in QNet blockchain
            tx_details = self.get_qnet_transaction(tx_hash)
            
            if not tx_details:
                return False, "Transaction not found on QNet"
            
            # Verify transaction is confirmed
            if not tx_details.get('confirmed', False):
                return False, "Transaction not confirmed on QNet"
            
            # Verify wallet matches
            if tx_details['from_wallet'] != expected_wallet:
                return False, f"Wallet mismatch: expected {expected_wallet}, got {tx_details['from_wallet']}"
            
            # Verify amount matches (Phase 2: tiered pricing)
            if tx_details['amount'] != expected_amount:
                return False, f"Amount mismatch: expected {expected_amount}, got {tx_details['amount']}"
            
            # Verify it's a transfer to Pool 3
            if tx_details.get('to_wallet') != "POOL_3_ADDRESS":
                return False, "Transaction is not a transfer to Pool 3"
            
            # Verify token is QNC
            if tx_details.get('token_type') != "QNC":
                return False, "Transaction is not QNC token transfer"
            
            return True, "QNet transaction verified successfully"
            
        except Exception as e:
            return False, f"Verification failed: {str(e)}"
    
    def get_qnet_transaction(self, tx_hash: str) -> Optional[dict]:
        """Get QNet transaction details"""
        try:
            # Query blockchain state for transaction
            if hasattr(self.state, 'get_transaction'):
                tx = self.state.get_transaction(tx_hash)
                if tx:
                    return {
                        'tx_hash': tx_hash,
                        'from_wallet': tx.sender,
                        'to_wallet': tx.recipient,
                        'amount': tx.amount,
                        'token_type': 'QNC',
                        'timestamp': tx.timestamp,
                        'confirmed': True,
                        'block_height': tx.block_height
                    }
            
            return None
            
        except Exception as e:
            print(f"❌ Error getting QNet transaction: {e}")
            return None 