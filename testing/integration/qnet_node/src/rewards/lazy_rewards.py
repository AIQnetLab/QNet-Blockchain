"""
Lazy rewards system for QNet nodes.
Rewards accumulate in the ledger and nodes claim when they want.
"""

import time
from typing import Dict, Optional, List
from dataclasses import dataclass
from decimal import Decimal
import json

from ..blockchain.transaction import Transaction
from ..blockchain.state import State


@dataclass
class RewardRecord:
    """Record of accumulated rewards for a node."""
    node_id: str
    amount: Decimal
    last_update: int  # timestamp
    unclaimed: Decimal
    total_earned: Decimal
    
    def to_dict(self) -> dict:
        return {
            'node_id': self.node_id,
            'amount': str(self.amount),
            'last_update': self.last_update,
            'unclaimed': str(self.unclaimed),
            'total_earned': str(self.total_earned)
        }
    
    @classmethod
    def from_dict(cls, data: dict) -> 'RewardRecord':
        return cls(
            node_id=data['node_id'],
            amount=Decimal(data['amount']),
            last_update=data['last_update'],
            unclaimed=Decimal(data['unclaimed']),
            total_earned=Decimal(data['total_earned'])
        )


class LazyRewardsManager:
    """Manages lazy reward accumulation and claims."""
    
    # State keys
    REWARDS_LEDGER_KEY = "LAZY_REWARDS_LEDGER"
    CLAIM_HISTORY_KEY = "REWARD_CLAIM_HISTORY"
    
    # No rate limiting - operators claim when convenient
    # MIN_CLAIM_INTERVAL = 0  # No time restriction
    MIN_CLAIM_AMOUNT = Decimal("1.0")  # Increased minimum to prevent spam
    
    def __init__(self, state: State):
        """Initialize rewards manager.
        
        Args:
            state: Blockchain state manager
        """
        self.state = state
        
        # Initialize ledgers if not exists
        if not self.state.get(self.REWARDS_LEDGER_KEY):
            self.state.set(self.REWARDS_LEDGER_KEY, {})
        if not self.state.get(self.CLAIM_HISTORY_KEY):
            self.state.set(self.CLAIM_HISTORY_KEY, {})
    
    def accumulate_reward(self, node_id: str, amount: Decimal, reason: str = "ping") -> None:
        """Accumulate reward for a node.
        
        Args:
            node_id: Node identifier
            amount: Reward amount
            reason: Reason for reward (ping, transaction, block)
        """
        ledger = self.state.get(self.REWARDS_LEDGER_KEY)
        
        if node_id in ledger:
            record = RewardRecord.from_dict(ledger[node_id])
            record.unclaimed += amount
            record.total_earned += amount
            record.last_update = int(time.time())
        else:
            record = RewardRecord(
                node_id=node_id,
                amount=amount,
                last_update=int(time.time()),
                unclaimed=amount,
                total_earned=amount
            )
        
        ledger[node_id] = record.to_dict()
        self.state.set(self.REWARDS_LEDGER_KEY, ledger)
    
    def can_claim(self, node_id: str) -> tuple[bool, str]:
        """Check if node can claim rewards.
        
        Args:
            node_id: Node identifier
            
        Returns:
            Tuple of (can_claim, reason)
        """
        # Check if node has rewards
        ledger = self.state.get(self.REWARDS_LEDGER_KEY)
        if node_id not in ledger:
            return False, "No rewards accumulated"
        
        record = RewardRecord.from_dict(ledger[node_id])
        
        # Check minimum amount only (no time restrictions)
        if record.unclaimed < self.MIN_CLAIM_AMOUNT:
            return False, f"Minimum claim amount is {self.MIN_CLAIM_AMOUNT} QNC"
        
        # NO RATE LIMITING - operators can claim whenever they want!
        # This allows flexible accumulation and claiming schedule
        
        return True, ""
    
    def claim_rewards(self, node_id: str, wallet_address: str) -> Optional[Transaction]:
        """Claim accumulated rewards.
        
        Args:
            node_id: Node identifier
            wallet_address: Wallet to receive rewards
            
        Returns:
            Claim transaction or None if cannot claim
        """
        can_claim, reason = self.can_claim(node_id)
        if not can_claim:
            raise ValueError(f"Cannot claim: {reason}")
        
        # Get reward amount
        ledger = self.state.get(self.REWARDS_LEDGER_KEY)
        record = RewardRecord.from_dict(ledger[node_id])
        claim_amount = record.unclaimed
        
        # Update record
        record.unclaimed = Decimal("0")
        record.last_update = int(time.time())
        ledger[node_id] = record.to_dict()
        self.state.set(self.REWARDS_LEDGER_KEY, ledger)
        
        # Record claim in history
        claim_history = self.state.get(self.CLAIM_HISTORY_KEY)
        if node_id not in claim_history:
            claim_history[node_id] = []
        
        claim_history[node_id].append({
            'amount': str(claim_amount),
            'timestamp': int(time.time()),
            'wallet': wallet_address
        })
        self.state.set(self.CLAIM_HISTORY_KEY, claim_history)
        
        # Create claim transaction (direct smart contract call - no gas fees)
        tx = Transaction(
            sender="REWARDS_POOL",
            receiver=wallet_address,
            amount=float(claim_amount),
            fee=0,  # No fee for reward claims - quantum signature only
            gas_price=0,  # No gas needed for reward claims
            gas_limit=0,  # Direct pool withdrawal
            data=json.dumps({
                'type': 'REWARD_CLAIM',
                'node_id': node_id,
                'amount': str(claim_amount)
            })
        )
        
        return tx
    
    def get_unclaimed_balance(self, node_id: str) -> Decimal:
        """Get unclaimed reward balance for a node.
        
        Args:
            node_id: Node identifier
            
        Returns:
            Unclaimed balance
        """
        ledger = self.state.get(self.REWARDS_LEDGER_KEY)
        if node_id not in ledger:
            return Decimal("0")
        
        record = RewardRecord.from_dict(ledger[node_id])
        return record.unclaimed
    
    def get_total_earned(self, node_id: str) -> Decimal:
        """Get total rewards earned by a node.
        
        Args:
            node_id: Node identifier
            
        Returns:
            Total earned amount
        """
        ledger = self.state.get(self.REWARDS_LEDGER_KEY)
        if node_id not in ledger:
            return Decimal("0")
        
        record = RewardRecord.from_dict(ledger[node_id])
        return record.total_earned
    
    def get_claim_history(self, node_id: str) -> List[dict]:
        """Get claim history for a node.
        
        Args:
            node_id: Node identifier
            
        Returns:
            List of claim records
        """
        claim_history = self.state.get(self.CLAIM_HISTORY_KEY)
        return claim_history.get(node_id, [])
    
    def distribute_ping_rewards(self, active_nodes: List[str], total_reward: Decimal) -> None:
        """Distribute ping rewards to active nodes.
        
        Args:
            active_nodes: List of active node IDs
            total_reward: Total reward to distribute
        """
        if not active_nodes:
            return
        
        # Equal distribution for ping rewards
        reward_per_node = total_reward / len(active_nodes)
        
        for node_id in active_nodes:
            self.accumulate_reward(node_id, reward_per_node, "ping")
    
    def distribute_transaction_fees(self, 
                                  node_rewards: Dict[str, Decimal],
                                  reason: str = "transaction") -> None:
        """Distribute transaction fees to nodes.
        
        Args:
            node_rewards: Dictionary of node_id -> reward amount
            reason: Reason for distribution
        """
        for node_id, amount in node_rewards.items():
            if amount > 0:
                self.accumulate_reward(node_id, amount, reason)
    
    def get_network_stats(self) -> dict:
        """Get network-wide reward statistics.
        
        Returns:
            Dictionary with stats
        """
        ledger = self.state.get(self.REWARDS_LEDGER_KEY)
        
        total_unclaimed = Decimal("0")
        total_earned = Decimal("0")
        active_nodes = 0
        
        for record_data in ledger.values():
            record = RewardRecord.from_dict(record_data)
            total_unclaimed += record.unclaimed
            total_earned += record.total_earned
            if record.unclaimed > 0:
                active_nodes += 1
        
        return {
            'total_unclaimed': str(total_unclaimed),
            'total_earned': str(total_earned),
            'active_nodes': active_nodes,
            'total_nodes': len(ledger)
        } 