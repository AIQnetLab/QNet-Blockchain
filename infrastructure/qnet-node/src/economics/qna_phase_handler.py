"""
QNA Phase Handler
Handles node activation during QNA phase by reading Solana burn data
NO smart contract needed - just reads Solana and activates nodes in QNet
"""

from typing import Dict, Optional, Tuple
from dataclasses import dataclass
import time
import logging

logger = logging.getLogger(__name__)

@dataclass 
class QNANodeActivation:
    """Record of node activation during QNA phase"""
    node_id: str
    owner_address: str
    node_type: str
    activation_timestamp: int
    qna_burned: int
    solana_burn_tx: str
    is_genesis: bool = False

class QNAPhaseHandler:
    """
    Handles node activation during QNA phase (first 5 years or until 90% burn)
    Reads burn data from Solana and activates nodes in QNet
    """
    
    def __init__(self):
        # Node registry
        self.activated_nodes: Dict[str, QNANodeActivation] = {}
        self.used_burn_txs = set()  # Prevent reuse of burn transactions
        
        # Genesis whitelist
        self.genesis_whitelist = {
            "QNetGenesis1xxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
            "QNetGenesis2xxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
            "QNetGenesis3xxxxxxxxxxxxxxxxxxxxxxxxxxxxx", 
            "QNetGenesis4xxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
        }
        self.genesis_claimed = set()
        
        # Pricing model
        self.base_prices = {
            "light": 1000,
            "full": 1500,
            "super": 2000
        }
        self.min_prices = {
            "light": 100,
            "full": 150,
            "super": 200
        }
        
    def activate_node(
        self,
        owner_address: str,
        node_type: str,
        node_id: str,
        solana_burn_tx: str,
        burned_amount: int,
        total_burned_global: int
    ) -> Tuple[bool, str]:
        """
        Activate a node based on Solana QNA burn
        
        Args:
            owner_address: QNet address of node owner
            node_type: Type of node (light/full/super)
            node_id: Unique node identifier
            solana_burn_tx: Solana burn transaction hash
            burned_amount: Amount burned in this transaction
            total_burned_global: Total QNA burned globally (from Solana)
            
        Returns:
            (success, message)
        """
        
        # Validate node type
        if node_type not in self.base_prices:
            return False, f"Invalid node type: {node_type}"
            
        # Check if node already activated
        if node_id in self.activated_nodes:
            return False, "Node already activated"
            
        # Check if burn tx already used
        if solana_burn_tx in self.used_burn_txs:
            return False, "Burn transaction already used for another node"
        
        # Check genesis whitelist
        if owner_address in self.genesis_whitelist:
            if owner_address not in self.genesis_claimed:
                # Free activation for genesis
                self.genesis_claimed.add(owner_address)
                activation = QNANodeActivation(
                    node_id=node_id,
                    owner_address=owner_address,
                    node_type=node_type,
                    activation_timestamp=int(time.time()),
                    qna_burned=0,
                    solana_burn_tx="GENESIS_FREE",
                    is_genesis=True
                )
                self.activated_nodes[node_id] = activation
                logger.info(f"Genesis node activated for free: {node_id}")
                return True, "Genesis node activated for free"
        
        # Calculate required price based on burn progress
        required_price = self._calculate_dynamic_price(node_type, total_burned_global)
        
        # Verify burned amount
        if burned_amount < required_price:
            return False, f"Insufficient burn: {burned_amount} < {required_price} QNA"
        
        # Create activation record
        activation = QNANodeActivation(
            node_id=node_id,
            owner_address=owner_address,
            node_type=node_type,
            activation_timestamp=int(time.time()),
            qna_burned=burned_amount,
            solana_burn_tx=solana_burn_tx,
            is_genesis=False
        )
        
        # Store activation
        self.activated_nodes[node_id] = activation
        self.used_burn_txs.add(solana_burn_tx)
        
        logger.info(f"Node activated: {node_id}, type: {node_type}, burned: {burned_amount} QNA")
        return True, f"Node activated successfully. Type: {node_type}"
    
    def _calculate_dynamic_price(self, node_type: str, total_burned: int) -> int:
        """
        Calculate node price based on burn progress
        Uses exponential decay from base to minimum
        """
        
        # Constants
        total_supply = 1_000_000_000  # 1 billion (Pump.fun standard)
        max_burn_for_pricing = total_supply * 0.9  # 90%
        
        # Calculate progress (0 to 1)
        progress = min(total_burned / max_burn_for_pricing, 1.0)
        
        # Get base and min prices
        base = self.base_prices[node_type]
        minimum = self.min_prices[node_type]
        
        # Exponential decay formula
        import math
        price = minimum + (base - minimum) * math.exp(-progress * 3.0)
        
        # Round to nearest 50
        return int(round(price / 50) * 50)
    
    def verify_solana_burn(self, burn_tx: str, expected_amount: int) -> bool:
        """
        Verify Solana burn transaction
        In production, this would query Solana blockchain
        """
        # TODO: Implement actual Solana verification
        # For now, assume valid
        return True
    
    def get_node_info(self, node_id: str) -> Optional[QNANodeActivation]:
        """Get activation info for a node"""
        return self.activated_nodes.get(node_id)
    
    def get_current_prices(self, total_burned: int) -> Dict[str, int]:
        """Get current prices for all node types"""
        return {
            node_type: self._calculate_dynamic_price(node_type, total_burned)
            for node_type in self.base_prices
        }
    
    def get_stats(self) -> Dict:
        """Get activation statistics"""
        node_counts = {"light": 0, "full": 0, "super": 0}
        total_burned = 0
        
        for node in self.activated_nodes.values():
            node_counts[node.node_type] += 1
            total_burned += node.qna_burned
            
        return {
            "phase": "QNA",
            "total_nodes": len(self.activated_nodes),
            "nodes_by_type": node_counts,
            "genesis_claimed": len(self.genesis_claimed),
            "genesis_remaining": 4 - len(self.genesis_claimed),
            "total_qna_burned_for_nodes": total_burned,
            "unique_burn_txs": len(self.used_burn_txs)
        }
    
    def export_for_migration(self) -> Dict[str, QNANodeActivation]:
        """
        Export all QNA activations for migration to QNC phase
        This data will be used to allow free migration
        """
        return self.activated_nodes.copy() 