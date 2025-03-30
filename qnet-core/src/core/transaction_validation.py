#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: dynamic_consensus.py
Implements adaptive timing for consensus phases based on network conditions
with improved performance and metrics collection.
"""

import time
import logging
import threading
import math
import random
import statistics
import requests
import json
from typing import Dict, List, Tuple, Optional, Any, Union
from collections import deque

class NetworkMetrics:
    """
    Collects and analyzes network metrics to optimize consensus timing
    """
    def __init__(self, window_size: int = 20):
        """
        Initialize the network metrics tracker
        
        Args:
            window_size: Number of data points to keep for metrics calculation
        """
        self.window_size = window_size
        self.latencies: Dict[str, List[float]] = {}  # peer -> list of latencies
        self.response_rates: Dict[str, List[float]] = {}  # peer -> list of response rates (0-1)
        self.broadcast_times: List[Tuple[int, float]] = []  # (message size, time)
        
        # Use RLock for thread safety
        self.lock = threading.RLock()
        
        # Performance metrics
        self.average_latency = 1.0  # Default to 1 second until we have real data
        self.latency_std_dev = 0.2
        self.network_reliability = 1.0
        self.p90_latency = 2.0
        
        # Store percentiles for better analysis
        self.p50_latency = 1.0
        self.p95_latency = 3.0
        self.p99_latency = 5.0
        
        # Track recent network events for anomaly detection
        self.recent_network_events = deque(maxlen=100)
        
        # Last update time
        self.last_update = time.time()
        
        # Network status indicators
        self.network_status = "healthy"  # Can be "healthy", "degraded", "unstable"
        self.network_congestion = 0.0  # 0.0 (none) to 1.0 (severe)
        
        logging.info("Network metrics tracker initialized")
    
    def __init__(self, max_pool_size: int = 5000):
        """
        Initialize the transaction pool
        
        Args:
            max_pool_size: Maximum number of transactions to store in the pool
        """
        self.max_pool_size = max_pool_size
        self.transactions: List[Dict[str, Any]] = []
        self.tx_hashes: Set[str] = set()  # Set of transaction hashes for quick lookup
        
        # Lock for thread safety
        self._lock = threading.RLock()
        
        logging.info(f"Transaction pool initialized with max size {max_pool_size}")
        
    def add_transaction(self, tx: Dict[str, Any], balances: Dict[str, float]) -> Tuple[bool, str]:
        """
        Add a transaction to the pool
        
        Args:
            tx: Transaction to add
            balances: Current balances for validation
            
        Returns:
            Tuple of (success, message)
        """
        with self._lock:
            # Check if pool is full
            if len(self.transactions) >= self.max_pool_size:
                return False, "Transaction pool is full"
            
            # Validate the transaction
            is_valid, reason = validate_transaction(tx, balances)
            if not is_valid:
                return False, reason
            
            # Check if transaction is already in the pool
            tx_hash = compute_transaction_hash(tx)
            if tx_hash in self.tx_hashes:
                return False, "Transaction already in pool"
            
            # Add to pool
            self.transactions.append(tx)
            self.tx_hashes.add(tx_hash)
            
            # Sort transactions by fee (highest fee first)
            self.sort_by_fee()
            
            return True, "Transaction added to pool"
    
    def remove_transaction(self, tx_hash: str) -> bool:
        """
        Remove a transaction from the pool
        
        Args:
            tx_hash: Hash of the transaction to remove
            
        Returns:
            True if transaction was removed, False if not found
        """
        with self._lock:
            if tx_hash not in self.tx_hashes:
                return False
                
            # Find and remove the transaction
            for i, tx in enumerate(self.transactions):
                if compute_transaction_hash(tx) == tx_hash:
                    self.transactions.pop(i)
                    self.tx_hashes.remove(tx_hash)
                    return True
            
            # Should never reach here if tx_hashes is in sync
            logging.error(f"Inconsistency in transaction pool: {tx_hash} in hashes but not in transactions")
            self.tx_hashes.remove(tx_hash)
            return False
    
    def get_transactions(self, limit: int = None) -> List[Dict[str, Any]]:
        """
        Get transactions from the pool
        
        Args:
            limit: Maximum number of transactions to return (None for all)
            
        Returns:
            List of transactions
        """
        with self._lock:
            if limit is None or limit >= len(self.transactions):
                return self.transactions.copy()
            return self.transactions[:limit]
    
    def clear(self) -> None:
        """
        Clear all transactions from the pool
        """
        with self._lock:
            self.transactions.clear()
            self.tx_hashes.clear()
    
    def sort_by_fee(self) -> None:
        """
        Sort transactions by fee (highest fee first)
        """
        with self._lock:
            self.transactions.sort(key=lambda tx: get_transaction_fee(tx), reverse=True)
    
    def remove_confirmed_transactions(self, confirmed_txs: List[Dict[str, Any]]) -> int:
        """
        Remove transactions that have been confirmed in a block
        
        Args:
            confirmed_txs: List of confirmed transactions
            
        Returns:
            Number of transactions removed
        """
        with self._lock:
            # Calculate hashes for confirmed transactions
            confirmed_hashes = {compute_transaction_hash(tx) for tx in confirmed_txs}
            
            # Remove transactions that are in confirmed_hashes
            removed_count = 0
            i = 0
            while i < len(self.transactions):
                tx_hash = compute_transaction_hash(self.transactions[i])
                if tx_hash in confirmed_hashes:
                    self.transactions.pop(i)
                    self.tx_hashes.remove(tx_hash)
                    removed_count += 1
                else:
                    i += 1
                    
            return removed_count
    
    def validate_all(self, balances: Dict[str, float]) -> Tuple[List[Dict[str, Any]], List[str]]:
        """
        Validate all transactions in the pool and remove invalid ones
        
        Args:
            balances: Current balances for validation
            
        Returns:
            Tuple of (valid transactions, removed transaction hashes)
        """
        with self._lock:
            valid_txs = []
            removed_hashes = []
            
            # Check each transaction
            i = 0
            while i < len(self.transactions):
                tx = self.transactions[i]
                is_valid, _ = validate_transaction(tx, balances)
                
                if is_valid:
                    valid_txs.append(tx)
                    # Update balances to reflect this transaction
                    if tx["sender"] != "network":  # Skip for coinbase
                        balances[tx["sender"]] = balances.get(tx["sender"], 0) - float(tx["amount"])
                    balances[tx["recipient"]] = balances.get(tx["recipient"], 0) + float(tx["amount"])
                    i += 1
                else:
                    # Remove invalid transaction
                    tx_hash = compute_transaction_hash(tx)
                    self.transactions.pop(i)
                    self.tx_hashes.remove(tx_hash)
                    removed_hashes.append(tx_hash)
            
            return valid_txs, removed_hashes
    
    def size(self) -> int:
        """
        Get the number of transactions in the pool
        
        Returns:
            Number of transactions
        """
        with self._lock:
            return len(self.transactions)
    
    def contains(self, tx_hash: str) -> bool:
        """
        Check if the pool contains a transaction
        
        Args:
            tx_hash: Transaction hash to check
            
        Returns:
            True if transaction is in the pool, False otherwise
        """
        with self._lock:
            return tx_hash in self.tx_hashes