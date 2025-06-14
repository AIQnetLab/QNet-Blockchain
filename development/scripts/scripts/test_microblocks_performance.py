#!/usr/bin/env python3
"""
Performance test for QNet microblocks
Goal: Achieve 10,000 TPS
"""

import requests
import json
import time
import threading
import statistics
from datetime import datetime
import sys
import random
import string

class MicroblockPerformanceTester:
    def __init__(self, rpc_url="http://localhost:8545/rpc"):
        self.rpc_url = rpc_url
        self.results = []
        self.start_time = None
        self.stop_flag = False
        self.tx_count = 0
        self.error_count = 0
        self.initial_height = 0
        self.test_accounts = self.generate_test_accounts(1000)
        
    def generate_test_accounts(self, count):
        """Generate test account addresses"""
        accounts = []
        for i in range(count):
            # Generate random addresses
            addr = ''.join(random.choices(string.ascii_lowercase + string.digits, k=40))
            accounts.append(f"test_{addr}")
        return accounts
    
    def rpc_call(self, method, params=None):
        """Make RPC call to node"""
        payload = {
            "jsonrpc": "2.0",
            "method": method,
            "params": params or [],
            "id": 1
        }
        
        try:
            response = requests.post(self.rpc_url, json=payload, timeout=5)
            result = response.json()
            if "error" in result:
                return None, result["error"]
            return result.get("result"), None
        except Exception as e:
            return None, str(e)
    
    def get_chain_height(self):
        """Get current blockchain height"""
        result, error = self.rpc_call("chain_getHeight")
        if error:
            return 0
        return result.get("height", 0) if result else 0
    
    def submit_transaction(self, from_addr, to_addr, amount):
        """Submit a transaction"""
        params = {
            "from": from_addr,
            "to": to_addr,
            "amount": amount,
            "gas_price": 1,
            "gas_limit": 21000
        }
        
        start = time.time()
        result, error = self.rpc_call("tx_submit", params)
        elapsed = time.time() - start
        
        return {
            "success": error is None,
            "time": elapsed,
            "error": error,
            "hash": result.get("hash") if result else None
        }
    
    def transaction_sender(self, thread_id, transactions_per_thread):
        """Thread function to send transactions"""
        print(f"Thread {thread_id} starting to send {transactions_per_thread} transactions...")
        
        for i in range(transactions_per_thread):
            if self.stop_flag:
                break
                
            # Random from/to addresses
            from_addr = random.choice(self.test_accounts)
            to_addr = random.choice(self.test_accounts)
            while to_addr == from_addr:
                to_addr = random.choice(self.test_accounts)
            
            amount = random.randint(1, 1000)
            
            result = self.submit_transaction(from_addr, to_addr, amount)
            
            self.results.append(result)
            if result["success"]:
                self.tx_count += 1
            else:
                self.error_count += 1
                
            # Small delay to prevent overwhelming the node
            time.sleep(0.001)  # 1ms delay
    
    def run_performance_test(self, duration_seconds=60, num_threads=10):
        """Run the performance test"""
        print(f"\n🚀 Starting Microblock Performance Test")
        print(f"Duration: {duration_seconds} seconds")
        print(f"Threads: {num_threads}")
        print(f"RPC URL: {self.rpc_url}")
        print("-" * 60)
        
        # Check if microblocks are enabled
        self.initial_height = self.get_chain_height()
        print(f"Initial blockchain height: {self.initial_height}")
        
        # Calculate transactions per thread
        target_total_tx = 10000 * duration_seconds  # Target 10K TPS
        tx_per_thread = target_total_tx // num_threads
        
        print(f"Target: {target_total_tx} total transactions ({10000} TPS)")
        print(f"Each thread will send: {tx_per_thread} transactions")
        print("-" * 60)
        
        self.start_time = time.time()
        
        # Start transaction sender threads
        threads = []
        for i in range(num_threads):
            thread = threading.Thread(
                target=self.transaction_sender,
                args=(i, tx_per_thread)
            )
            thread.start()
            threads.append(thread)
        
        # Monitor progress
        print("\nProgress:")
        last_tx_count = 0
        while time.time() - self.start_time < duration_seconds:
            time.sleep(5)  # Update every 5 seconds
            
            elapsed = time.time() - self.start_time
            current_tps = self.tx_count / elapsed if elapsed > 0 else 0
            instant_tps = (self.tx_count - last_tx_count) / 5
            last_tx_count = self.tx_count
            
            current_height = self.get_chain_height()
            blocks_created = current_height - self.initial_height
            
            print(f"\r⏱️  Time: {elapsed:.0f}s | "
                  f"✅ TX: {self.tx_count} | "
                  f"❌ Errors: {self.error_count} | "
                  f"📊 Avg TPS: {current_tps:.0f} | "
                  f"⚡ Instant TPS: {instant_tps:.0f} | "
                  f"🔗 Blocks: {blocks_created}", end='', flush=True)
        
        # Stop threads
        self.stop_flag = True
        for thread in threads:
            thread.join()
        
        # Final results
        self.print_results(duration_seconds)
    
    def print_results(self, duration):
        """Print test results"""
        print("\n\n" + "="*60)
        print("📊 PERFORMANCE TEST RESULTS")
        print("="*60)
        
        total_time = time.time() - self.start_time
        final_height = self.get_chain_height()
        blocks_created = final_height - self.initial_height
        
        # Calculate statistics
        successful_results = [r for r in self.results if r["success"]]
        if successful_results:
            response_times = [r["time"] * 1000 for r in successful_results]  # Convert to ms
            avg_response = statistics.mean(response_times)
            min_response = min(response_times)
            max_response = max(response_times)
            p95_response = statistics.quantiles(response_times, n=20)[18] if len(response_times) > 20 else max_response
        else:
            avg_response = min_response = max_response = p95_response = 0
        
        # Overall statistics
        total_tps = self.tx_count / total_time if total_time > 0 else 0
        success_rate = (self.tx_count / len(self.results) * 100) if self.results else 0
        
        print(f"Test Duration: {total_time:.2f} seconds")
        print(f"Total Transactions Sent: {len(self.results)}")
        print(f"Successful Transactions: {self.tx_count}")
        print(f"Failed Transactions: {self.error_count}")
        print(f"Success Rate: {success_rate:.2f}%")
        print(f"\n🎯 PERFORMANCE METRICS:")
        print(f"Average TPS: {total_tps:.0f}")
        print(f"Blocks Created: {blocks_created}")
        print(f"Avg Block Time: {total_time/blocks_created:.2f}s" if blocks_created > 0 else "N/A")
        print(f"TX per Block: {self.tx_count/blocks_created:.0f}" if blocks_created > 0 else "N/A")
        print(f"\n⏱️  RESPONSE TIMES:")
        print(f"Average: {avg_response:.2f} ms")
        print(f"Min: {min_response:.2f} ms")
        print(f"Max: {max_response:.2f} ms")
        print(f"P95: {p95_response:.2f} ms")
        
        # Performance verdict
        print(f"\n🏁 VERDICT:")
        if total_tps >= 10000:
            print(f"✅ SUCCESS! Achieved {total_tps:.0f} TPS (Target: 10,000 TPS)")
        else:
            print(f"❌ FAILED! Only achieved {total_tps:.0f} TPS (Target: 10,000 TPS)")
            print(f"   Need {(10000/total_tps):.1f}x improvement")
        
        # Error analysis
        if self.error_count > 0:
            print(f"\n⚠️  ERROR ANALYSIS:")
            error_types = {}
            for r in self.results:
                if not r["success"] and r["error"]:
                    error_msg = str(r["error"])
                    error_types[error_msg] = error_types.get(error_msg, 0) + 1
            
            for error, count in sorted(error_types.items(), key=lambda x: x[1], reverse=True)[:5]:
                print(f"  - {error}: {count} times")

def main():
    if len(sys.argv) > 1:
        rpc_url = sys.argv[1]
    else:
        rpc_url = "http://localhost:8545/rpc"
    
    tester = MicroblockPerformanceTester(rpc_url)
    
    # Run performance test
    tester.run_performance_test(duration_seconds=60, num_threads=20)

if __name__ == "__main__":
    main() 