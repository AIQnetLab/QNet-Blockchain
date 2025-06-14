"""
QNet Native Smart Contract for Node Activation (QNC Phase)
This contract is ONLY activated after QNA->QNC transition
Handles node activation by burning native QNC tokens
"""

from typing import Dict, Optional, Tuple
from dataclasses import dataclass
from enum import Enum
import time

class NodeType(Enum):
    LIGHT = "light"
    FULL = "full"
    SUPER = "super"

@dataclass
class NodeActivation:
    """Record of node activation in QNC era"""
    node_id: str
    owner_address: str
    node_type: NodeType
    activation_timestamp: int
    qnc_burned: int
    tx_hash: str
    migrated_from_qna: bool = False

class QNCNodeActivationContract:
    """
    QNet native smart contract for node activation (POST-TRANSITION)
    This contract is dormant until QNA->QNC transition occurs
    """
    
    def __init__(self):
        # Contract state
        self.is_active = False  # Contract starts inactive
        self.transition_timestamp = 0
        self.activated_nodes: Dict[str, NodeActivation] = {}
        
        # QNC burn requirements (fixed amounts)
        self.burn_requirements = {
            NodeType.LIGHT: 5_000,    # 5k QNC
            NodeType.FULL: 7_500,     # 7.5k QNC
            NodeType.SUPER: 10_000    # 10k QNC
        }
        
        # Network size multipliers
        self.size_multipliers = {
            (0, 100_000): 0.5,              # Early phase discount
            (100_001, 1_000_000): 1.0,      # Standard rate
            (1_000_001, 10_000_000): 2.0,   # High demand
            (10_000_001, float('inf')): 3.0 # Mature network
        }
        
    def activate_contract(self, transition_timestamp: int) -> Tuple[bool, str]:
        """
        Activate this contract when QNA->QNC transition occurs
        Can only be called once by governance
        """
        if self.is_active:
            return False, "Contract already active"
            
        self.is_active = True
        self.transition_timestamp = transition_timestamp
        return True, "QNC activation contract is now active"
    
    def activate_node(
        self,
        owner_address: str,
        node_type: NodeType,
        node_id: str,
        qnc_burned: int,
        tx_hash: str,
        total_network_nodes: int
    ) -> Tuple[bool, str]:
        """
        Activate a node by burning QNC tokens
        Only works AFTER transition from QNA
        
        Args:
            owner_address: Address of node owner
            node_type: Type of node to activate
            node_id: Unique node identifier
            qnc_burned: Amount of QNC burned
            tx_hash: QNet transaction hash
            total_network_nodes: Current total nodes in network
            
        Returns:
            (success, message)
        """
        
        # Check if contract is active
        if not self.is_active:
            return False, "Contract not active. Still in QNA phase."
            
        # Check if node already activated
        if node_id in self.activated_nodes:
            return False, "Node already activated"
            
        # Calculate required burn amount
        required_burn = self._calculate_burn_requirement(
            node_type, 
            total_network_nodes
        )
        
        # Verify burned amount
        if qnc_burned < required_burn:
            return False, f"Insufficient burn: {qnc_burned} < {required_burn} QNC"
        
        # Create activation record
        activation = NodeActivation(
            node_id=node_id,
            owner_address=owner_address,
            node_type=node_type,
            activation_timestamp=int(time.time()),
            qnc_burned=qnc_burned,
            tx_hash=tx_hash,
            migrated_from_qna=False
        )
        
        # Store activation
        self.activated_nodes[node_id] = activation
        
        return True, f"Node activated successfully. Type: {node_type.value}, Burned: {qnc_burned} QNC"
    
    def migrate_qna_node(
        self,
        owner_address: str,
        node_id: str,
        original_activation_proof: Dict
    ) -> Tuple[bool, str]:
        """
        Free migration for nodes activated during QNA phase
        
        Args:
            owner_address: Address of node owner
            node_id: Node ID to migrate
            original_activation_proof: Proof of QNA-era activation
        """
        
        if not self.is_active:
            return False, "Migration not available until QNC phase"
            
        # Verify node was activated in QNA era
        # In real implementation, this would verify cryptographic proof
        if not self._verify_qna_activation(original_activation_proof):
            return False, "Invalid QNA activation proof"
            
        # Check not already migrated
        if node_id in self.activated_nodes:
            return False, "Node already migrated"
        
        # Create migration record
        activation = NodeActivation(
            node_id=node_id,
            owner_address=owner_address,
            node_type=NodeType(original_activation_proof['node_type']),
            activation_timestamp=int(time.time()),
            qnc_burned=0,  # Free migration
            tx_hash=f"MIGRATION_{original_activation_proof['qna_tx_hash']}",
            migrated_from_qna=True
        )
        
        self.activated_nodes[node_id] = activation
        
        return True, "QNA node successfully migrated to QNC network"
    
    def _calculate_burn_requirement(
        self, 
        node_type: NodeType, 
        total_nodes: int
    ) -> int:
        """
        Calculate QNC burn requirement based on network size
        """
        
        # Get base requirement
        base_burn = self.burn_requirements[node_type]
        
        # Find size multiplier
        multiplier = 1.0
        for (min_nodes, max_nodes), mult in self.size_multipliers.items():
            if min_nodes <= total_nodes <= max_nodes:
                multiplier = mult
                break
        
        return int(base_burn * multiplier)
    
    def _verify_qna_activation(self, proof: Dict) -> bool:
        """
        Verify proof of QNA-era activation
        In real implementation, this would check cryptographic proofs
        """
        required_fields = ['node_id', 'node_type', 'qna_tx_hash', 'activation_timestamp']
        return all(field in proof for field in required_fields)
    
    def get_current_prices(self, total_nodes: int) -> Dict[str, int]:
        """Get current QNC burn requirements for all node types"""
        if not self.is_active:
            return {"error": "Contract not active. Still in QNA phase."}
            
        return {
            node_type.value: self._calculate_burn_requirement(node_type, total_nodes)
            for node_type in NodeType
        }
    
    def get_stats(self) -> Dict:
        """Get contract statistics"""
        if not self.is_active:
            return {"status": "inactive", "message": "Waiting for QNA->QNC transition"}
            
        node_counts = {t.value: 0 for t in NodeType}
        migrated_count = 0
        
        for node in self.activated_nodes.values():
            node_counts[node.node_type.value] += 1
            if node.migrated_from_qna:
                migrated_count += 1
                
        return {
            "status": "active",
            "transition_timestamp": self.transition_timestamp,
            "total_nodes": len(self.activated_nodes),
            "nodes_by_type": node_counts,
            "migrated_from_qna": migrated_count,
            "new_qnc_activations": len(self.activated_nodes) - migrated_count
        } 