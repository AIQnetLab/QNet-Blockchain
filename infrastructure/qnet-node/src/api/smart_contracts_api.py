#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Smart Contracts API for QNet Node
Handles contract deployment, execution, and queries
"""

import os
import json
import time
import logging
import hashlib
from flask import Blueprint, request, jsonify
from typing import Dict, Any, Optional, List

# Setup logger
logger = logging.getLogger(__name__)

# Try to import QNet VM components
try:
    from qnet_vm import QNetVM, ContractValidator, GasCalculator
    VM_AVAILABLE = True
except ImportError:
    VM_AVAILABLE = False
    logger.warning("QNet VM not available. Smart contract functionality limited.")
    
    # Mock classes for development
    class QNetVM:
        def deploy_contract(self, *args, **kwargs):
            return {"address": "0x" + hashlib.sha256(str(time.time()).encode()).hexdigest()[:40]}
        
        def execute_contract(self, *args, **kwargs):
            return {"result": "mock_result", "gas_used": 1000}
    
    class ContractValidator:
        @staticmethod
        def validate_wasm(code):
            return True, "Mock validation passed"
    
    class GasCalculator:
        @staticmethod
        def estimate_gas(operation, size=0):
            return 10000 + size

# Create blueprint
smart_contracts_bp = Blueprint('smart_contracts', __name__)

# Initialize VM instance
vm = QNetVM() if VM_AVAILABLE else QNetVM()

@smart_contracts_bp.route('/health', methods=['GET'])
def health():
    """Health check for smart contracts API"""
    return jsonify({
        "status": "healthy",
        "vm_available": VM_AVAILABLE,
        "message": "Smart Contracts API is running"
    })

@smart_contracts_bp.route('/deploy', methods=['POST'])
def deploy_contract():
    """Deploy a new smart contract"""
    try:
        data = request.get_json()
        
        # Validate required fields
        required_fields = ['code', 'constructor_args']
        for field in required_fields:
            if field not in data:
                return jsonify({"error": f"Missing required field: {field}"}), 400
        
        # Get contract code (base64 encoded WASM)
        try:
            import base64
            wasm_code = base64.b64decode(data['code'])
        except Exception as e:
            return jsonify({"error": f"Invalid contract code: {e}"}), 400
        
        # Validate WASM code
        is_valid, validation_msg = ContractValidator.validate_wasm(wasm_code)
        if not is_valid:
            return jsonify({"error": f"Contract validation failed: {validation_msg}"}), 400
        
        # Estimate gas
        gas_limit = data.get('gas_limit', 0)
        if gas_limit == 0:
            gas_limit = GasCalculator.estimate_gas('deploy', len(wasm_code))
        
        # Deploy contract
        result = vm.deploy_contract(
            code=wasm_code,
            constructor_args=data['constructor_args'],
            gas_limit=gas_limit,
            sender=data.get('sender', 'unknown')
        )
        
        return jsonify({
            "success": True,
            "contract_address": result['address'],
            "gas_used": result.get('gas_used', gas_limit),
            "transaction_hash": hashlib.sha256(wasm_code).hexdigest()
        })
        
    except Exception as e:
        logger.error(f"Error deploying contract: {e}")
        return jsonify({"error": str(e)}), 500

@smart_contracts_bp.route('/call', methods=['POST'])
def call_contract():
    """Call a smart contract method"""
    try:
        data = request.get_json()
        
        # Validate required fields
        required_fields = ['contract_address', 'method', 'args']
        for field in required_fields:
            if field not in data:
                return jsonify({"error": f"Missing required field: {field}"}), 400
        
        # Estimate gas if not provided
        gas_limit = data.get('gas_limit', 0)
        if gas_limit == 0:
            gas_limit = GasCalculator.estimate_gas('call')
        
        # Execute contract method
        result = vm.execute_contract(
            address=data['contract_address'],
            method=data['method'],
            args=data['args'],
            gas_limit=gas_limit,
            sender=data.get('sender', 'unknown')
        )
        
        return jsonify({
            "success": True,
            "result": result['result'],
            "gas_used": result['gas_used'],
            "events": result.get('events', [])
        })
        
    except Exception as e:
        logger.error(f"Error calling contract: {e}")
        return jsonify({"error": str(e)}), 500

@smart_contracts_bp.route('/view', methods=['POST'])
def view_contract():
    """Call a view (read-only) contract method"""
    try:
        data = request.get_json()
        
        # Validate required fields
        required_fields = ['contract_address', 'method', 'args']
        for field in required_fields:
            if field not in data:
                return jsonify({"error": f"Missing required field: {field}"}), 400
        
        # View methods don't consume gas
        result = vm.execute_contract(
            address=data['contract_address'],
            method=data['method'],
            args=data['args'],
            gas_limit=0,  # No gas for view methods
            is_view=True
        )
        
        return jsonify({
            "success": True,
            "result": result['result']
        })
        
    except Exception as e:
        logger.error(f"Error viewing contract: {e}")
        return jsonify({"error": str(e)}), 500

@smart_contracts_bp.route('/estimate_gas', methods=['POST'])
def estimate_gas():
    """Estimate gas for a contract operation"""
    try:
        data = request.get_json()
        operation = data.get('operation', 'call')
        
        if operation == 'deploy':
            code_size = data.get('code_size', 0)
            estimated_gas = GasCalculator.estimate_gas('deploy', code_size)
        else:
            estimated_gas = GasCalculator.estimate_gas(operation)
        
        return jsonify({
            "success": True,
            "estimated_gas": estimated_gas,
            "gas_price": 0.0001  # QNC per gas unit
        })
        
    except Exception as e:
        logger.error(f"Error estimating gas: {e}")
        return jsonify({"error": str(e)}), 500

@smart_contracts_bp.route('/contract/<address>', methods=['GET'])
def get_contract_info(address):
    """Get information about a deployed contract"""
    try:
        # In a real implementation, this would query the blockchain
        # For now, return mock data
        contract_info = {
            "address": address,
            "creator": "0x" + "a" * 40,
            "creation_time": int(time.time()) - 3600,
            "code_hash": hashlib.sha256(address.encode()).hexdigest(),
            "balance": 0,
            "transaction_count": 42
        }
        
        return jsonify({
            "success": True,
            "contract": contract_info
        })
        
    except Exception as e:
        logger.error(f"Error getting contract info: {e}")
        return jsonify({"error": str(e)}), 500

@smart_contracts_bp.route('/events', methods=['POST'])
def get_contract_events():
    """Get events emitted by a contract"""
    try:
        data = request.get_json()
        contract_address = data.get('contract_address')
        from_block = data.get('from_block', 0)
        to_block = data.get('to_block', 'latest')
        event_type = data.get('event_type')
        
        # Mock events for development
        events = [
            {
                "block_number": from_block + 1,
                "transaction_hash": "0x" + hashlib.sha256(f"tx1".encode()).hexdigest(),
                "event_type": "Transfer",
                "data": {
                    "from": "0x" + "a" * 40,
                    "to": "0x" + "b" * 40,
                    "amount": 1000
                }
            },
            {
                "block_number": from_block + 2,
                "transaction_hash": "0x" + hashlib.sha256(f"tx2".encode()).hexdigest(),
                "event_type": "Approval",
                "data": {
                    "owner": "0x" + "a" * 40,
                    "spender": "0x" + "c" * 40,
                    "amount": 500
                }
            }
        ]
        
        # Filter by event type if specified
        if event_type:
            events = [e for e in events if e['event_type'] == event_type]
        
        return jsonify({
            "success": True,
            "events": events
        })
        
    except Exception as e:
        logger.error(f"Error getting contract events: {e}")
        return jsonify({"error": str(e)}), 500

@smart_contracts_bp.route('/compile', methods=['POST'])
def compile_contract():
    """Compile contract source code to WASM"""
    try:
        data = request.get_json()
        source_code = data.get('source_code')
        language = data.get('language', 'rust')
        
        if not source_code:
            return jsonify({"error": "Missing source code"}), 400
        
        # In a real implementation, this would call the appropriate compiler
        # For now, return mock compiled code
        import base64
        mock_wasm = b"mock_wasm_code_" + source_code.encode()[:100]
        
        return jsonify({
            "success": True,
            "wasm": base64.b64encode(mock_wasm).decode(),
            "abi": {
                "methods": [
                    {"name": "transfer", "inputs": ["address", "uint256"], "outputs": ["bool"]},
                    {"name": "balanceOf", "inputs": ["address"], "outputs": ["uint256"]}
                ]
            },
            "warnings": []
        })
        
    except Exception as e:
        logger.error(f"Error compiling contract: {e}")
        return jsonify({"error": str(e)}), 500

@smart_contracts_bp.route('/templates', methods=['GET'])
def get_contract_templates():
    """Get available contract templates"""
    templates = [
        {
            "id": "token",
            "name": "QRC-20 Token",
            "description": "Standard fungible token contract",
            "language": "rust",
            "category": "tokens"
        },
        {
            "id": "nft",
            "name": "QRC-721 NFT",
            "description": "Non-fungible token contract",
            "language": "rust",
            "category": "nfts"
        },
        {
            "id": "multisig",
            "name": "Multi-Signature Wallet",
            "description": "Wallet requiring multiple signatures",
            "language": "rust",
            "category": "wallets"
        },
        {
            "id": "dex",
            "name": "DEX Pair",
            "description": "Decentralized exchange pair contract",
            "language": "rust",
            "category": "defi"
        }
    ]
    
    return jsonify({
        "success": True,
        "templates": templates
    })

@smart_contracts_bp.route('/template/<template_id>', methods=['GET'])
def get_contract_template(template_id):
    """Get source code for a specific template"""
    templates = {
        "token": """
