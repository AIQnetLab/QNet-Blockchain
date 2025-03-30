#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: config.py
Stores global variables for the blockchain system.
"""

# Global blockchain instance (initialized in node.py)
blockchain = None

# Global consensus manager instance (initialized in node.py)
consensus_manager = None

# Global peers dictionary: {peer_address: last_seen_timestamp}
peers = {}

# Global reputation dictionary for peers
reputation = {}

# Global balances dictionary: {peer_address: balance}
balances = {}

# Total issued coins
total_issued = 0

# Own node address (set in node.py)
own_address = ""

# Public and secret keys (set in node.py)
public_key = None
secret_key = None

# For decentralized identity:
# Mapping from peer address to their node_id (DID)
node_info = {}
# List of eligible nodes (one per unique node_id)
eligible_nodes = []