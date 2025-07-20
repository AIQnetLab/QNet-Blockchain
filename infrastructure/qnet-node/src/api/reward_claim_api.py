#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: reward_claim_api.py
Blueprint for API endpoints related to claiming rewards.
Provides Merkle proofs for nodes directly from blockchain.
"""
from flask import Blueprint, jsonify, request
import hashlib
import json
import time
from typing import Optional, List, Dict, Any
import requests
import os

reward_bp = Blueprint('reward_claim_api', __name__)

class BlockchainRewardSystem:
    """Production blockchain-based reward system"""
    
    def __init__(self, qnet_rpc_url: str = None):
        self.qnet_rpc_url = qnet_rpc_url or os.getenv('QNET_RPC_URL', 'https://rpc.qnet.io')
        self.solana_rpc_url = os.getenv('SOLANA_RPC_URL', 'https://api.devnet.solana.com')
    
    def get_reward_proof(self, address: str, period_id: str) -> Optional[Dict[str, Any]]:
        """Get Merkle proof for reward claim from blockchain"""
        try:
            # Query QNet blockchain for reward proof
            response = requests.post(
                f"{self.qnet_rpc_url}/rpc",
                json={
                    "jsonrpc": "2.0",
                    "method": "rewards_getProof",
                    "params": {
                        "address": address,
                        "period_id": period_id
                    },
                    "id": 1
                },
                headers={'Content-Type': 'application/json'},
                timeout=30
            )
            
            if response.status_code == 200:
                data = response.json()
                if 'result' in data:
                    return data['result']
            
            return None
            
        except Exception as e:
            print(f"Error getting blockchain reward proof: {e}")
            return None
    
    def claim_reward(self, address: str, period_id: str, merkle_proof: List[str]) -> Optional[Dict[str, Any]]:
        """Claim reward through blockchain transaction"""
        try:
            # Submit claim transaction to QNet blockchain
            response = requests.post(
                f"{self.qnet_rpc_url}/rpc",
                json={
                    "jsonrpc": "2.0",
                    "method": "rewards_claim",
                    "params": {
                        "address": address,
                        "period_id": period_id,
                        "merkle_proof": merkle_proof
                    },
                    "id": 1
                },
                headers={'Content-Type': 'application/json'},
                timeout=30
            )
            
            if response.status_code == 200:
                data = response.json()
                if 'result' in data:
                    return data['result']
            
            return None
            
        except Exception as e:
            print(f"Error claiming blockchain reward: {e}")
            return None
    
    def get_reward_periods(self) -> List[Dict[str, Any]]:
        """Get available reward periods from blockchain"""
        try:
            # Query QNet blockchain for reward periods
            response = requests.post(
                f"{self.qnet_rpc_url}/rpc",
                json={
                    "jsonrpc": "2.0",
                    "method": "rewards_getPeriods",
                    "params": {},
                    "id": 1
                },
                headers={'Content-Type': 'application/json'},
                timeout=30
            )
            
            if response.status_code == 200:
                data = response.json()
                if 'result' in data:
                    return data['result']
            
            return []
            
        except Exception as e:
            print(f"Error getting reward periods: {e}")
            return []

# Global blockchain reward system instance
blockchain_rewards = BlockchainRewardSystem()

@reward_bp.route('/proof', methods=['GET'])
def get_reward_proof():
    """
    Provides the Merkle proof for a given node address and reward period.
    Requires query parameters: address, period_id
    """
    address = request.args.get('address')
    period_id = request.args.get('period_id')

    if not address or not period_id:
        return jsonify({"error": "Missing address or period_id"}), 400

    # Get real reward proof from blockchain
    proof_data = blockchain_rewards.get_reward_proof(address, period_id)
    
    if not proof_data:
        return jsonify({"error": "No reward found for this address/period"}), 404
    
    return jsonify(proof_data)

@reward_bp.route('/claim', methods=['POST'])
def claim_reward():
    """
    Claim a reward with Merkle proof verification through blockchain
    """
    data = request.get_json()
    if not data:
        return jsonify({"error": "No JSON data provided"}), 400
    
    address = data.get('address')
    period_id = data.get('period_id')
    merkle_proof = data.get('merkle_proof', [])
    
    if not address or not period_id:
        return jsonify({"error": "Missing address or period_id"}), 400
    
    # Claim reward through blockchain
    result = blockchain_rewards.claim_reward(address, period_id, merkle_proof)
    
    if result and result.get('success'):
        return jsonify({
            "success": True,
            "message": "Reward claimed successfully",
            "amount": result.get('amount'),
            "tx_hash": result.get('tx_hash')
        })
    else:
        return jsonify({
            "success": False,
            "error": result.get('error', 'Failed to claim reward')
        }), 500

@reward_bp.route('/periods', methods=['GET'])
def get_reward_periods():
    """
    Get list of available reward periods from blockchain
    """
    periods = blockchain_rewards.get_reward_periods()
    return jsonify({"periods": periods})

@reward_bp.route('/status', methods=['GET'])
def get_reward_status():
    """
    Get reward system status
    """
    return jsonify({
        "system": "blockchain",
        "decentralized": True,
        "database": "QNet blockchain",
        "rpc_url": blockchain_rewards.qnet_rpc_url,
        "status": "production"
    })