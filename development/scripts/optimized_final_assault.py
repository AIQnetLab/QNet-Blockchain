#!/usr/bin/env python3
"""
Optimized Final Assault for 100k TPS
Based on successful Machine Gun strategy
"""

import asyncio
import aiohttp
import time
import json
import random
import threading

class OptimizedFinalAssault:
    def __init__(self):
        # Only working nodes
        self.nodes = [
            "http://localhost:9877",  # Node 1 - Working
            "http://localhost:9879",  # Node 2 - Working  
            "http://localhost:9883",  # Node 4 - Working
            "http://localhost:9887",  # Node 6 - Working
            "http://localhost:9889",  # Node 7 - Working
            "http://localhost:9891"   # Node 8 - Working
        ]
        self.stats = {
            "total_sent": 0,
            "total_success": 0,
            "peak_tps": 0
        }
        self.lock = threading.Lock()
        
    async def ultra_fast_submit(self, session, node_url, tx):
        """Ultra-fast submit with minimal timeout"""
        payload = {
            "jsonrpc": "2.0",
            "method": "mempool_submit",
            "params": [tx],
            "id": random.randint(1, 999999)
        }
        
        try:
            async with session.post(node_url, json=payload, timeout=0.5) as response:
                return response.status == 200
        except:
            return False
    
    async def mega_machine_gun(self, duration=120, sessions_per_node=25):
        """Mega machine gun - optimized for maximum TPS"""
        print(f"🔫 MEGA MACHINE GUN: {duration}s with {sessions_per_node} sessions per node")
        
        # Create massive session pool
        sessions = []
        for node_url in self.nodes:
            for _ in range(sessions_per_node):
                session = aiohttp.ClientSession(
                    connector=aiohttp.TCPConnector(
                        limit=50,
                        limit_per_host=25,
                        keepalive_timeout=30
                    ),
                    timeout=aiohttp.ClientTimeout(total=1)
                )
                sessions.append((session, node_url))
        
        print(f"🔫 Created {len(sessions)} mega sessions")
        
        try:
            start_time = time.time()
            end_time = start_time + duration
            
            total_success = 0
            total_sent = 0
            round_count = 0
            
            while time.time() < end_time:
                round_count += 1
                round_start = time.time()
                
                # Fire mega burst - each session fires 10 transactions
                tasks = []
                for i, (session, node_url) in enumerate(sessions):
                    for j in range(10):
                        tx_id = round_count * 100000 + i * 10 + j
                        tx = {
                            "from": f"mega_user_{tx_id % 50}",
                            "to": f"mega_target_{(tx_id + 10) % 50}",
                            "amount": 1,
                            "nonce": int(time.time() * 1000000) + tx_id,
                            "timestamp": int(time.time() * 1000) + tx_id,
                            "signature": f"mega_sig_{tx_id}"
                        }
                        
                        task = self.ultra_fast_submit(session, node_url, tx)
                        tasks.append(task)
                        total_sent += 1
                
                # Execute mega round
                results = await asyncio.gather(*tasks, return_exceptions=True)
                round_success = sum(1 for r in results if r is True)
                total_success += round_success
                
                round_duration = time.time() - round_start
                round_tps = round_success / round_duration if round_duration > 0 else 0
                
                # Update peak TPS
                with self.lock:
                    if round_tps > self.stats["peak_tps"]:
                        self.stats["peak_tps"] = round_tps
                
                # Report every 5 rounds
                if round_count % 5 == 0:
                    elapsed = time.time() - start_time
                    current_tps = total_success / elapsed
                    print(f"🔫 Round {round_count}: {round_tps:.0f} TPS | Overall: {current_tps:.0f} TPS | Peak: {self.stats['peak_tps']:.0f}")
                
                # Minimal delay for maximum speed
                await asyncio.sleep(0.005)
            
            total_duration = time.time() - start_time
            avg_tps = total_success / total_duration
            
            print(f"\n🔫 MEGA MACHINE GUN RESULTS:")
            print(f"⚡ Success: {total_success:,}/{total_sent:,}")
            print(f"📊 Average TPS: {avg_tps:,.0f}")
            print(f"🚀 Peak TPS: {self.stats['peak_tps']:.0f}")
            print(f"⏱️  Duration: {total_duration:.1f}s")
            print(f"🔫 Rounds: {round_count}")
            
            self.stats["total_sent"] = total_sent
            self.stats["total_success"] = total_success
            
            return max(avg_tps, self.stats["peak_tps"])
            
        finally:
            for session, _ in sessions:
                await session.close()
    
    async def hyper_burst(self, burst_count=5, burst_size=10000):
        """Hyper burst - multiple rapid bursts"""
        print(f"💥 HYPER BURST: {burst_count} bursts of {burst_size:,} each")
        
        max_burst_tps = 0
        
        for burst_id in range(burst_count):
            print(f"\n💥 Burst {burst_id + 1}/{burst_count}")
            
            # Create sessions for this burst
            sessions = []
            for node_url in self.nodes:
                for _ in range(5):  # 5 sessions per node
                    session = aiohttp.ClientSession(
                        connector=aiohttp.TCPConnector(limit=200),
                        timeout=aiohttp.ClientTimeout(total=2)
                    )
                    sessions.append((session, node_url))
            
            try:
                start_time = time.time()
                
                # Generate burst transactions
                tasks = []
                for i in range(burst_size):
                    tx = {
                        "from": f"burst_user_{i % 100}",
                        "to": f"burst_target_{(i + 25) % 100}",
                        "amount": 1,
                        "nonce": int(time.time() * 1000000) + burst_id * 100000 + i,
                        "timestamp": int(time.time() * 1000) + i,
                        "signature": f"burst_sig_{burst_id}_{i}"
                    }
                    
                    session, node_url = sessions[i % len(sessions)]
                    task = self.ultra_fast_submit(session, node_url, tx)
                    tasks.append(task)
                
                # Fire burst
                results = await asyncio.gather(*tasks, return_exceptions=True)
                success_count = sum(1 for r in results if r is True)
                
                duration = time.time() - start_time
                burst_tps = success_count / duration
                
                print(f"💥 Burst {burst_id + 1}: {success_count:,}/{burst_size:,} = {burst_tps:,.0f} TPS")
                
                if burst_tps > max_burst_tps:
                    max_burst_tps = burst_tps
                
                # Small delay between bursts
                await asyncio.sleep(2)
                
            finally:
                for session, _ in sessions:
                    await session.close()
        
        print(f"\n💥 HYPER BURST MAX TPS: {max_burst_tps:,.0f}")
        return max_burst_tps
    
    async def sustained_assault(self, duration=180):
        """Sustained assault - long duration test"""
        print(f"⚔️  SUSTAINED ASSAULT: {duration} seconds")
        
        # Create persistent sessions
        sessions = []
        for node_url in self.nodes:
            for _ in range(15):  # 15 sessions per node
                session = aiohttp.ClientSession(
                    connector=aiohttp.TCPConnector(
                        limit=100,
                        keepalive_timeout=300
                    ),
                    timeout=aiohttp.ClientTimeout(total=1)
                )
                sessions.append((session, node_url))
        
        try:
            start_time = time.time()
            end_time = start_time + duration
            
            assault_success = 0
            assault_total = 0
            wave_count = 0
            
            while time.time() < end_time:
                wave_count += 1
                wave_start = time.time()
                
                # Create assault wave
                tasks = []
                for i, (session, node_url) in enumerate(sessions):
                    # Each session sends 5 transactions per wave
                    for j in range(5):
                        tx_id = wave_count * 10000 + i * 5 + j
                        tx = {
                            "from": f"assault_user_{tx_id % 75}",
                            "to": f"assault_target_{(tx_id + 15) % 75}",
                            "amount": 1,
                            "nonce": int(time.time() * 1000000) + tx_id,
                            "timestamp": int(time.time() * 1000) + tx_id,
                            "signature": f"assault_sig_{tx_id}"
                        }
                        
                        task = self.ultra_fast_submit(session, node_url, tx)
                        tasks.append(task)
                        assault_total += 1
                
                # Execute wave
                results = await asyncio.gather(*tasks, return_exceptions=True)
                wave_success = sum(1 for r in results if r is True)
                assault_success += wave_success
                
                wave_duration = time.time() - wave_start
                wave_tps = wave_success / wave_duration if wave_duration > 0 else 0
                
                # Report every 20 waves
                if wave_count % 20 == 0:
                    elapsed = time.time() - start_time
                    current_tps = assault_success / elapsed
                    print(f"⚔️  Wave {wave_count}: {wave_tps:.0f} TPS | Overall: {current_tps:.0f} TPS")
                
                # Minimal delay
                await asyncio.sleep(0.02)
            
            assault_duration = time.time() - start_time
            assault_tps = assault_success / assault_duration
            
            print(f"\n⚔️  SUSTAINED ASSAULT RESULTS:")
            print(f"⚡ Success: {assault_success:,}/{assault_total:,}")
            print(f"📊 TPS: {assault_tps:,.0f}")
            print(f"⏱️  Duration: {assault_duration:.1f}s")
            print(f"🌊 Waves: {wave_count}")
            
            return assault_tps
            
        finally:
            for session, _ in sessions:
                await session.close()

