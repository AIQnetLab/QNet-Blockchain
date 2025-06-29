#!/usr/bin/env python3
"""
QNet API Server - FastAPI implementation
Provides REST API for interacting with QNet blockchain
"""

from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any
import asyncio
import aiohttp
import json
import logging
from datetime import datetime
import uvicorn

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# FastAPI app
app = FastAPI(
    title="QNet Blockchain API",
    description="REST API for QNet blockchain interaction",
    version="0.1.0"
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Pydantic models
class Transaction(BaseModel):
    from_address: str = Field(..., description="Sender address")
    to_address: str = Field(..., description="Recipient address")
    amount: float = Field(..., gt=0, description="Amount to transfer")
    gas_price: int = Field(default=1, ge=1, description="Gas price")
    gas_limit: int = Field(default=21000, ge=21000, description="Gas limit")
    nonce: Optional[int] = Field(None, description="Transaction nonce")
    data: Optional[str] = Field("", description="Additional data")

class Block(BaseModel):
    height: int
    timestamp: int
    previous_hash: str
    transactions: List[Dict[str, Any]]
    state_root: str
    validator: str
    consensus_proof: Dict[str, Any]

class NodeInfo(BaseModel):
    node_id: str
    version: str
    network: str
    peers: int
    height: int
    syncing: bool

class AccountInfo(BaseModel):
    address: str
    balance: float
    nonce: int
    is_node: bool
    node_type: Optional[str]
    stake: float
    reputation: float

# Global state
node_rpc_url = "http://localhost:9877"  # RPC endpoint for Rust node
connected_nodes = []

# Helper functions
async def call_node_rpc(method: str, params: Dict[str, Any] = None) -> Dict[str, Any]:
    """Call RPC method on the Rust node"""
    async with aiohttp.ClientSession() as session:
        payload = {
            "jsonrpc": "2.0",
            "method": method,
            "params": params or {},
            "id": 1
        }
        try:
            async with session.post(node_rpc_url, json=payload) as response:
                result = await response.json()
                if "error" in result:
                    raise HTTPException(status_code=500, detail=result["error"]["message"])
                return result.get("result", {})
        except aiohttp.ClientError as e:
            logger.error(f"RPC call failed: {e}")
            raise HTTPException(status_code=503, detail="Node connection failed")

# API endpoints
@app.get("/", tags=["General"])
async def root():
    """Root endpoint"""
    return {
        "name": "QNet API",
        "version": "0.1.0",
        "status": "running",
        "docs": "/docs"
    }

@app.get("/health", tags=["General"])
async def health_check():
    """Health check endpoint"""
    try:
        # Try to get node status
        await call_node_rpc("node_getStatus")
        return {"status": "healthy", "timestamp": datetime.utcnow().isoformat()}
    except:
        return {"status": "unhealthy", "timestamp": datetime.utcnow().isoformat()}

@app.get("/node/info", response_model=NodeInfo, tags=["Node"])
async def get_node_info():
    """Get node information"""
    try:
        info = await call_node_rpc("node_getInfo")
        return NodeInfo(**info)
    except:
        # Return mock data if node is not connected
        return NodeInfo(
            node_id="node1",
            version="0.1.0",
            network="testnet",
            peers=0,
            height=0,
            syncing=False
        )

@app.get("/node/peers", tags=["Node"])
async def get_peers():
    """Get connected peers"""
    try:
        peers = await call_node_rpc("node_getPeers")
        return {"peers": peers, "count": len(peers)}
    except:
        return {"peers": [], "count": 0}

@app.get("/blockchain/height", tags=["Blockchain"])
async def get_blockchain_height():
    """Get current blockchain height"""
    try:
        result = await call_node_rpc("chain_getHeight")
        return {"height": result.get("height", 0)}
    except:
        return {"height": 0}

@app.get("/blockchain/block/{height}", response_model=Block, tags=["Blockchain"])
async def get_block(height: int):
    """Get block by height"""
    try:
        block = await call_node_rpc("chain_getBlock", {"height": height})
        return Block(**block)
    except:
        raise HTTPException(status_code=404, detail=f"Block {height} not found")

@app.get("/blockchain/blocks", tags=["Blockchain"])
async def get_blocks(start: int = 0, limit: int = 10):
    """Get multiple blocks"""
    try:
        blocks = await call_node_rpc("chain_getBlocks", {"start": start, "limit": limit})
        return {"blocks": blocks, "start": start, "limit": limit}
    except:
        return {"blocks": [], "start": start, "limit": limit}

@app.post("/transaction/submit", tags=["Transaction"])
async def submit_transaction(tx: Transaction):
    """Submit a new transaction"""
    try:
        result = await call_node_rpc("tx_submit", tx.dict())
        return {"success": True, "tx_hash": result.get("hash"), "message": "Transaction submitted"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.get("/transaction/{tx_hash}", tags=["Transaction"])
async def get_transaction(tx_hash: str):
    """Get transaction by hash"""
    try:
        tx = await call_node_rpc("tx_get", {"hash": tx_hash})
        return tx
    except:
        raise HTTPException(status_code=404, detail=f"Transaction {tx_hash} not found")

@app.get("/mempool", tags=["Transaction"])
async def get_mempool():
    """Get mempool transactions"""
    try:
        mempool = await call_node_rpc("mempool_getTransactions")
        return {"transactions": mempool, "count": len(mempool)}
    except:
        return {"transactions": [], "count": 0}

@app.get("/account/{address}", response_model=AccountInfo, tags=["Account"])
async def get_account(address: str):
    """Get account information"""
    try:
        account = await call_node_rpc("account_getInfo", {"address": address})
        return AccountInfo(**account)
    except:
        # Return default account if not found
        return AccountInfo(
            address=address,
            balance=0.0,
            nonce=0,
            is_node=False,
            node_type=None,
            stake=0.0,
            reputation=0.0
        )

@app.get("/account/{address}/balance", tags=["Account"])
async def get_balance(address: str):
    """Get account balance"""
    try:
        result = await call_node_rpc("account_getBalance", {"address": address})
        return {"address": address, "balance": result.get("balance", 0)}
    except:
        return {"address": address, "balance": 0}

@app.get("/stats", tags=["Statistics"])
async def get_stats():
    """Get blockchain statistics"""
    try:
        stats = await call_node_rpc("stats_get")
        return stats
    except:
        return {
            "total_blocks": 0,
            "total_transactions": 0,
            "total_accounts": 0,
            "tps": 0,
            "network_hashrate": 0
        }

@app.post("/node/activate", tags=["Node"])
async def activate_node(node_type: str, burn_amount: float):
    """Activate a node by burning 1DEV (Phase 1) or spending QNC to Pool 3 (Phase 2)"""
    if node_type not in ["light", "full", "super"]:
        raise HTTPException(status_code=400, detail="Invalid node type")
    
    try:
        result = await call_node_rpc("node_activate", {
            "type": node_type,
            "burn_amount": burn_amount
        })
        return {"success": True, "node_id": result.get("node_id"), "message": "Node activated"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

# WebSocket endpoint for real-time updates
from fastapi import WebSocket, WebSocketDisconnect

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket for real-time blockchain updates"""
    await websocket.accept()
    try:
        while True:
            # Send updates every second
            await asyncio.sleep(1)
            
            # Get latest data
            try:
                height = await call_node_rpc("chain_getHeight")
                stats = await call_node_rpc("stats_get")
                
                await websocket.send_json({
                    "type": "update",
                    "data": {
                        "height": height.get("height", 0),
                        "tps": stats.get("tps", 0),
                        "peers": len(connected_nodes)
                    }
                })
            except:
                pass
                
    except WebSocketDisconnect:
        logger.info("WebSocket client disconnected")

# Background tasks
async def sync_with_node():
    """Background task to sync with Rust node"""
    while True:
        try:
            # Update connected nodes
            peers = await call_node_rpc("node_getPeers")
            connected_nodes.clear()
            connected_nodes.extend(peers)
        except:
            pass
        
        await asyncio.sleep(5)

@app.on_event("startup")
async def startup_event():
    """Start background tasks"""
    asyncio.create_task(sync_with_node())
    logger.info("QNet API server started")

@app.on_event("shutdown")
async def shutdown_event():
    """Cleanup on shutdown"""
    logger.info("QNet API server shutting down")

if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        log_level="info"
    ) 