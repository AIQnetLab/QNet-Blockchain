# File: QNet-Project/qnet-node/src/api/reward_claim_api.py
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: reward_claim_api.py
Blueprint for API endpoints related to claiming rewards.
Provides Merkle proofs for nodes.
"""
from flask import Blueprint, jsonify, request

reward_bp = Blueprint('reward_claim_api', __name__)

@reward_bp.route('/proof', methods=['GET'])
def get_reward_proof():
    """
    Provides the Merkle proof for a given node address and reward period.
    Requires query parameters: address, period_id
    """
    address = request.args.get('address')
    period_id = request.args.get('period_id') # e.g., date YYYY-MM-DD

    if not address or not period_id:
        return jsonify({"error": "Missing address or period_id"}), 400

    # TODO: Implement logic to:
    # 1. Load or find the Merkle tree for the given period_id.
    # 2. Find the leaf corresponding to the address.
    # 3. Generate and return the Merkle proof path and the claimed amount.

    # Mock response
    mock_proof = {
        "address": address,
        "period_id": period_id,
        "amount": 10.5, # Example amount
        "merkle_root": "example_root_hash_for_" + period_id,
        "proof": ["hash1", "hash2", "hash3"] # Example proof path
    }
    return jsonify(mock_proof)

@reward_bp.route('/current_root', methods=['GET'])
def get_current_reward_root():
     """Provides the Merkle root for the latest reward period."""
     # TODO: Implement logic to get the latest published root
     return jsonify({"period_id": "2025-05-08", "merkle_root": "latest_example_root_hash"})