use qnet_sdk::prelude::*;

#[qnet_contract]
pub struct Token {
    name: String,
    symbol: String,
    total_supply: u64,
    balances: HashMap<Address, u64>,
}

#[qnet_methods]
impl Token {
    #[init]
    pub fn new(name: String, symbol: String, initial_supply: u64) -> Self {
        let mut balances = HashMap::new();
        balances.insert(env::sender(), initial_supply);
        
        Self {
            name,
            symbol,
            total_supply: initial_supply,
            balances,
        }
    }
    
    pub fn transfer(&mut self, to: Address, amount: u64) -> Result<bool> {
        let sender = env::sender();
        let sender_balance = self.balances.get(&sender).unwrap_or(&0);
        
        require!(*sender_balance >= amount, "Insufficient balance");
        
        self.balances.insert(sender, sender_balance - amount);
        let to_balance = self.balances.get(&to).unwrap_or(&0);
        self.balances.insert(to, to_balance + amount);
        
        emit!(Transfer { from: sender, to, amount });
        
        Ok(true)
    }
    
    #[view]
    pub fn balance_of(&self, account: Address) -> u64 {
        *self.balances.get(&account).unwrap_or(&0)
    }
}
""",
        "nft": "// NFT template code here",
        "multisig": "// Multisig template code here",
        "dex": "// DEX template code here"
    }
    
    if template_id not in templates:
        return jsonify({"error": "Template not found"}), 404
    
    return jsonify({
        "success": True,
        "template_id": template_id,
        "source_code": templates[template_id]
    })

# Error handler for the blueprint
@smart_contracts_bp.errorhandler(Exception)
def handle_error(error):
    logger.error(f"Unhandled error in smart contracts API: {error}")
    return jsonify({"error": "Internal server error"}), 500 