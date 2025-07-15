#!/usr/bin/env python3
"""
QNet API Server with Rust Backend
Production-ready API server using high-performance Rust modules.
"""

import os
import sys
import json
import asyncio
import logging
import time
from typing import Dict, Any, Optional, List
from datetime import datetime
from contextlib import asynccontextmanager

# FastAPI and dependencies
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Depends, status, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, validator
import uvicorn

# Rust modules
try:
    import qnet_state
    import qnet_mempool
    import qnet_consensus
except ImportError as e:
    print(f"Error: Rust modules not found. Please build them first: {e}")
    sys.exit(1)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# --- Pydantic Models ---

class TransactionRequest(BaseModel):
    """Transaction submission request."""
    from_address: str = Field(..., description="Sender address")
    to_address: str = Field(..., description="Recipient address")
    amount: float = Field(..., gt=0, description="Amount to transfer")
    gas_price: Optional[int] = Field(None, ge=1, description="Gas price in Gwei")
    gas_limit: Optional[int] = Field(None, ge=10000, description="Gas limit")
    memo: Optional[str] = Field(None, max_length=256, description="Transaction memo")
    
    @validator('from_address', 'to_address')
    def validate_address(cls, v):
        if not v or len(v) < 10:
            raise ValueError('Invalid address format')
        return v

class NodeActivationRequest(BaseModel):
    """Node activation request."""
    wallet_address: str = Field(..., description="Wallet address")
    node_type: str = Field(..., pattern="^(light|full|super)$", description="Node type")
    burn_tx_hash: str = Field(..., description="Burn transaction hash")
    signature: str = Field(..., description="Activation signature")

class GasEstimateRequest(BaseModel):
    """Gas estimation request."""
    from_address: str
    to_address: str
    amount: float
    data: Optional[str] = None

# --- API State Manager ---

class APIState:
    """Manages API server state with Rust backend."""
    
    def __init__(self, data_dir: str = "./data"):
        self.data_dir = data_dir
        self.state_db = None
        self.mempool = None
        self.consensus = None
        self.websocket_connections: List[WebSocket] = []
        
    async def initialize(self):
        """Initialize Rust modules."""
        try:
            # Initialize StateDB
            state_path = os.path.join(self.data_dir, "state")
            os.makedirs(state_path, exist_ok=True)
            self.state_db = qnet_state.PyStateDB(state_path, cache_size=10000)
            logger.info(f"StateDB initialized at {state_path}")
            
            # Initialize Mempool
            mempool_config = qnet_mempool.MempoolConfig(
                max_size=50000,
                min_gas_price=1
            )
            self.mempool = qnet_mempool.Mempool(mempool_config, state_path)
            logger.info("Mempool initialized")
            
            # Initialize Consensus
            consensus_config = qnet_consensus.PyConsensusConfig(
                commit_duration_ms=60000,
                reveal_duration_ms=30000,
                reputation_threshold=50.0
            )
            self.consensus = qnet_consensus.PyConsensus(consensus_config)
            logger.info("Consensus initialized")
            
        except Exception as e:
            logger.error(f"Failed to initialize API state: {e}")
            raise
    
    async def cleanup(self):
        """Cleanup resources."""
        # Close WebSocket connections
        for ws in self.websocket_connections:
            await ws.close()
        self.websocket_connections.clear()
        
        logger.info("API state cleaned up")

# --- Global State ---
api_state = APIState()

# --- Lifespan Manager ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application lifecycle."""
    # Startup
    logger.info("Starting QNet API Server...")
    await api_state.initialize()
    logger.info("API Server started successfully")
    
    yield
    
    # Shutdown
    logger.info("Shutting down API Server...")
    await api_state.cleanup()
    logger.info("API Server shut down")

# --- FastAPI App ---
app = FastAPI(
    title="QNet Blockchain API",
    description="Production-ready API for QNet blockchain with Rust backend",
    version="2.0.0",
    lifespan=lifespan
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Configure for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Health & Status Endpoints ---

@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "timestamp": datetime.utcnow().isoformat(),
        "version": "2.0.0"
    }

