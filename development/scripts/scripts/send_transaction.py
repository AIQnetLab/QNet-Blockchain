#!/usr/bin/env python3
"""
Send transaction to QNet blockchain
"""

import json
import urllib.request
import sys
import time

def call_rpc(method, params=None, port=9877):
    """Call RPC method"""
    url = f"http://localhost:{port}/rpc"
    data = {
        "jsonrpc": "2.0",
        "method": method,
        "params": params or {},
        "id": 1
    }
    
    req = urllib.request.Request(
        url,
        data=json.dumps(data).encode('utf-8'),
        headers={'Content-Type': 'application/json'}
    )
    
    try:
        with urllib.request.urlopen(req) as response:
            result = json.loads(response.read().decode('utf-8'))
            return result
    except Exception as e:
        print(f"Error: {e}")
        return None

def send_transaction(from_addr, to_addr, amount, port=9877):
    """Send a transaction"""
    print(f"\nSending {amount} QNC from {from_addr} to {to_addr}...")
    
    # Submit transaction
    result = call_rpc("tx_submit", {
        "from_address": from_addr,
        "to_address": to_addr,
        "amount": float(amount),
        "gas_price": 1,
        "gas_limit": 21000
    }, port)
    
    if result and 'result' in result:
        tx_hash = result['result'].get('hash', 'unknown')
        print(f"Transaction submitted! Hash: {tx_hash}")
        return tx_hash
    else:
        print("Failed to submit transaction")
        return None

def check_balance(address, port=9877):
    """Check account balance"""
    result = call_rpc("account_getBalance", {"address": address}, port)
    if result and 'result' in result:
        return result['result'].get('balance', 0)
    return 0

def main():
    if len(sys.argv) < 4:
        print("Usage: python send_transaction.py <from> <to> <amount> [port]")
        print("Example: python send_transaction.py alice bob 100")
        sys.exit(1)
    
    from_addr = sys.argv[1]
    to_addr = sys.argv[2]
    amount = int(sys.argv[3])
    port = int(sys.argv[4]) if len(sys.argv) > 4 else 9877
    
    # Check initial balances
    print(f"\nChecking balances on node (port {port})...")
    from_balance = check_balance(from_addr, port)
    to_balance = check_balance(to_addr, port)
    
    print(f"{from_addr}: {from_balance} QNC")
    print(f"{to_addr}: {to_balance} QNC")
    
    # Send transaction
    tx_hash = send_transaction(from_addr, to_addr, amount, port)
    
    if tx_hash:
        # Wait a bit
        print("\nWaiting for transaction to be processed...")
        time.sleep(5)
        
        # Check final balances
        print("\nChecking final balances...")
        from_balance_new = check_balance(from_addr, port)
        to_balance_new = check_balance(to_addr, port)
        
        print(f"{from_addr}: {from_balance_new} QNC (was {from_balance})")
        print(f"{to_addr}: {to_balance_new} QNC (was {to_balance})")
        
        # Check mempool
        result = call_rpc("mempool_getTransactions", {}, port)
        if result and 'result' in result:
            mempool_size = len(result['result'])
            print(f"\nMempool has {mempool_size} pending transactions")

if __name__ == "__main__":
    main() 