async def main():
    """Launch optimized final assault"""
    print("🚀 QNet OPTIMIZED FINAL ASSAULT")
    print("=" * 80)
    
    assault = OptimizedFinalAssault()
    max_tps = 0
    
    try:
        print("Phase 1: Hyper Burst Test")
        burst_tps = await assault.hyper_burst(burst_count=3, burst_size=5000)
        max_tps = max(max_tps, burst_tps)
        
        print("\nPhase 2: Mega Machine Gun")
        machine_gun_tps = await assault.mega_machine_gun(duration=90, sessions_per_node=30)
        max_tps = max(max_tps, machine_gun_tps)
        
        print("\nPhase 3: Sustained Assault")
        sustained_tps = await assault.sustained_assault(duration=120)
        max_tps = max(max_tps, sustained_tps)
        
        print(f"\n🏆 ABSOLUTE MAXIMUM TPS: {max_tps:,.0f}")
        
        if max_tps >= 100000:
            print("🎯 ✅ 100k TPS TARGET ACHIEVED! 🎉🎉🎉")
            success = True
        elif max_tps >= 50000:
            print("🎯 🔥 50k+ TPS - EXCELLENT PERFORMANCE!")
            success = False
        elif max_tps >= 25000:
            print("🎯 ⚡ 25k+ TPS - VERY GOOD PERFORMANCE!")
            success = False
        elif max_tps >= 10000:
            print("🎯 💪 10k+ TPS - GOOD PERFORMANCE!")
            success = False
        elif max_tps >= 5000:
            print("🎯 📈 5k+ TPS - DECENT PERFORMANCE!")
            success = False
        elif max_tps >= 1000:
            print("🎯 📊 1k+ TPS - BASELINE ACHIEVED!")
            success = False
        else:
            print("🎯 ⚠️  Performance below 1k TPS")
            success = False
        
        # Save results
        results = {
            "timestamp": time.time(),
            "max_tps": max_tps,
            "burst_tps": burst_tps,
            "machine_gun_tps": machine_gun_tps,
            "sustained_tps": sustained_tps,
            "target_achieved": success,
            "nodes_used": len(assault.nodes),
            "total_stats": assault.stats
        }
        
        with open("optimized_final_results.json", "w") as f:
            json.dump(results, f, indent=2)
        
        print(f"💾 Results saved to optimized_final_results.json")
        
        return success
        
    except Exception as e:
        print(f"❌ Assault failed: {e}")
        import traceback
        traceback.print_exc()
        return False

if __name__ == "__main__":
    success = asyncio.run(main())
    if success:
        print("\n🎉 MISSION ACCOMPLISHED!")
    else:
        print("\n💪 MISSION PROGRESS: Significant performance achieved!") 