@app.get("/api/v1/status")
async def get_status():
    """Get node status."""
    try:
        latest_block = api_state.state_db.get_latest_block()
        mempool_size = api_state.mempool.size()
        
        return {
            "network": "qnet-mainnet",
            "latest_block": {
                "height": latest_block.height if latest_block else 0,
                "hash": latest_block.hash() if latest_block else None,
                "timestamp": latest_block.timestamp if latest_block else None
            },
            "mempool_size": mempool_size,
            "node_version": "2.0.0",
            "rust_backend": True
        }
    except Exception as e:
        logger.error(f"Error getting status: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# --- Account Endpoints ---

@app.get("/api/v1/balance/{address}")
async def get_balance(address: str):
    """Get account balance."""
    try:
        balance = api_state.state_db.get_balance(address)
        account = api_state.state_db.get_account(address)
        
        return {
            "address": address,
            "balance": balance,
            "nonce": account.nonce if account else 0,
            "is_node": account.is_node if account else False,
            "node_type": account.node_type if account else None
        }
    except Exception as e:
        logger.error(f"Error getting balance for {address}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/v1/nonce/{address}")
async def get_nonce(address: str):
    """Get account nonce."""
    try:
        account = api_state.state_db.get_account(address)
        return {
            "address": address,
            "nonce": account.nonce if account else 0
        }
    except Exception as e:
        logger.error(f"Error getting nonce for {address}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# --- Transaction Endpoints ---

@app.post("/api/v1/transaction")
async def submit_transaction(tx_request: TransactionRequest):
    """Submit a new transaction."""
    try:
        # Create transaction
        tx = qnet_state.PyTransaction.transfer(
            tx_request.from_address,
            tx_request.to_address,
            int(tx_request.amount * 1e9),  # Convert to smallest unit
            0,  # Nonce will be set by mempool
            tx_request.gas_price or 10,
            tx_request.gas_limit or 10000
        )
        
        # Add to mempool
        tx_json = json.dumps({
            "from": tx_request.from_address,
            "to": tx_request.to_address,
            "amount": tx_request.amount,
            "gas_price": tx_request.gas_price or 10,
            "gas_limit": tx_request.gas_limit or 10000,
            "memo": tx_request.memo
        })
        
        tx_hash = api_state.mempool.add_transaction(tx_json)
        
        # Broadcast to WebSocket clients
        await broadcast_transaction(tx_hash, tx_request.dict())
        
        return {
            "success": True,
            "tx_hash": tx_hash,
            "message": "Transaction submitted successfully"
        }
        
    except Exception as e:
        logger.error(f"Error submitting transaction: {e}")
        raise HTTPException(status_code=400, detail=str(e))

@app.get("/api/v1/transaction/{tx_hash}")
async def get_transaction(tx_hash: str):
    """Get transaction by hash."""
    try:
        # Check mempool first
        tx_json = api_state.mempool.get_transaction(tx_hash)
        if tx_json:
            return {
                "status": "pending",
                "transaction": json.loads(tx_json)
            }
        
        # Check blockchain
        # TODO: Implement transaction lookup in state
        
        raise HTTPException(status_code=404, detail="Transaction not found")
        
    except Exception as e:
        logger.error(f"Error getting transaction {tx_hash}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/v1/transactions/{address}")
async def get_transactions(address: str, limit: int = 20, offset: int = 0):
    """Get transactions for an address."""
    try:
        # Get pending transactions from mempool
        pending = api_state.mempool.get_pending_transactions(100)
        
        # Filter by address
        address_txs = []
        for tx_json in pending:
            tx = json.loads(tx_json)
            if tx.get('from') == address or tx.get('to') == address:
                address_txs.append({
                    "hash": tx.get('hash', 'pending'),
                    "status": "pending",
                    **tx
                })
        
        return {
            "address": address,
            "transactions": address_txs[offset:offset+limit],
            "total": len(address_txs),
            "limit": limit,
            "offset": offset
        }
        
    except Exception as e:
        logger.error(f"Error getting transactions for {address}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# --- Gas Endpoints ---

@app.get("/api/v1/gas-price")
async def get_gas_price():
    """Get current gas price recommendations."""
    try:
        # Get mempool stats
        mempool_size = api_state.mempool.size()
        
        # Calculate gas prices based on congestion
        base_price = 10
        if mempool_size > 10000:
            base_price = 20
        elif mempool_size > 5000:
            base_price = 15
        
        return {
            "gasPrice": base_price,
            "slow": int(base_price * 0.8),
            "standard": base_price,
            "fast": int(base_price * 1.5),
            "instant": int(base_price * 2),
            "mempool_size": mempool_size
        }
        
    except Exception as e:
        logger.error(f"Error getting gas price: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/v1/estimate-gas")
async def estimate_gas(request: GasEstimateRequest):
    """Estimate gas for a transaction."""
    try:
        # Basic estimation logic
        gas_limit = 10000  # QNet optimized transfer cost
        
        if request.data:
            # Add gas for data
            gas_limit += len(request.data) * 68  # 68 gas per byte
        
        return {
            "gasLimit": gas_limit,
            "gasPrice": 10,  # Current gas price
            "totalCost": gas_limit * 10 / 1e9  # In QNC
        }
        
    except Exception as e:
        logger.error(f"Error estimating gas: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# --- Node Endpoints ---

@app.post("/api/v1/node/activate")
async def activate_node(request: NodeActivationRequest):
    """Activate a new node."""
    try:
        # Create node activation transaction
        tx = qnet_state.PyTransaction.node_activation(
            request.wallet_address,
            request.node_type,
            1000000,  # Burn amount based on node type
            0,  # Nonce
            1,  # Minimal gas price
            50000  # Higher gas limit for activation
        )
        
        # Execute activation
        result = api_state.state_db.execute_transaction(tx)
        
        return {
            "success": True,
            "node_id": f"qnode-{request.wallet_address[:8]}",
            "message": f"{request.node_type} node activated successfully"
        }
        
    except Exception as e:
        logger.error(f"Error activating node: {e}")
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/api/rewards/claim")
async def claim_rewards(request: Request):
    """Claim accumulated rewards (manual by operator)."""
    try:
        data = await request.json()
        node_id = data.get('node_id')
        wallet_address = data.get('wallet_address') 
        
        if not node_id or not wallet_address:
            raise HTTPException(status_code=400, detail="Missing node_id or wallet_address")
        
        # TODO: In production, integrate with LazyRewardsManager
        # For now, simulate successful claim
        
        # Mock response
        claimed_amount = 24.51  # Example amount from rewards pool
        tx_hash = f"claim_{node_id}_{int(time.time())}"
        
        logger.info(f"Rewards claimed manually by operator: {claimed_amount} QNC for node {node_id}")
        
        return {
            "success": True,
            "claimed": claimed_amount,
            "tx_hash": tx_hash,
            "node_id": node_id,
            "wallet_address": wallet_address,
            "claim_time": int(time.time())
        }
        
    except Exception as e:
        logger.error(f"Error claiming rewards: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/rewards/{node_id}")
async def get_node_rewards(node_id: str):
    """Get node rewards status."""
    try:
        # TODO: In production, query LazyRewardsManager
        # For now, return mock data
        
        # Simulate accumulated rewards
        unclaimed = 147.06  # Example: 6 days worth of rewards
        total_earned = 1470.6  # Example total
        
        return {
            "node_id": node_id,
            "unclaimed": unclaimed,
            "total_earned": total_earned,
            "last_claim": "2025-01-15T10:30:00Z",
            "next_claim_available": True,
            "min_claim_amount": 0.1
        }
        
    except Exception as e:
        logger.error(f"Error getting rewards for {node_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# --- Block Endpoints ---

@app.get("/api/v1/blocks/latest")
async def get_latest_block():
    """Get the latest block."""
    try:
        block = api_state.state_db.get_latest_block()
        if not block:
            raise HTTPException(status_code=404, detail="No blocks found")
        
        return {
            "height": block.height,
            "hash": block.hash(),
            "timestamp": block.timestamp,
            "previous_hash": block.previous_hash,
            "validator": block.validator,
            "transactions": len(block.transactions),
            "state_root": block.state_root
        }
        
    except Exception as e:
        logger.error(f"Error getting latest block: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/v1/blocks/{height}")
async def get_block(height: int):
    """Get block by height."""
    try:
        block = api_state.state_db.get_block(height)
        if not block:
            raise HTTPException(status_code=404, detail=f"Block {height} not found")
        
        return {
            "height": block.height,
            "hash": block.hash(),
            "timestamp": block.timestamp,
            "previous_hash": block.previous_hash,
            "validator": block.validator,
            "transactions": [
                {
                    "hash": tx.hash(),
                    "from": tx.from_address,
                    "to": tx.to_address,
                    "amount": tx.amount,
                    "gas_price": tx.gas_price,
                    "gas_limit": tx.gas_limit
                }
                for tx in block.transactions
            ],
            "state_root": block.state_root
        }
        
    except Exception as e:
        logger.error(f"Error getting block {height}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# --- WebSocket Endpoints ---

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint for real-time updates."""
    await websocket.accept()
    api_state.websocket_connections.append(websocket)
    
    try:
        # Send initial status
        status = await get_status()
        await websocket.send_json({
            "type": "status",
            "data": status
        })
        
        # Keep connection alive
        while True:
            # Wait for messages
            data = await websocket.receive_text()
            
            # Handle ping
            if data == "ping":
                await websocket.send_text("pong")
            
    except WebSocketDisconnect:
        api_state.websocket_connections.remove(websocket)
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        api_state.websocket_connections.remove(websocket)

async def broadcast_transaction(tx_hash: str, tx_data: dict):
    """Broadcast transaction to all WebSocket clients."""
    message = {
        "type": "new_transaction",
        "data": {
            "tx_hash": tx_hash,
            **tx_data
        }
    }
    
    # Send to all connected clients
    disconnected = []
    for ws in api_state.websocket_connections:
        try:
            await ws.send_json(message)
        except:
            disconnected.append(ws)
    
    # Remove disconnected clients
    for ws in disconnected:
        api_state.websocket_connections.remove(ws)

# --- Error Handlers ---

@app.exception_handler(HTTPException)
async def http_exception_handler(request, exc):
    """Handle HTTP exceptions."""
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "error": exc.detail,
            "status_code": exc.status_code,
            "timestamp": datetime.utcnow().isoformat()
        }
    )

@app.exception_handler(Exception)
async def general_exception_handler(request, exc):
    """Handle general exceptions."""
    logger.error(f"Unhandled exception: {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={
            "error": "Internal server error",
            "status_code": 500,
            "timestamp": datetime.utcnow().isoformat()
        }
    )

# --- Main ---

def main():
    """Run the API server."""
    import argparse
    
    parser = argparse.ArgumentParser(description="QNet API Server with Rust Backend")
    parser.add_argument("--host", default="0.0.0.0", help="Host to bind to")
    parser.add_argument("--port", type=int, default=5000, help="Port to bind to")
    parser.add_argument("--workers", type=int, default=4, help="Number of workers")
    parser.add_argument("--data-dir", default="./data", help="Data directory")
    parser.add_argument("--reload", action="store_true", help="Enable auto-reload")
    
    args = parser.parse_args()
    
    # Update data directory
    api_state.data_dir = args.data_dir
    
    # Run server
    uvicorn.run(
        "api_server_rust:app",
        host=args.host,
        port=args.port,
        workers=args.workers if not args.reload else 1,
        reload=args.reload,
        log_level="info",
        access_log=True
    )

if __name__ == "__main__":
    main() 

@app.get("/api/v1/mobile/gas-recommendations")
async def get_mobile_gas_recommendations():
    """Get mobile-optimized gas price recommendations with dynamic pricing."""
    try:
        # Get current mempool size and block utilization
        mempool_size = api_state.mempool.size()
        block_utilization = 0.5  # Mock value - in production, calculate from recent blocks
        
        # Update dynamic pricing
        from qnet_state.transaction import update_network_load, get_mobile_gas_recommendations
        update_network_load(mempool_size, block_utilization)
        
        # Get recommendations
        recommendations = get_mobile_gas_recommendations()
        
        return {
            "success": True,
            "recommendations": {
                "eco": {
                    "gas_price": recommendations.eco.to_qnc(),
                    "display_name": "Eco",
                    "description": "Slowest, cheapest option",
                    "estimated_time": format_confirmation_time(recommendations.estimated_confirmation_time),
                    "icon": "🌱"
                },
                "standard": {
                    "gas_price": recommendations.standard.to_qnc(),
                    "display_name": "Standard",
                    "description": "Normal speed and price",
                    "estimated_time": format_confirmation_time(recommendations.estimated_confirmation_time),
                    "icon": "⚡"
                },
                "fast": {
                    "gas_price": recommendations.fast.to_qnc(),
                    "display_name": "Fast",
                    "description": "Faster confirmation",
                    "estimated_time": format_confirmation_time(recommendations.estimated_confirmation_time),
                    "icon": "🚀"
                },
                "priority": {
                    "gas_price": recommendations.priority.to_qnc(),
                    "display_name": "Priority",
                    "description": "Fastest, highest priority",
                    "estimated_time": format_confirmation_time(recommendations.estimated_confirmation_time),
                    "icon": "⚡🔥"
                }
            },
            "network_status": {
                "load": format_network_load(recommendations.network_load),
                "mempool_size": mempool_size,
                "block_utilization": block_utilization
            },
            "mobile_optimized": True
        }
        
    except Exception as e:
        logger.error(f"Error getting mobile gas recommendations: {e}")
        # Fallback to static recommendations
        return {
            "success": True,
            "recommendations": {
                "eco": {
                    "gas_price": 0.0001,
                    "display_name": "Eco",
                    "description": "Slowest, cheapest option",
                    "estimated_time": "1-2 seconds",
                    "icon": "🌱"
                },
                "standard": {
                    "gas_price": 0.0002,
                    "display_name": "Standard",
                    "description": "Normal speed and price",
                    "estimated_time": "1-2 seconds",
                    "icon": "⚡"
                },
                "fast": {
                    "gas_price": 0.0005,
                    "display_name": "Fast",
                    "description": "Faster confirmation",
                    "estimated_time": "1-2 seconds",
                    "icon": "🚀"
                },
                "priority": {
                    "gas_price": 0.001,
                    "display_name": "Priority",
                    "description": "Fastest, highest priority",
                    "estimated_time": "1-2 seconds",
                    "icon": "⚡🔥"
                }
            },
            "network_status": {
                "load": "Normal",
                "mempool_size": 0,
                "block_utilization": 0.5
            },
            "mobile_optimized": True
        }

@app.post("/api/v1/mobile/estimate-transaction-cost")
async def estimate_mobile_transaction_cost(request: Request):
    """Estimate transaction cost for mobile wallets with detailed breakdown."""
    try:
        data = await request.json()
        transaction_type = data.get('type', 'transfer')
        gas_tier = data.get('gas_tier', 'standard')
        
        # Get gas limits based on transaction type
        from qnet_state.transaction import gas_limits
        gas_limit = {
            'transfer': gas_limits.TRANSFER,
            'batch_transfer': gas_limits.BATCH_OPERATION,
            'reward_claim': gas_limits.REWARD_CLAIM,
            'batch_reward_claim': gas_limits.BATCH_OPERATION,
            'node_activation': gas_limits.NODE_ACTIVATION,
            'batch_node_activation': gas_limits.BATCH_OPERATION,
            'contract_call': gas_limits.CONTRACT_CALL,
            'contract_deploy': gas_limits.CONTRACT_DEPLOY,
            'ping': gas_limits.PING,
        }.get(transaction_type, gas_limits.TRANSFER)
        
        # Get dynamic gas price
        from qnet_state.transaction import get_mobile_gas_recommendations
        recommendations = get_mobile_gas_recommendations()
        
        gas_price = {
            'eco': recommendations.eco,
            'standard': recommendations.standard,
            'fast': recommendations.fast,
            'priority': recommendations.priority,
        }.get(gas_tier, recommendations.standard)
        
        # Calculate costs
        gas_cost = gas_price.to_qnc() * gas_limit
        
        # Add transaction amount if provided
        amount = data.get('amount', 0)
        total_cost = gas_cost + amount
        
        return {
            "success": True,
            "estimate": {
                "transaction_amount": amount,
                "gas_fee": gas_cost,
                "total_cost": total_cost,
                "gas_price": gas_price.to_qnc(),
                "gas_limit": gas_limit,
                "gas_tier": gas_tier,
                "transaction_type": transaction_type,
                "currency": "QNC"
            },
            "breakdown": {
                "base_fee": gas_cost * 0.7,  # 70% base fee
                "priority_fee": gas_cost * 0.3,  # 30% priority fee
                "estimated_confirmation": format_confirmation_time(recommendations.estimated_confirmation_time),
                "savings_vs_priority": (recommendations.priority.to_qnc() - gas_price.to_qnc()) * gas_limit if gas_tier != 'priority' else 0
            },
            "mobile_optimized": True
        }
        
    except Exception as e:
        logger.error(f"Error estimating mobile transaction cost: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/v1/mobile/network-status")
async def get_mobile_network_status():
    """Get mobile-friendly network status information."""
    try:
        mempool_size = api_state.mempool.size()
        
        # Get current recommendations for network load
        from qnet_state.transaction import get_mobile_gas_recommendations
        recommendations = get_mobile_gas_recommendations()
        
        # Calculate network health metrics
        network_health = "🟢 Healthy"
        if mempool_size > 2000:
            network_health = "🔴 Congested"
        elif mempool_size > 1000:
            network_health = "🟡 Busy"
        elif mempool_size > 500:
            network_health = "🟠 Active"
        
        return {
            "success": True,
            "network": {
                "health": network_health,
                "load": format_network_load(recommendations.network_load),
                "mempool_size": mempool_size,
                "average_confirmation_time": format_confirmation_time(recommendations.estimated_confirmation_time),
                "recommended_gas_tier": "eco" if mempool_size < 100 else "standard" if mempool_size < 500 else "fast",
                "congestion_level": min(100, (mempool_size / 20))  # Percentage out of 100
            },
            "mobile_tips": [
                "Use Eco tier during low network activity for maximum savings",
                "Batch multiple operations together to save on fees",
                "Ping responses are always free - no gas required",
                "Set transaction deadlines to avoid stuck transactions"
            ] if mempool_size < 500 else [
                "Network is busy - consider using Fast tier for quicker confirmation",
                "Batch operations are especially cost-effective during high congestion",
                "Consider waiting for lower congestion if transaction is not urgent"
            ],
            "mobile_optimized": True
        }
        
    except Exception as e:
        logger.error(f"Error getting mobile network status: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/v1/mobile/batch-estimate")
async def estimate_mobile_batch_cost(request: Request):
    """Estimate cost for batch operations optimized for mobile wallets."""
    try:
        data = await request.json()
        operations = data.get('operations', [])
        gas_tier = data.get('gas_tier', 'standard')
        
        if not operations:
            raise HTTPException(status_code=400, detail="No operations provided")
        
        # Get gas recommendations
        from qnet_state.transaction import get_mobile_gas_recommendations, gas_limits
        recommendations = get_mobile_gas_recommendations()
        
        gas_price = {
            'eco': recommendations.eco,
            'standard': recommendations.standard,
            'fast': recommendations.fast,
            'priority': recommendations.priority,
        }.get(gas_tier, recommendations.standard)
        
        # Calculate individual vs batch costs
        individual_cost = 0
        individual_gas = 0
        
        for op in operations:
            op_type = op.get('type', 'transfer')
            gas_limit = {
                'transfer': gas_limits.TRANSFER,
                'reward_claim': gas_limits.REWARD_CLAIM,
                'node_activation': gas_limits.NODE_ACTIVATION,
            }.get(op_type, gas_limits.TRANSFER)
            
            individual_gas += gas_limit
            individual_cost += gas_price.to_qnc() * gas_limit
        
        # Batch cost (more efficient)
        batch_gas = gas_limits.BATCH_OPERATION + (len(operations) * 1000)  # Base + per-operation overhead
        batch_cost = gas_price.to_qnc() * batch_gas
        
        # Calculate savings
        savings = individual_cost - batch_cost
        savings_percentage = (savings / individual_cost * 100) if individual_cost > 0 else 0
        
        return {
            "success": True,
            "estimate": {
                "individual_cost": individual_cost,
                "individual_gas": individual_gas,
                "batch_cost": batch_cost,
                "batch_gas": batch_gas,
                "savings": savings,
                "savings_percentage": savings_percentage,
                "operations_count": len(operations),
                "gas_tier": gas_tier,
                "currency": "QNC"
            },
            "recommendation": {
                "use_batch": savings > 0,
                "savings_reason": f"Save {savings:.6f} QNC ({savings_percentage:.1f}%) by batching {len(operations)} operations",
                "estimated_confirmation": format_confirmation_time(recommendations.estimated_confirmation_time)
            },
            "mobile_optimized": True
        }
        
    except Exception as e:
        logger.error(f"Error estimating mobile batch cost: {e}")
        raise HTTPException(status_code=500, detail=str(e))

def format_confirmation_time(time_enum):
    """Format confirmation time for mobile display."""
    if hasattr(time_enum, 'Seconds'):
        return f"{time_enum.Seconds} seconds"
    elif hasattr(time_enum, 'Minutes'):
        return f"{time_enum.Minutes} minutes"
    else:
        return "1-2 seconds"

def format_network_load(load_enum):
    """Format network load for mobile display."""
    load_map = {
        'Low': 'Low',
        'Normal': 'Normal',
        'High': 'High',
        'VeryHigh': 'Very High',
        'Extreme': 'Extreme'
    }
    return load_map.get(str(load_enum), 'Normal') 