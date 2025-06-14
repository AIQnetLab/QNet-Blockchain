"""
Transaction module for QNet blockchain.
Provides compatibility layer for Python code while using Rust backend.
"""

import json
import time
from enum import Enum
from typing import Optional, Dict, Any


class TransactionType(Enum):
    """Transaction types."""
    TRANSFER = "transfer"
    NODE_ACTIVATION = "node_activation"
    CONTRACT_DEPLOY = "contract_deploy"
    CONTRACT_CALL = "contract_call"
    REWARD_DISTRIBUTION = "reward_distribution"


class Transaction:
    """Transaction class with gas support."""
    
    def __init__(self,
                 sender: str,
                 receiver: Optional[str] = None,
                 amount: float = 0,
                 fee: float = 0,
                 gas_price: int = 1,
                 gas_limit: int = 21000,
                 nonce: Optional[int] = None,
                 data: Optional[str] = None,
                 transaction_type: TransactionType = TransactionType.TRANSFER):
        """Initialize transaction with gas parameters.
        
        Args:
            sender: Sender address
            receiver: Receiver address (optional for some tx types)
            amount: Amount to transfer
            fee: Transaction fee (deprecated, use gas_price * gas_limit)
            gas_price: Gas price in smallest unit
            gas_limit: Maximum gas to use
            nonce: Transaction nonce
            data: Additional transaction data
            transaction_type: Type of transaction
        """
        self.sender = sender
        self.receiver = receiver
        self.amount = amount
        self.fee = fee
        self.gas_price = gas_price
        self.gas_limit = gas_limit
        self.nonce = nonce if nonce is not None else 0
        self.timestamp = int(time.time() * 1000)  # milliseconds
        self.data = data
        self.transaction_type = transaction_type
        self.signature = None
        self.hash = None
        
    def to_dict(self) -> Dict[str, Any]:
        """Convert transaction to dictionary."""
        return {
            'sender': self.sender,
            'receiver': self.receiver,
            'amount': self.amount,
            'fee': self.fee,
            'gas_price': self.gas_price,
            'gas_limit': self.gas_limit,
            'nonce': self.nonce,
            'timestamp': self.timestamp,
            'data': self.data,
            'transaction_type': self.transaction_type.value,
            'signature': self.signature,
            'hash': self.hash
        }
    
    def to_json(self) -> str:
        """Convert transaction to JSON."""
        return json.dumps(self.to_dict())
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'Transaction':
        """Create transaction from dictionary."""
        tx_type = TransactionType(data.get('transaction_type', 'transfer'))
        tx = cls(
            sender=data['sender'],
            receiver=data.get('receiver'),
            amount=data.get('amount', 0),
            fee=data.get('fee', 0),
            gas_price=data.get('gas_price', 1),
            gas_limit=data.get('gas_limit', 21000),
            nonce=data.get('nonce', 0),
            data=data.get('data'),
            transaction_type=tx_type
        )
        tx.timestamp = data.get('timestamp', tx.timestamp)
        tx.signature = data.get('signature')
        tx.hash = data.get('hash')
        return tx
    
    def calculate_total_cost(self) -> float:
        """Calculate total cost including gas."""
        gas_cost = self.gas_price * self.gas_limit
        return self.amount + gas_cost
    
    def __repr__(self) -> str:
        """String representation."""
        return (f"Transaction(from={self.sender[:10]}..., "
                f"to={self.receiver[:10] if self.receiver else 'None'}..., "
                f"amount={self.amount}, gas_price={self.gas_price}, "
                f"gas_limit={self.gas_limit}, type={self.transaction_type.value})") 