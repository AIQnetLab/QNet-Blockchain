"""
Transaction sharding for QNet.
Distributes transactions across 10,000 shards based on node capabilities.
"""

import hashlib
from typing import List, Set, Optional, Dict
from dataclasses import dataclass
from enum import Enum

from ..blockchain.transaction import Transaction
from ..activation.blockchain_verifier import NodeType


class ShardAssignment:
    """Manages shard assignments for nodes."""
    
    TOTAL_SHARDS = 10000
    
    # Shard visibility by node type
    SHARDS_PER_NODE = {
        NodeType.LIGHT: 0,    # No transaction processing
        NodeType.FULL: 1,     # See 1 shard
        NodeType.SUPER: 3,    # See 3 shards
    }
    
    @staticmethod
    def get_transaction_shard(tx: Transaction) -> int:
        """Determine which shard a transaction belongs to.
        
        Args:
            tx: Transaction to shard
            
        Returns:
            Shard number (0 to 9999)
        """
        # Use transaction hash to determine shard
        tx_hash = tx.calculate_hash()
        shard_bytes = hashlib.sha256(tx_hash.encode()).digest()
        
        # Convert first 4 bytes to integer and mod by total shards
        shard_num = int.from_bytes(shard_bytes[:4], 'big') % ShardAssignment.TOTAL_SHARDS
        return shard_num
    
    @staticmethod
    def get_node_shards(node_id: str, node_type: NodeType) -> Set[int]:
        """Get shards assigned to a node.
        
        Args:
            node_id: Node identifier
            node_type: Type of node
            
        Returns:
            Set of shard numbers this node handles
        """
        num_shards = ShardAssignment.SHARDS_PER_NODE.get(node_type, 0)
        if num_shards == 0:
            return set()
        
        # Deterministically assign shards based on node ID
        node_hash = hashlib.sha256(node_id.encode()).digest()
        base_shard = int.from_bytes(node_hash[:4], 'big') % ShardAssignment.TOTAL_SHARDS
        
        shards = set()
        for i in range(num_shards):
            # Spread shards evenly across the space
            shard = (base_shard + i * (ShardAssignment.TOTAL_SHARDS // num_shards)) % ShardAssignment.TOTAL_SHARDS
            shards.add(shard)
        
        return shards
    
    @staticmethod
    def should_process_transaction(tx: Transaction, node_id: str, node_type: NodeType) -> bool:
        """Check if a node should process a transaction.
        
        Args:
            tx: Transaction to check
            node_id: Node identifier
            node_type: Type of node
            
        Returns:
            True if node should process this transaction
        """
        if node_type == NodeType.LIGHT:
            return False
        
        tx_shard = ShardAssignment.get_transaction_shard(tx)
        node_shards = ShardAssignment.get_node_shards(node_id, node_type)
        
        return tx_shard in node_shards


@dataclass
class ShardStats:
    """Statistics for a shard."""
    shard_id: int
    transaction_count: int
    total_volume: float
    active_nodes: Set[str]
    last_update: int


class TransactionRouter:
    """Routes transactions to appropriate nodes based on sharding."""
    
    def __init__(self):
        self.shard_stats: Dict[int, ShardStats] = {}
        self.node_assignments: Dict[str, Set[int]] = {}
    
    def register_node(self, node_id: str, node_type: NodeType) -> None:
        """Register a node and its shard assignments.
        
        Args:
            node_id: Node identifier
            node_type: Type of node
        """
        shards = ShardAssignment.get_node_shards(node_id, node_type)
        self.node_assignments[node_id] = shards
        
        # Update shard stats
        for shard_id in shards:
            if shard_id not in self.shard_stats:
                self.shard_stats[shard_id] = ShardStats(
                    shard_id=shard_id,
                    transaction_count=0,
                    total_volume=0.0,
                    active_nodes=set(),
                    last_update=0
                )
            self.shard_stats[shard_id].active_nodes.add(node_id)
    
    def unregister_node(self, node_id: str) -> None:
        """Unregister a node.
        
        Args:
            node_id: Node identifier
        """
        if node_id in self.node_assignments:
            shards = self.node_assignments[node_id]
            del self.node_assignments[node_id]
            
            # Update shard stats
            for shard_id in shards:
                if shard_id in self.shard_stats:
                    self.shard_stats[shard_id].active_nodes.discard(node_id)
    
    def get_nodes_for_transaction(self, tx: Transaction) -> List[str]:
        """Get nodes that should process a transaction.
        
        Args:
            tx: Transaction to route
            
        Returns:
            List of node IDs that should process this transaction
        """
        shard_id = ShardAssignment.get_transaction_shard(tx)
        
        nodes = []
        for node_id, shards in self.node_assignments.items():
            if shard_id in shards:
                nodes.append(node_id)
        
        return nodes
    
    def get_shard_load_balance(self) -> Dict[int, float]:
        """Get load balance across shards.
        
        Returns:
            Dictionary of shard_id -> load factor (0.0 to 1.0)
        """
        if not self.shard_stats:
            return {}
        
        max_count = max(stats.transaction_count for stats in self.shard_stats.values())
        if max_count == 0:
            return {shard_id: 0.0 for shard_id in self.shard_stats}
        
        return {
            shard_id: stats.transaction_count / max_count
            for shard_id, stats in self.shard_stats.items()
        }
    
    def get_node_load(self, node_id: str) -> Dict[str, any]:
        """Get load statistics for a node.
        
        Args:
            node_id: Node identifier
            
        Returns:
            Load statistics
        """
        if node_id not in self.node_assignments:
            return {
                'shards': [],
                'total_transactions': 0,
                'total_volume': 0.0
            }
        
        shards = self.node_assignments[node_id]
        total_transactions = 0
        total_volume = 0.0
        
        for shard_id in shards:
            if shard_id in self.shard_stats:
                stats = self.shard_stats[shard_id]
                total_transactions += stats.transaction_count
                total_volume += stats.total_volume
        
        return {
            'shards': list(shards),
            'total_transactions': total_transactions,
            'total_volume': total_volume
        }


class ShardedMempool:
    """Mempool that only stores transactions for assigned shards."""
    
    def __init__(self, node_id: str, node_type: NodeType):
        self.node_id = node_id
        self.node_type = node_type
        self.assigned_shards = ShardAssignment.get_node_shards(node_id, node_type)
        self.transactions: Dict[str, Transaction] = {}
        self.transactions_by_shard: Dict[int, Set[str]] = {
            shard: set() for shard in self.assigned_shards
        }
    
    def add_transaction(self, tx: Transaction) -> bool:
        """Add transaction if it belongs to our shards.
        
        Args:
            tx: Transaction to add
            
        Returns:
            True if added, False if not our shard
        """
        if not ShardAssignment.should_process_transaction(tx, self.node_id, self.node_type):
            return False
        
        tx_hash = tx.calculate_hash()
        if tx_hash in self.transactions:
            return False  # Already have it
        
        shard_id = ShardAssignment.get_transaction_shard(tx)
        self.transactions[tx_hash] = tx
        self.transactions_by_shard[shard_id].add(tx_hash)
        
        return True
    
    def remove_transaction(self, tx_hash: str) -> bool:
        """Remove transaction from mempool.
        
        Args:
            tx_hash: Transaction hash
            
        Returns:
            True if removed, False if not found
        """
        if tx_hash not in self.transactions:
            return False
        
        tx = self.transactions[tx_hash]
        shard_id = ShardAssignment.get_transaction_shard(tx)
        
        del self.transactions[tx_hash]
        self.transactions_by_shard[shard_id].discard(tx_hash)
        
        return True
    
    def get_transactions_for_block(self, max_count: int = 100) -> List[Transaction]:
        """Get transactions for block creation.
        
        Args:
            max_count: Maximum transactions to return
            
        Returns:
            List of transactions
        """
        transactions = []
        
        # Get transactions from each shard proportionally
        txs_per_shard = max(1, max_count // len(self.assigned_shards)) if self.assigned_shards else 0
        
        for shard_id in self.assigned_shards:
            shard_txs = list(self.transactions_by_shard[shard_id])[:txs_per_shard]
            for tx_hash in shard_txs:
                if tx_hash in self.transactions:
                    transactions.append(self.transactions[tx_hash])
                    if len(transactions) >= max_count:
                        return transactions
        
        return transactions
    
    def size(self) -> int:
        """Get total number of transactions in mempool."""
        return len(self.transactions)
    
    def size_by_shard(self) -> Dict[int, int]:
        """Get transaction count by shard."""
        return {
            shard_id: len(tx_hashes)
            for shard_id, tx_hashes in self.transactions_by_shard.items()
        } 