#!/usr/bin/env python3
"""
Batch transaction test for QNet microblocks
Uses mempool_submit for batch processing
"""

import requests
import json
import time
import asyncio
import aiohttp
from datetime import datetime
import sys
import random
import string
import concurrent.futures

class BatchMicroblockTester:
    def __init__(self, rpc_url="http://localhost:8545/rpc"):
        self.rpc_url = rpc_url
        self.start_time = None
        self.tx_count = 0
        self.error_count = 0
        self.test_accounts = self.generate_test_accounts(10000)
        
    def generate_test_accounts(self, count):
        """Generate test account addresses"""
        accounts = []
        for i in range(count):
            addr = ''.join(random.choices(string.ascii_lowercase + string.digits, k=40))
            accounts.append(f"test_{addr}")
        return accounts
    
    async def submit_batch_async(self, session, batch_size=100):
        """Submit a batch of transactions asynchronously"""
        transactions = []
        
        for _ in range(batch_size):
            from_addr = random.choice(self.test_accounts)
            to_addr = random.choice(self.test_accounts)
            while to_addr == from_addr:
                to_addr = random.choice(self.test_accounts)
            
            tx = {
                "from": from_addr,
                "to": to_addr,
                "amount": random.randint(1, 1000),
                "nonce": random.randint(0, 1000000),
                "timestamp": int(time.time() * 1000)
            }
            transactions.append(tx)
        
        payload = {
            "jsonrpc": "2.0",
            "method": "mempool_submit",
            "params": transactions,
            "id": random.randint(1, 1000000)
        }
        
        start = time.time()
        try:
            async with session.post(self.rpc_url, json=payload, timeout=30) as response:
                result = await response.json()
                elapsed = time.time() - start
                
                if "error" not in result:
                    self.tx_count += batch_size
                    return True, elapsed
                else:
                    self.error_count += batch_size
                    print(f"Error: {result['error']}")
                    return False, elapsed
        except Exception as e:
            self.error_count += batch_size
            elapsed = time.time() - start
            print(f"Exception: {e}")
            return False, elapsed
    
    async def run_async_test(self, duration_seconds=60, concurrent_batches=50, batch_size=100):
        """Run asynchronous performance test"""
        print(f"\n🚀 Starting Batch Microblock Performance Test")
        print(f"Duration: {duration_seconds} seconds")
        print(f"Concurrent batches: {concurrent_batches}")
        print(f"Batch size: {batch_size} transactions")
        print(f"Target: {concurrent_batches * batch_size} TPS")
        print("-" * 60)
        
        self.start_time = time.time()
        total_batches = 0
        
        async with aiohttp.ClientSession() as session:
            while time.time() - self.start_time < duration_seconds:
                # Submit multiple batches concurrently
                tasks = []
                for _ in range(concurrent_batches):
                    task = self.submit_batch_async(session, batch_size)
                    tasks.append(task)
                
                # Wait for all batches to complete
                results = await asyncio.gather(*tasks)
                total_batches += len(results)
                
                # Calculate current TPS
                elapsed = time.time() - self.start_time
                current_tps = self.tx_count / elapsed if elapsed > 0 else 0
                
                print(f"\r⏱️  Time: {elapsed:.0f}s | "
                      f"✅ TX: {self.tx_count} | "
                      f"❌ Errors: {self.error_count} | "
                      f"📊 TPS: {current_tps:.0f} | "
                      f"📦 Batches: {total_batches}", end='', flush=True)
                
                # Small delay to prevent overwhelming
                await asyncio.sleep(0.1)
        
        self.print_results()
    
    def print_results(self):
        """Print test results"""
        print("\n\n" + "="*60)
        print("📊 BATCH PERFORMANCE TEST RESULTS")
        print("="*60)
        
        total_time = time.time() - self.start_time
        total_tps = self.tx_count / total_time if total_time > 0 else 0
        success_rate = (self.tx_count / (self.tx_count + self.error_count) * 100) if (self.tx_count + self.error_count) > 0 else 0
        
        print(f"Test Duration: {total_time:.2f} seconds")
        print(f"Total Transactions Submitted: {self.tx_count + self.error_count}")
        print(f"Successful Transactions: {self.tx_count}")
        print(f"Failed Transactions: {self.error_count}")
        print(f"Success Rate: {success_rate:.2f}%")
        
        print(f"\n🎯 PERFORMANCE:")
        print(f"Average TPS: {total_tps:.0f}")
        
        print(f"\n🏁 VERDICT:")
        if total_tps >= 10000:
            print(f"✅ SUCCESS! Achieved {total_tps:.0f} TPS (Target: 10,000 TPS)")
        else:
            print(f"❌ FAILED! Only achieved {total_tps:.0f} TPS (Target: 10,000 TPS)")
            print(f"   Need {(10000/total_tps):.1f}x improvement")

async def main():
    if len(sys.argv) > 1:
        rpc_url = sys.argv[1]
    else:
        rpc_url = "http://localhost:8545/rpc"
    
    tester = BatchMicroblockTester(rpc_url)
    
    # Run with different configurations to find optimal settings
    print("Testing different configurations...")
    
    # Test 1: High concurrency, small batches
    await tester.run_async_test(duration_seconds=30, concurrent_batches=100, batch_size=100)
    
    # Reset counters
    tester.tx_count = 0
    tester.error_count = 0
    
    # Test 2: Medium concurrency, large batches  
    print("\n\nTrying larger batches...")
    await tester.run_async_test(duration_seconds=30, concurrent_batches=20, batch_size=500)

if __name__ == "__main__":
    asyncio.run(main()) 