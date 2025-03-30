#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
QNet Blockchain Website - Main Flask Application
Provides the web interface for exploring the QNet quantum-resistant blockchain.
This version connects to a real QNet node for data.
"""

from flask import Flask, render_template, jsonify, request, redirect, url_for, flash, abort, g
import requests
import json
import os
import time
import datetime
import logging
import hashlib
from functools import wraps
import re
import math
from werkzeug.middleware.proxy_fix import ProxyFix
import uuid

app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY', 'qnet_development_key')

# Configure for running behind proxy
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[logging.StreamHandler()]
)

# Configuration - Load from environment variables
NODE_API_URL = os.environ.get('NODE_API_URL', 'http://localhost:8000')
SITE_NAME = os.environ.get('SITE_NAME', 'QNet Blockchain')
EXPLORER_NAME = os.environ.get('EXPLORER_NAME', 'QNet Explorer')

# Additional configuration
API_TIMEOUT = int(os.environ.get('API_TIMEOUT', '10'))
ENABLE_CACHING = os.environ.get('ENABLE_CACHING', 'true').lower() == 'true'
CACHE_TIMEOUT = int(os.environ.get('CACHE_TIMEOUT', '60'))  # Cache data for 60 seconds

# Cache settings
cache = {}

# ===== Middleware =====

@app.before_request
def before_request():
    """Execute before each request"""
    g.request_start_time = time.time()
    g.request_id = str(uuid.uuid4())

@app.after_request
def after_request(response):
    """Execute after each request"""
    # Calculate request duration
    if hasattr(g, 'request_start_time'):
        duration = time.time() - g.request_start_time
        response.headers['X-Response-Time'] = f"{duration:.4f}s"
    
    # Add security headers
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['X-XSS-Protection'] = '1; mode=block'
    
    # Log request details
    logging.info(
        f"Request: {request.method} {request.path} | "
        f"Status: {response.status_code} | "
        f"Duration: {duration:.4f}s | "
        f"ID: {g.request_id}"
    )
    
    return response

# ===== Helper Functions =====

def cached_api_request(endpoint, params=None, timeout=CACHE_TIMEOUT, method='GET', data=None):
    """Make API request with caching."""
    if not ENABLE_CACHING:
        return direct_api_request(endpoint, params, method, data)
    
    cache_key = f"{endpoint}:{json.dumps(params) if params else ''}:{json.dumps(data) if data else ''}"
    current_time = time.time()
    
    # Check if cached data exists and is still valid
    if cache_key in cache and cache[cache_key]['expiry'] > current_time:
        logging.debug(f"Cache hit for {endpoint}")
        return cache[cache_key]['data']
    
    # Cache miss - make actual API request
    logging.debug(f"Cache miss for {endpoint}")
    result = direct_api_request(endpoint, params, method, data)
    
    # Cache the result if successful
    if result is not None:
        cache[cache_key] = {
            'data': result,
            'expiry': current_time + timeout
        }
    
    return result

def direct_api_request(endpoint, params=None, method='GET', data=None):
    """Make direct API request without caching."""
    url = f"{NODE_API_URL}{endpoint}"
    
    try:
        logging.debug(f"API request: {method} {url}")
        
        if method.upper() == 'GET':
            response = requests.get(url, params=params, timeout=API_TIMEOUT)
        elif method.upper() == 'POST':
            response = requests.post(url, json=data, timeout=API_TIMEOUT)
        else:
            logging.error(f"Unsupported HTTP method: {method}")
            return None

        # Check if response is successful
        if response.status_code == 200:
            result = response.json()
            return result
            
        # Handle error responses
        logging.warning(f"API error: {response.status_code} - {response.text}")
        return None
    except requests.exceptions.Timeout:
        logging.error(f"API request timeout: {url}")
        return None
    except requests.exceptions.ConnectionError:
        logging.error(f"API connection error: {url}")
        return None
    except Exception as e:
        logging.error(f"API request error ({url}): {e}")
        return None

def format_time_ago(timestamp):
    """Format timestamp to 'time ago' text."""
    if not timestamp:
        return "Unknown"
        
    now = time.time()
    diff = now - timestamp
    
    if diff < 60:
        return "Just now"
    elif diff < 3600:
        minutes = int(diff / 60)
        return f"{minutes} minute{'s' if minutes > 1 else ''} ago"
    elif diff < 86400:
        hours = int(diff / 3600)
        return f"{hours} hour{'s' if hours > 1 else ''} ago"
    elif diff < 604800:
        days = int(diff / 86400)
        return f"{days} day{'s' if days > 1 else ''} ago"
    else:
        return datetime.datetime.fromtimestamp(timestamp).strftime('%Y-%m-%d')

def format_address(address):
    """Format address for display (shortened version)."""
    if not address or address == "Unknown":
        return "Unknown"
    if address == "network":
        return "Network (Coinbase)"
    if len(address) > 16:
        return f"{address[:8]}...{address[-8:]}"
    return address

# ===== Data Retrieval Functions =====

def get_blockchain_info():
    """Get basic blockchain information."""
    try:
        # First try the stats endpoint if available
        stats = cached_api_request('/api/v1/stats')
        if stats:
            if isinstance(stats, dict) and stats.get('success', False) and 'data' in stats:
                stats_data = stats['data']
            else:
                stats_data = stats
                
            return {
                "height": stats_data.get("block_count", 0) - 1,
                "total_transactions": stats_data.get("transaction_count", 0),
                "total_issued": stats_data.get("total_supply", 0),
                "last_block_time": format_timestamp(stats_data.get("timestamp", 0))
            }
            
        # Fallback to basic chain info
        chain_data = cached_api_request('/chain')
        if chain_data:
            if isinstance(chain_data, dict) and chain_data.get('success', False) and 'data' in chain_data:
                chain_length = chain_data['data'].get("length", 0)
            else:
                chain_length = chain_data.get("length", 0)
            
            # Get state info for total issued coins
            state_data = cached_api_request('/state')
            
            # Parse state data based on API response format
            total_issued = 0
            if state_data:
                if isinstance(state_data, dict) and state_data.get('success', False) and 'data' in state_data:
                    total_issued = state_data['data'].get("total_issued", 0)
                else:
                    total_issued = state_data.get("total_issued", 0)
            
            return {
                "height": chain_length - 1 if chain_length > 0 else 0,
                "total_issued": total_issued,
                "last_block_time": datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                "total_transactions": 0  # Not available in this API response
            }
            
        # If we can't get data, return empty object
        logging.error("Failed to retrieve blockchain info from API")
        return {}
    except Exception as e:
        logging.error(f"Error getting blockchain info: {e}")
        return {}

def get_latest_blocks(count=10):
    """Get latest blocks."""
    try:
        # Get chain info to determine current height
        chain_data = cached_api_request('/chain')
        if not chain_data:
            return []
            
        # Parse chain data based on API response format
        if isinstance(chain_data, dict) and chain_data.get('success', False) and 'data' in chain_data:
            current_height = chain_data['data'].get("length", 0) - 1
        else:
            current_height = chain_data.get("length", 0) - 1
            
        if current_height < 0:
            return []
        
        # Get block details for the latest blocks
        latest_blocks = []
        for height in range(current_height, max(current_height - count, -1), -1):
            block = get_block_by_height(height)
            if block:
                # Format timestamp
                block_time = format_timestamp(block.get("timestamp", 0))
                time_ago = format_time_ago(block.get("timestamp", 0))
                
                # Format for display
                formatted_block = {
                    "height": block.get("index"),
                    "hash": block.get("hash"),
                    "time": block_time,
                    "time_ago": time_ago,
                    "transactions": len(block.get("transactions", [])),
                    "producer": format_address(block.get("producer", "Unknown"))
                }
                latest_blocks.append(formatted_block)
                
        return latest_blocks
    except Exception as e:
        logging.error(f"Error getting latest blocks: {e}")
        return []

def get_blocks_range(start_height, end_height):
    """Get blocks within a height range."""
    blocks = []
    try:
        for height in range(end_height - 1, start_height - 1, -1):
            block = get_block_by_height(height)
            if block:
                # Format for display
                blocks.append({
                    "index": block.get("index"),
                    "hash": block.get("hash"),
                    "time_ago": format_time_ago(block.get("timestamp", 0)),
                    "transaction_count": len(block.get("transactions", [])),
                    "producer": format_address(block.get("producer", "Unknown"))
                })
    except Exception as e:
        logging.error(f"Error getting blocks range: {e}")
    
    return blocks

def get_latest_transactions(count=10):
    """Get latest transactions."""
    latest_txs = []
    
    try:
        # Try dedicated endpoint for latest transactions if available
        transactions = cached_api_request('/api/v1/transactions/latest', params={'limit': count})
        if transactions:
            # Parse response based on API format
            if isinstance(transactions, dict) and transactions.get('success', False) and 'data' in transactions:
                tx_list = transactions['data'].get('transactions', [])
            else:
                tx_list = transactions
                
            for tx in tx_list:
                latest_txs.append({
                    "hash": tx.get("hash"),
                    "sender": format_address(tx.get("sender", "Unknown")),
                    "recipient": format_address(tx.get("recipient", "Unknown")),
                    "amount": tx.get("amount", 0),
                    "time": format_time_ago(tx.get("timestamp", 0))
                })
                
            return latest_txs
                
        # Fallback method: Get latest blocks and extract transactions
        latest_blocks = get_latest_blocks(5)  # Get transactions from last 5 blocks
        
        # Extract transactions from blocks
        for block_info in latest_blocks:
            # Get full block
            block = get_block_by_height(block_info["height"])
            if block and "transactions" in block:
                for tx in block.get("transactions", []):
                    if len(latest_txs) >= count:
                        return latest_txs
                    
                    # Generate tx hash if not present
                    tx_hash = tx.get("hash")
                    if not tx_hash:
                        try:
                            tx_json = json.dumps(tx, sort_keys=True).encode()
                            tx_hash = hashlib.sha256(tx_json).hexdigest()
                        except Exception as e:
                            logging.error(f"Error generating transaction hash: {e}")
                            tx_hash = "unknown"
                    
                    # Format transaction for display
                    latest_txs.append({
                        "hash": tx_hash,
                        "sender": format_address(tx.get("sender", "Unknown")),
                        "recipient": format_address(tx.get("recipient", "Unknown")),
                        "amount": tx.get("amount", 0),
                        "time": format_time_ago(block.get("timestamp", 0))
                    })
        
        return latest_txs
    except Exception as e:
        logging.error(f"Error getting latest transactions: {e}")
        return []

def get_block_by_height(height):
    """Get block by height."""
    try:
        # Try specific block API if available
        block = cached_api_request(f'/api/v1/block/{height}')
        if block:
            # Parse response based on API format
            if isinstance(block, dict) and block.get('success', False) and 'data' in block:
                return block['data']
            return block
            
        # Fallback to chain API
        chain_data = cached_api_request('/chain', params={'start': height, 'limit': 1})
        if chain_data:
            # Parse response based on API format
            if isinstance(chain_data, dict) and chain_data.get('success', False) and 'data' in chain_data:
                chain_blocks = chain_data['data'].get("chain", [])
            else:
                chain_blocks = chain_data.get("chain", [])
                
            for block in chain_blocks:
                if block.get("index") == height:
                    return block
        
        return None
    except Exception as e:
        logging.error(f"Error getting block {height}: {e}")
        return None

def get_transaction(tx_hash):
    """Get transaction by hash."""
    try:
        # Try specific transaction API if available
        tx = cached_api_request(f'/api/v1/transaction/{tx_hash}')
        if tx:
            # Parse response based on API format
            if isinstance(tx, dict) and tx.get('success', False) and 'data' in tx:
                return tx['data']
            return tx
            
        # If dedicated API not available, we'd need to search through blocks
        # This is a simplified implementation - in production, would need indexing
        logging.warning(f"Transaction {tx_hash} not found via direct API. Fallback search not implemented.")
        return None
    except Exception as e:
        logging.error(f"Error getting transaction {tx_hash}: {e}")
        return None

def get_address_balance(address):
    """Get address balance."""
    try:
        # Try specific balance API if available
        balance_data = cached_api_request(f'/api/v1/address/{address}/balance')
        if balance_data:
            # Parse response based on API format
            if isinstance(balance_data, dict) and balance_data.get('success', False) and 'data' in balance_data:
                return balance_data['data'].get("balance", 0)
            return balance_data.get("balance", 0)
            
        # Fallback to state API with address filter
        state_data = cached_api_request('/state', params={'address': address})
        if state_data:
            # Parse response based on API format
            if isinstance(state_data, dict) and state_data.get('success', False) and 'data' in state_data:
                balances = state_data['data'].get("balances", {})
            else:
                balances = state_data.get("balances", {})
                
            return balances.get(address, 0)
        
        return 0
    except Exception as e:
        logging.error(f"Error getting address balance {address}: {e}")
        return 0

def get_address_transactions(address, limit=50, offset=0):
    """Get transactions for an address."""
    try:
        # Try specific address transactions API if available
        tx_data = cached_api_request(f'/api/v1/address/{address}/transactions', 
                                    params={'limit': limit, 'offset': offset})
        if tx_data:
            # Parse response based on API format
            if isinstance(tx_data, dict) and tx_data.get('success', False) and 'data' in tx_data:
                return tx_data['data']
            return tx_data
            
        # Fallback implementation would require scanning all blocks
        # which is not efficient without proper indexing
        logging.warning(f"Address transactions for {address} not available via direct API. Fallback search not implemented.")
        return []
    except Exception as e:
        logging.error(f"Error getting address transactions {address}: {e}")
        return []

def get_network_stats():
    """Get network statistics for statistics page."""
    try:
        # Try dedicated stats API
        stats = cached_api_request('/api/v1/stats')
        if stats:
            # Parse response based on API format
            if isinstance(stats, dict) and stats.get('success', False) and 'data' in stats:
                stats_data = stats['data']
            else:
                stats_data = stats
                
            return {
                "active_nodes": stats_data.get("peer_count", 0),
                "avg_block_time": stats_data.get("average_block_time", 10.0),
                "avg_tx_fee": stats_data.get("average_fee", 0.0001),
                "total_accounts": stats_data.get("total_accounts", 0),
                "market_cap": stats_data.get("market_cap", 0),
                "difficulty": stats_data.get("difficulty", "N/A"),
                "current_tps": stats_data.get("current_tps", 0),
                "peak_tps": stats_data.get("peak_tps", 0)
            }
        
        # Fallback to basic info if stats not available
        blockchain_info = get_blockchain_info()
        peers_data = get_peers()
        
        num_peers = 0
        if peers_data and isinstance(peers_data, dict):
            if 'peers' in peers_data:
                num_peers = len(peers_data['peers'])
            elif peers_data.get('success', False) and 'data' in peers_data and 'peers' in peers_data['data']:
                num_peers = len(peers_data['data']['peers'])
        
        # Provide basic stats with defaults
        return {
            "active_nodes": num_peers,
            "avg_block_time": 10.0,  # Default value
            "avg_tx_fee": 0.0001,    # Default value
            "total_accounts": 0,     # Not available
            "market_cap": 0,         # Not available
            "difficulty": "N/A",     # Not applicable
            "current_tps": 0,        # Not available
            "peak_tps": 0            # Not available
        }
    except Exception as e:
        logging.error(f"Error getting network stats: {e}")
        return {}

def get_peers():
    """Get information about network peers."""
    try:
        peers_data = cached_api_request('/get_peers')
        if peers_data:
            # Parse response based on API format
            if isinstance(peers_data, dict) and peers_data.get('success', False) and 'data' in peers_data:
                return peers_data['data'].get('peers', {})
            return peers_data.get('peers', {})
        return {}
    except Exception as e:
        logging.error(f"Error getting peers: {e}")
        return {}

def get_system_info():
    """Get system information for node dashboard."""
    try:
        # Try dedicated system info API if available
        system_info = cached_api_request('/api/v1/node/info')
        if system_info:
            # Parse response based on API format
            if isinstance(system_info, dict) and system_info.get('success', False) and 'data' in system_info:
                info_data = system_info['data']
            else:
                info_data = system_info
                
            return {
                "is_synced": info_data.get("is_synced", True),
                "is_syncing": info_data.get("is_syncing", False),
                "status": info_data.get("status", "Online"),
                "node_id": info_data.get("node_id", "Unknown"),
                "address": info_data.get("address", "Unknown"),
                "version": info_data.get("version", "1.0.0")
            }
        
        # Fallback to basic info (placeholder values)
        return {
            "is_synced": True,
            "is_syncing": False,
            "status": "Online",
            "node_id": "Unknown",
            "address": NODE_API_URL,
            "version": "1.0.0"
        }
    except Exception as e:
        logging.error(f"Error getting system info: {e}")
        return {}

def get_system_stats():
    """Get system statistics for node dashboard."""
    try:
        # Try dedicated system stats API if available
        system_stats = cached_api_request('/api/v1/node/stats')
        if system_stats:
            # Parse response based on API format
            if isinstance(system_stats, dict) and system_stats.get('success', False) and 'data' in system_stats:
                stats_data = system_stats['data']
            else:
                stats_data = system_stats
                
            return {
                "cpu_percent": stats_data.get("cpu_percent", 0),
                "memory_percent": stats_data.get("memory_percent", 0),
                "disk_usage": stats_data.get("disk_usage", 0),
                "uptime": format_uptime(stats_data.get("uptime", 0)),
                "timestamp": format_timestamp(stats_data.get("timestamp", time.time()))
            }
        
        # Fallback to placeholder values
        return {
            "cpu_percent": 0,
            "memory_percent": 0,
            "disk_usage": 0,
            "uptime": "Unknown",
            "timestamp": datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        }
    except Exception as e:
        logging.error(f"Error getting system stats: {e}")
        return {}

def get_chart_data():
    """Get data for charts."""
    try:
        # Try dedicated chart data API if available
        chart_data = cached_api_request('/api/v1/charts/network_activity')
        if chart_data:
            # Parse response based on API format
            if isinstance(chart_data, dict) and chart_data.get('success', False) and 'data' in chart_data:
                data = chart_data['data']
            else:
                data = chart_data
                
            return {
                "labels": json.dumps(data.get("labels", [])),
                "transaction_counts": json.dumps(data.get("transaction_counts", [])),
                "block_counts": json.dumps(data.get("block_counts", []))
            }
            
        # Fallback to generated data
        # Generate labels for last 14 days
        today = datetime.datetime.now()
        labels = [(today - datetime.timedelta(days=i)).strftime('%b %d') for i in range(13, -1, -1)]
        
        # Generate random increasing transaction counts
        tx_values = [0]
        for i in range(13):
            next_val = max(1, int(tx_values[-1] * (1 + abs(math.sin(i) * 0.3))))
            tx_values.append(next_val)
        
        # Generate block counts based on transaction counts
        block_values = [max(1, int(tx/5)) for tx in tx_values]
        
        return {
            "labels": json.dumps(labels),
            "transaction_counts": json.dumps(tx_values),
            "block_counts": json.dumps(block_values)
        }
    except Exception as e:
        logging.error(f"Error getting chart data: {e}")
        # Return empty data
        return {
            "labels": json.dumps([]),
            "transaction_counts": json.dumps([]),
            "block_counts": json.dumps([])
        }

# ===== Formatting Functions =====

def format_timestamp(timestamp):
    """Format timestamp to readable date/time."""
    if not timestamp:
        return "Unknown"
    
    try:
        return datetime.datetime.fromtimestamp(timestamp).strftime('%Y-%m-%d %H:%M:%S')
    except Exception:
        return "Invalid timestamp"

def format_uptime(seconds):
    """Format seconds to readable uptime."""
    if not seconds:
        return "Unknown"
        
    try:
        seconds = int(seconds)
        days, remainder = divmod(seconds, 86400)
        hours, remainder = divmod(remainder, 3600)
        minutes, _ = divmod(remainder, 60)
        
        parts = []
        if days > 0:
            parts.append(f"{days} day{'s' if days > 1 else ''}")
        if hours > 0:
            parts.append(f"{hours} hour{'s' if hours > 1 else ''}")
        if minutes > 0 and days == 0:  # Show minutes only if less than a day
            parts.append(f"{minutes} minute{'s' if minutes > 1 else ''}")
            
        return ", ".join(parts) if parts else "Just started"
    except Exception:
        return "Unknown"

# ===== Website Routes =====

@app.route('/')
def home():
    """Homepage with key metrics and features."""
    try:
        # Get basic blockchain info
        blockchain_info = get_blockchain_info()
        
        # Get latest blocks and transactions for display
        latest_blocks = get_latest_blocks(5)
        latest_txs = get_latest_transactions(5)
        
        # Get chart data for network activity
        chart_data = get_chart_data()
        
        return render_template(
            'index.html',
            site_name=SITE_NAME,
            blockchain_info=blockchain_info,
            latest_blocks=latest_blocks,
            latest_txs=latest_txs,
            chart_data=chart_data
        )
    except Exception as e:
        logging.error(f"Error loading homepage: {e}")
        return render_template(
            'index.html',
            site_name=SITE_NAME,
            error="Could not connect to node API"
        )

@app.route('/about')
def about():
    """About page with project information."""
    return render_template('about.html', site_name=SITE_NAME)

@app.route('/explorer')
def explorer():
    """Blockchain explorer homepage."""
    try:
        # Get blockchain stats
        blockchain_info = get_blockchain_info()
        
        # Get latest blocks
        latest_blocks = get_latest_blocks(10)
        
        # Get latest transactions
        latest_txs = get_latest_transactions(10)
        
        # Get chart data for network activity visualization
        chart_data = get_chart_data()
        
        return render_template(
            'index.html',  # Using explorer/index.html template
            site_name=EXPLORER_NAME,
            blockchain_info=blockchain_info,
            latest_blocks=latest_blocks,
            latest_txs=latest_txs,
            chart_data=chart_data,
            page='explorer'
        )
    except Exception as e:
        logging.error(f"Error loading explorer: {e}")
        return render_template(
            'error.html',
            site_name=EXPLORER_NAME,
            message="Could not connect to node API",
            page='explorer'
        )

@app.route('/explorer/blocks')
def blocks_list():
    """List of blockchain blocks with pagination."""
    try:
        page = int(request.args.get('page', 1))
        blocks_per_page = 20
        
        # Get blockchain info to determine total pages
        blockchain_info = get_blockchain_info()
        total_blocks = blockchain_info.get('height', 0) + 1
        total_pages = math.ceil(total_blocks / blocks_per_page)
        
        # Make sure page is in valid range
        page = max(1, min(page, total_pages))
        
        # Calculate start and end indices for blocks
        end_height = total_blocks - (page - 1) * blocks_per_page
        start_height = max(0, end_height - blocks_per_page)
        
        # Get blocks for this page
        blocks = get_blocks_range(start_height, end_height)
        
        return render_template(
            'blockchain.html',
            site_name=EXPLORER_NAME,
            blockchain_info=blockchain_info,
            blocks=blocks,
            page=page,
            total_pages=total_pages,
            page_type='blocks'
        )
    except Exception as e:
        logging.error(f"Error loading blocks list: {e}")
        return render_template(
            'error.html',
            site_name=EXPLORER_NAME,
            message="Could not load blocks",
            page='explorer'
        )

@app.route('/explorer/block/<int:height>')
def block_detail(height):
    """Block detail page."""
    try:
        block = get_block_by_height(height)
        if not block:
            return render_template(
                'error.html',
                site_name=EXPLORER_NAME,
                message=f"Block {height} not found",
                page='explorer'
            )
        
        # Format block data for display
        formatted_block = format_block_for_display(block)
        
        # Get blockchain info for navigation context
        blockchain_info = get_blockchain_info()
        
        return render_template(
            'block.html',
            site_name=EXPLORER_NAME,
            block=formatted_block,
            blockchain_info=blockchain_info,
            page='explorer'
        )
    except Exception as e:
        logging.error(f"Error loading block {height}: {e}")
        return render_template(
            'error.html',
            site_name=EXPLORER_NAME,
            message=f"Error loading block {height}",
            page='explorer'
        )

@app.route('/explorer/tx/<tx_hash>')
def transaction_detail(tx_hash):
    """Transaction detail page."""
    try:
        tx = get_transaction(tx_hash)
        if not tx:
            return render_template(
                'error.html',
                site_name=EXPLORER_NAME,
                message=f"Transaction {tx_hash} not found",
                page='explorer'
            )
        
        # Format transaction data for display
        formatted_tx = format_transaction_for_display(tx)
        
        return render_template(
            'transaction.html',
            site_name=EXPLORER_NAME,
            tx=formatted_tx,
            page='explorer'
        )
    except Exception as e:
        logging.error(f"Error loading transaction {tx_hash}: {e}")
        return render_template(
            'error.html',
            site_name=EXPLORER_NAME,
            message=f"Error loading transaction {tx_hash}",
            page='explorer'
        )

@app.route('/explorer/address/<address>')
def address_detail(address):
    """Address detail page with balance and transactions."""
    try:
        # Get address balance
        balance = get_address_balance(address)
        
        # Get address transactions with pagination
        page = int(request.args.get('page', 1))
        txs_per_page = 20
        transactions = get_address_transactions(address, limit=txs_per_page, offset=(page-1)*txs_per_page)
        
        # Handle different response formats
        tx_list = []
        total_txs = 0
        
        if isinstance(transactions, dict):
            if 'transactions' in transactions:
                tx_list = transactions.get('transactions', [])
                total_txs = transactions.get('total', len(tx_list))
            elif 'data' in transactions and 'transactions' in transactions['data']:
                tx_list = transactions['data'].get('transactions', [])
                total_txs = transactions['data'].get('total', len(tx_list))
        elif isinstance(transactions, list):
            tx_list = transactions
            total_txs = len(transactions)
            
        total_pages = math.ceil(total_txs / txs_per_page)
        
        return render_template(
            'address.html',
            site_name=EXPLORER_NAME,
            address=address,
            balance=balance,
            transactions=tx_list,
            page=page,
            total_pages=total_pages,
            page_type='address',
            page_param=address
        )
    except Exception as e:
        logging.error(f"Error loading address {address}: {e}")
        return render_template(
            'error.html',
            site_name=EXPLORER_NAME,
            message=f"Error loading address {address}",
            page='explorer'
        )

@app.route('/explorer/search', methods=['POST'])
def search():
    """Search for block, transaction, or address."""
    query = request.form.get('query', '').strip()
    
    if not query:
        return redirect(url_for('explorer'))
    
    # Try to determine what the query is
    if query.isdigit():
        # Assume it's a block height
        return redirect(url_for('block_detail', height=int(query)))
    elif len(query) == 64 and all(c in '0123456789abcdefABCDEF' for c in query):
        # Assume it's a transaction hash
        return redirect(url_for('transaction_detail', tx_hash=query))
    else:
        # Assume it's an address
        return redirect(url_for('address_detail', address=query))

@app.route('/statistics')
def statistics():
    """Network statistics page."""
    try:
        # Get blockchain stats
        blockchain_info = get_blockchain_info()
        
        # Get other network stats
        network_stats = get_network_stats()
        
        # Get chart data for visualizations
        chart_data = get_chart_data()
        
        return render_template(
            'statistics.html',
            site_name=SITE_NAME,
            blockchain_info=blockchain_info,
            network_stats=network_stats,
            chart_data=chart_data
        )
    except Exception as e:
        logging.error(f"Error loading statistics: {e}")
        return render_template(
            'error.html',
            site_name=SITE_NAME,
            message="Could not load network statistics"
        )

@app.route('/nodes')
def nodes():
    """Network nodes/peers page."""
    try:
        # Get peers list
        peers_raw = get_peers()
        
        # Format peers data for display
        peers_data = []
        
        # Handle different response formats
        if isinstance(peers_raw, dict):
            for peer, last_seen in peers_raw.items():
                # Calculate success rate and status
                # For real data, these would come from the API
                success_rate = 95  # Placeholder
                is_active = True if isinstance(last_seen, (int, float)) and last_seen < 300 else False
                
                # Format time ago
                last_seen_ago = format_time_ago(time.time() - last_seen) if isinstance(last_seen, (int, float)) else "Unknown"
                
                peers_data.append({
                    "address": peer,
                    "last_seen": last_seen_ago,
                    "success_rate": success_rate,
                    "is_active": is_active
                })
        
        return render_template(
            'peers.html',
            site_name=SITE_NAME,
            peers=peers_data
        )
    except Exception as e:
        logging.error(f"Error loading nodes: {e}")
        return render_template(
            'error.html',
            site_name=SITE_NAME,
            message="Could not load network nodes information"
        )

@app.route('/node/dashboard')
def node_dashboard():
    """Node dashboard for node operators."""
    try:
        # Get node specific information
        system_info = get_system_info()
        blockchain_info = get_blockchain_info()
        system_stats = get_system_stats()
        chart_data = get_chart_data()
        
        return render_template(
            'dashboard.html',
            site_name=SITE_NAME,
            system_info=system_info,
            blockchain_info=blockchain_info,
            system_stats=system_stats,
            chart_data=chart_data
        )
    except Exception as e:
        logging.error(f"Error loading node dashboard: {e}")
        return render_template(
            'error.html',
            site_name=SITE_NAME,
            message="Could not load node dashboard"
        )

@app.route('/documentation')
def documentation():
    """Documentation page."""
    return render_template('documentation.html', site_name=SITE_NAME)

@app.route('/api/docs')
def api_docs():
    """API documentation page."""
    return render_template('api_docs.html', site_name=SITE_NAME)

# ===== Formatting Helper Functions =====

def format_block_for_display(block):
    """Format block data for display."""
    if not block:
        return {}
        
    # Format timestamp
    if "timestamp" in block:
        block["time"] = format_timestamp(block["timestamp"])
        block["time_ago"] = format_time_ago(block["timestamp"])
    
    # Format transactions
    if "transactions" in block:
        for tx in block["transactions"]:
            if "sender" in tx:
                tx["sender_short"] = format_address(tx["sender"])
            if "recipient" in tx:
                tx["recipient_short"] = format_address(tx["recipient"])
    
    # Format producer
    if "producer" in block:
        block["producer_short"] = format_address(block["producer"])
    
    return block

def format_transaction_for_display(tx):
    """Format transaction data for display."""
    if not tx:
        return {}
    
    # Format addresses
    if "sender" in tx:
        tx["sender_short"] = format_address(tx["sender"])
    if "recipient" in tx:
        tx["recipient_short"] = format_address(tx["recipient"])
    
    # Format block time if available
    if "block_time" in tx:
        tx["time"] = format_timestamp(tx["block_time"])
        tx["time_ago"] = format_time_ago(tx["block_time"])
    elif "timestamp" in tx:
        tx["time"] = format_timestamp(tx["timestamp"])
        tx["time_ago"] = format_time_ago(tx["timestamp"])
    
    # Add confirmations if not present but we have block height
    if "confirmations" not in tx and "block_height" in tx:
        blockchain_info = get_blockchain_info()
        current_height = blockchain_info.get("height", 0)
        tx["confirmations"] = max(0, current_height - tx["block_height"] + 1)
    
    return tx

# ===== Error Handlers =====

@app.errorhandler(404)
def page_not_found(e):
    return render_template('error.html', site_name=SITE_NAME, message="Page not found"), 404

@app.errorhandler(500)
def server_error(e):
    return render_template('error.html', site_name=SITE_NAME, message="Internal server error"), 500

# ===== Route for node activation page ===== 
@app.route('/activate')
def activate_page():
    """Activation page"""
    return render_template('activation-page.html', site_name=SITE_NAME)

# ===== Main =====

if __name__ == "__main__":
    # Get port from environment or use default
    port = int(os.environ.get('PORT', 8080))
    
    # Get debug mode from environment or use default
    debug = os.environ.get('FLASK_DEBUG', 'false').lower() == 'true'
    
    # Log application startup
    logging.info(f"Starting QNet Website on port {port}")
    logging.info(f"Connecting to node API at {NODE_API_URL}")
    logging.info(f"Debug mode: {debug}")
    
    # Start the Flask app
    app.run(host="0.0.0.0", port=port, debug=debug)