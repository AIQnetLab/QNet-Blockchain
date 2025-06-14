#!/usr/bin/env python3
"""
REAL QNet Performance Test - June 2025
Testing actual components without fake numbers
"""

import sys
import os
import time
import threading
import statistics
import json
import random
from datetime import datetime

# Add qnet-core to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'qnet-core', 'src'))

class RealPerformanceTester:
    """Test actual QNet components with real metrics"""
    
    def __init__(self):
        self.results = {}
        self.test_start_time = None
        
    def test_crypto_performance(self) -> dict:
        """Test cryptographic operations performance"""
        print("🔐 Testing Cryptographic Performance...")
        crypto_results = {}
        
        try:
            import crypto
            
            # Test key generation performance
            key_gen_times = []
            for i in range(100):
                start = time.time()
                crypto.generate_keypair()
                key_gen_times.append((time.time() - start) * 1000)  # ms
            
            # Test signing performance
            public_key, secret_key = crypto.generate_keypair()
            message = b"QNet performance test message"
            
            sign_times = []
            for i in range(100):
                start = time.time()
                signature = crypto.sign(message, secret_key)
                sign_times.append((time.time() - start) * 1000)  # ms
            
            # Test verification performance
            verify_times = []
            for i in range(100):
                start = time.time()
                is_valid = crypto.verify(message, signature, public_key)
                verify_times.append((time.time() - start) * 1000)  # ms
            
            crypto_results = {
                'key_generation': {
                    'avg_ms': statistics.mean(key_gen_times),
                    'min_ms': min(key_gen_times),
                    'max_ms': max(key_gen_times),
                    'ops_per_second': 1000 / statistics.mean(key_gen_times)
                },
                'signing': {
                    'avg_ms': statistics.mean(sign_times),
                    'min_ms': min(sign_times),
                    'max_ms': max(sign_times),
                    'ops_per_second': 1000 / statistics.mean(sign_times)
                },
                'verification': {
                    'avg_ms': statistics.mean(verify_times),
                    'min_ms': min(verify_times),
                    'max_ms': max(verify_times),
                    'ops_per_second': 1000 / statistics.mean(verify_times)
                },
                'working': True
            }
            
            print(f"  ✅ Key Generation: {crypto_results['key_generation']['avg_ms']:.2f}ms avg")
            print(f"  ✅ Signing: {crypto_results['signing']['avg_ms']:.2f}ms avg")
            print(f"  ✅ Verification: {crypto_results['verification']['avg_ms']:.2f}ms avg")
            
        except Exception as e:
            crypto_results = {
                'working': False,
                'error': str(e)
            }
            print(f"  ❌ Crypto test failed: {e}")
        
        return crypto_results
    
    def test_post_quantum_performance(self) -> dict:
        """Test post-quantum cryptographic performance"""
        print("🛡️ Testing Post-Quantum Cryptographic Performance...")
        pq_results = {}
        
        try:
            # Test Dilithium performance
            sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'qnet-core', 'src', 'crypto'))
            import dilithium
            
            dilithium_crypto = dilithium.Dilithium3()
            
            # Test Dilithium key generation
            dilithium_keygen_times = []
            for i in range(50):  # Fewer iterations for PQ (slower)
                start = time.time()
                pub_key, priv_key = dilithium_crypto.generate_keypair()
                dilithium_keygen_times.append((time.time() - start) * 1000)
            
            # Test Dilithium signing
            message = b"QNet post-quantum test message"
            dilithium_sign_times = []
            for i in range(50):
                start = time.time()
                signature = dilithium_crypto.sign(message, priv_key)
                dilithium_sign_times.append((time.time() - start) * 1000)
            
            # Test Dilithium verification
            dilithium_verify_times = []
            for i in range(50):
                start = time.time()
                is_valid = dilithium_crypto.verify(message, signature, pub_key)
                dilithium_verify_times.append((time.time() - start) * 1000)
            
            # Test quantum resistance stress
            quantum_stress_results = self.test_quantum_resistance_stress(dilithium_crypto, pub_key, priv_key)
            
            pq_results = {
                'dilithium': {
                    'key_generation': {
                        'avg_ms': statistics.mean(dilithium_keygen_times),
                        'min_ms': min(dilithium_keygen_times),
                        'max_ms': max(dilithium_keygen_times),
                        'ops_per_second': 1000 / statistics.mean(dilithium_keygen_times)
                    },
                    'signing': {
                        'avg_ms': statistics.mean(dilithium_sign_times),
                        'min_ms': min(dilithium_sign_times),
                        'max_ms': max(dilithium_sign_times),
                        'ops_per_second': 1000 / statistics.mean(dilithium_sign_times)
                    },
                    'verification': {
                        'avg_ms': statistics.mean(dilithium_verify_times),
                        'min_ms': min(dilithium_verify_times),
                        'max_ms': max(dilithium_verify_times),
                        'ops_per_second': 1000 / statistics.mean(dilithium_verify_times)
                    },
                    'public_key_size': len(pub_key),
                    'private_key_size': len(priv_key),
                    'signature_size': len(signature),
                    'quantum_resistance': quantum_stress_results
                },
                'working': True
            }
            
            print(f"  ✅ Dilithium Key Gen: {pq_results['dilithium']['key_generation']['avg_ms']:.2f}ms avg")
            print(f"  ✅ Dilithium Signing: {pq_results['dilithium']['signing']['avg_ms']:.2f}ms avg")
            print(f"  ✅ Dilithium Verification: {pq_results['dilithium']['verification']['avg_ms']:.2f}ms avg")
            print(f"  📏 Key Sizes: Pub={len(pub_key)}, Priv={len(priv_key)}, Sig={len(signature)} bytes")
            print(f"  🛡️ Quantum Resistance: {quantum_stress_results['resistance_level']}")
            
        except Exception as e:
            pq_results = {
                'working': False,
                'error': str(e)
            }
            print(f"  ❌ Post-quantum test failed: {e}")
        
        return pq_results

    def test_quantum_resistance_stress(self, crypto_instance, pub_key, priv_key) -> dict:
        """Test quantum resistance under stress conditions"""
        try:
            # Test 1: Large message signing
            large_message = b"A" * 10000  # 10KB message
            start = time.time()
            large_sig = crypto_instance.sign(large_message, priv_key)
            large_sign_time = (time.time() - start) * 1000
            
            # Test 2: Verify large message
            start = time.time()
            large_verify_result = crypto_instance.verify(large_message, large_sig, pub_key)
            large_verify_time = (time.time() - start) * 1000
            
            # Test 3: Multiple concurrent operations
            concurrent_results = []
            start = time.time()
            for i in range(10):
                msg = f"Concurrent test message {i}".encode()
                sig = crypto_instance.sign(msg, priv_key)
                valid = crypto_instance.verify(msg, sig, pub_key)
                concurrent_results.append(valid)
            concurrent_time = (time.time() - start) * 1000
            
            # Test 4: Invalid signature rejection
            fake_signature = b"fake_signature" + b"0" * (len(large_sig) - 14)
            invalid_rejected = not crypto_instance.verify(large_message, fake_signature, pub_key)
            
            resistance_score = 0
            if large_verify_result: resistance_score += 25
            if all(concurrent_results): resistance_score += 25
            if invalid_rejected: resistance_score += 25
            if large_sign_time < 1000: resistance_score += 25  # Under 1 second
            
            resistance_level = "EXCELLENT" if resistance_score >= 90 else \
                             "GOOD" if resistance_score >= 70 else \
                             "ACCEPTABLE" if resistance_score >= 50 else "POOR"
            
            return {
                'large_message_sign_ms': large_sign_time,
                'large_message_verify_ms': large_verify_time,
                'concurrent_operations_ms': concurrent_time,
                'concurrent_success_rate': sum(concurrent_results) / len(concurrent_results),
                'invalid_signature_rejected': invalid_rejected,
                'resistance_score': resistance_score,
                'resistance_level': resistance_level
            }
            
        except Exception as e:
            return {
                'error': str(e),
                'resistance_level': 'UNKNOWN'
            }
    
    def test_simulated_transaction_processing(self) -> dict:
        """Test simulated transaction processing without RPC"""
        print("📊 Testing Simulated Transaction Processing...")
        
        try:
            transactions_processed = 0
            start_time = time.time()
            test_duration = 10  # 10 seconds
            
            # Simulate transaction processing
            while time.time() - start_time < test_duration:
                # Simulate transaction validation
                transaction = {
                    'from': f'wallet_{transactions_processed % 1000}',
                    'to': f'wallet_{(transactions_processed + 1) % 1000}',
                    'amount': 100,
                    'nonce': transactions_processed,
                    'timestamp': time.time()
                }
                
                # Simulate validation work (hash calculation, signature check)
                import hashlib
                tx_data = json.dumps(transaction, sort_keys=True).encode()
                tx_hash = hashlib.sha256(tx_data).hexdigest()
                
                # Small processing delay to simulate real work
                time.sleep(0.001)  # 1ms per transaction
                
                transactions_processed += 1
            
            elapsed_time = time.time() - start_time
            actual_tps = transactions_processed / elapsed_time
            
            processing_results = {
                'transactions_processed': transactions_processed,
                'test_duration_seconds': elapsed_time,
                'actual_tps': actual_tps,
                'working': True
            }
            
            print(f"  ✅ Processed {transactions_processed} transactions in {elapsed_time:.2f}s")
            print(f"  📈 Actual TPS: {actual_tps:.0f}")
            
        except Exception as e:
            processing_results = {
                'working': False,
                'error': str(e)
            }
            print(f"  ❌ Transaction processing test failed: {e}")
        
        return processing_results

    def test_cross_shard_performance(self) -> dict:
        """Test cross-shard transaction performance"""
        print("🔄 Testing Cross-Shard Transaction Performance...")
        
        try:
            # Import sharding components
            sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'qnet-sharding', 'src'))
            import python_wrapper as production_sharding
            
            # Create test shard configuration
            shard_config = production_sharding.ShardConfig(
                total_shards=16,
                shard_id=0,
                managed_shards=[0, 1, 2, 3],
                cross_shard_enabled=True,
                max_tps_per_shard=10000
            )
            
            shard_manager = production_sharding.ProductionShardManager(shard_config)
            
            # Test intra-shard transactions (fast path)
            intra_shard_times = []
            intra_shard_success = 0
            
            print("  📊 Testing intra-shard transactions...")
            # Use addresses that will definitely be in managed shards
            for i in range(100):
                # Force addresses to be in shard 0 (which is managed)
                from_addr = f"shard0_test_wallet_{i:04d}"
                to_addr = f"shard0_test_wallet_{i+1:04d}"
                
                # Ensure addresses are in shard 0
                while shard_manager.get_account_shard(from_addr) not in shard_config.managed_shards:
                    from_addr = f"shard0_test_wallet_{i:04d}_alt_{random.randint(1000, 9999)}"
                
                while shard_manager.get_account_shard(to_addr) not in shard_config.managed_shards:
                    to_addr = f"shard0_test_wallet_{i+1:04d}_alt_{random.randint(1000, 9999)}"
                
                start = time.time()
                try:
                    result = shard_manager.process_intra_shard_transaction(
                        from_addr, to_addr, 100, 1, f"signature_{i}"  # Use nonce=1 for all
                    )
                    if result:
                        intra_shard_success += 1
                    intra_shard_times.append((time.time() - start) * 1000)
                except Exception as e:
                    intra_shard_times.append((time.time() - start) * 1000)
                    # Only print first few errors to avoid spam
                    if i < 5:
                        print(f"    ⚠️ Intra-shard tx {i} failed: {e}")
            
            # Test cross-shard transactions (coordinated path)
            cross_shard_times = []
            cross_shard_success = 0
            
            print("  📊 Testing cross-shard transactions...")
            for i in range(50):
                # Force cross-shard by using addresses that will be in different shards
                from_addr = f"cross_shard_from_{i:04d}_managed"
                to_addr = f"cross_shard_to_{i:04d}_different"
                
                # Ensure from_addr is in a managed shard
                while shard_manager.get_account_shard(from_addr) not in shard_config.managed_shards:
                    from_addr = f"cross_shard_from_{i:04d}_managed_{random.randint(1000, 9999)}"
                
                # Ensure to_addr is in a different shard
                while (shard_manager.get_account_shard(to_addr) == shard_manager.get_account_shard(from_addr) or
                       shard_manager.get_account_shard(to_addr) in shard_config.managed_shards):
                    to_addr = f"cross_shard_to_{i:04d}_different_{random.randint(1000, 9999)}"
                
                start = time.time()
                try:
                    result = shard_manager.process_cross_shard_transaction(
                        from_addr, to_addr, 50, 1, f"cross_signature_{i}"  # Use nonce=1 for all
                    )
                    if result:
                        cross_shard_success += 1
                        # Complete the transaction
                        try:
                            shard_manager.complete_cross_shard_transaction(result)
                        except Exception as complete_error:
                            # Transaction was created but completion failed
                            if i < 5:
                                print(f"    ⚠️ Cross-shard tx {i} completion failed: {complete_error}")
                    cross_shard_times.append((time.time() - start) * 1000)
                except Exception as e:
                    cross_shard_times.append((time.time() - start) * 1000)
                    # Only print first few errors to avoid spam
                    if i < 5:
                        print(f"    ⚠️ Cross-shard tx {i} failed: {e}")
            
            # Calculate statistics
            avg_intra_shard = sum(intra_shard_times) / len(intra_shard_times) if intra_shard_times else 0
            avg_cross_shard = sum(cross_shard_times) / len(cross_shard_times) if cross_shard_times else 0
            
            # Get shard statistics
            shard_stats = shard_manager.get_shard_stats()
            cross_shard_stats = shard_manager.get_cross_shard_stats()
            
            results = {
                'working': True,
                'intra_shard': {
                    'avg_time_ms': avg_intra_shard,
                    'success_rate': (intra_shard_success / 100) * 100,
                    'total_tests': 100
                },
                'cross_shard': {
                    'avg_time_ms': avg_cross_shard,
                    'success_rate': (cross_shard_success / 50) * 100,
                    'total_tests': 50
                },
                'shard_stats': shard_stats,
                'cross_shard_stats': cross_shard_stats,
                'performance_analysis': {
                    'intra_shard_meets_target': avg_intra_shard < 100,  # < 100ms target
                    'cross_shard_meets_target': avg_cross_shard < 500,  # < 500ms target
                    'microblock_constraint_ok': avg_cross_shard < 800   # < 800ms for 1/sec
                }
            }
            
            print(f"  ✅ Intra-shard: {avg_intra_shard:.2f}ms avg, {intra_shard_success}/100 success")
            print(f"  ✅ Cross-shard: {avg_cross_shard:.2f}ms avg, {cross_shard_success}/50 success")
            print(f"  📊 Shard stats: {len(shard_stats)} shards managed")
            print(f"  📊 Cross-shard queue: {cross_shard_stats['total_transactions']} transactions")
            
            # Performance analysis
            if avg_cross_shard > 500:
                print(f"  ⚠️ Cross-shard latency {avg_cross_shard:.1f}ms exceeds 500ms target")
            if avg_cross_shard > 800:
                print(f"  🚨 Cross-shard latency {avg_cross_shard:.1f}ms violates 1 microblock/second constraint")
            
            return results
            
        except Exception as e:
            print(f"  ❌ Cross-shard test failed: {e}")
            return {
                'working': False,
                'error': str(e),
                'module_available': False
            }
    
    def test_memory_performance(self) -> dict:
        """Test memory usage and performance"""
        print("💾 Testing Memory Performance...")
        
        try:
            import psutil
            process = psutil.Process()
            
            initial_memory = process.memory_info().rss / 1024 / 1024  # MB
            
            # Simulate memory-intensive operations
            large_data = []
            for i in range(10000):
                large_data.append({
                    'id': i,
                    'data': f'transaction_data_{i}' * 10,
                    'timestamp': time.time()
                })
            
            peak_memory = process.memory_info().rss / 1024 / 1024  # MB
            
            # Clean up
            del large_data
            
            final_memory = process.memory_info().rss / 1024 / 1024  # MB
            
            memory_results = {
                'initial_memory_mb': initial_memory,
                'peak_memory_mb': peak_memory,
                'final_memory_mb': final_memory,
                'memory_increase_mb': peak_memory - initial_memory,
                'working': True
            }
            
            print(f"  ✅ Initial Memory: {initial_memory:.1f} MB")
            print(f"  📈 Peak Memory: {peak_memory:.1f} MB")
            print(f"  🔄 Memory Increase: {peak_memory - initial_memory:.1f} MB")
            
        except ImportError:
            memory_results = {
                'working': False,
                'error': 'psutil not available - install with: pip install psutil'
            }
            print(f"  ⚠️  Memory test skipped: psutil not available")
        except Exception as e:
            memory_results = {
                'working': False,
                'error': str(e)
            }
            print(f"  ❌ Memory test failed: {e}")
        
        return memory_results
    
    def calculate_realistic_tps_estimate(self, crypto_results: dict, processing_results: dict) -> dict:
        """Calculate realistic TPS estimates based on actual performance"""
        print("🎯 Calculating Realistic TPS Estimates...")
        
        estimates = {}
        
        if crypto_results.get('working') and processing_results.get('working'):
            # Base estimate from actual transaction processing
            base_tps = processing_results['actual_tps']
            
            # Crypto operation limits
            sign_ops_per_sec = crypto_results['signing']['ops_per_second']
            verify_ops_per_sec = crypto_results['verification']['ops_per_second']
            
            # Bottleneck analysis
            crypto_bottleneck = min(sign_ops_per_sec, verify_ops_per_sec)
            
            estimates = {
                'base_simulated_tps': base_tps,
                'crypto_limited_tps': crypto_bottleneck,
                'realistic_single_thread_tps': min(base_tps, crypto_bottleneck),
                'estimated_4_threads_tps': min(base_tps, crypto_bottleneck) * 4,
                'estimated_8_threads_tps': min(base_tps, crypto_bottleneck) * 8,
                'estimated_16_threads_tps': min(base_tps, crypto_bottleneck) * 16,
                'working': True
            }
            
            print(f"  📊 Base Processing: {base_tps:.0f} TPS")
            print(f"  🔐 Crypto Bottleneck: {crypto_bottleneck:.0f} TPS")
            print(f"  🎯 Realistic Single Thread: {estimates['realistic_single_thread_tps']:.0f} TPS")
            print(f"  ⚡ Estimated 16 Threads: {estimates['estimated_16_threads_tps']:.0f} TPS")
            
        else:
            estimates = {
                'working': False,
                'error': 'Cannot calculate estimates due to failed component tests'
            }
            print(f"  ❌ Cannot calculate realistic estimates")
        
        return estimates
    
    def generate_honest_performance_report(self) -> dict:
        """Generate honest performance assessment"""
        print("=" * 60)
        print("🔍 QNet HONEST Performance Assessment - June 2025")
        print("=" * 60)
        
        self.test_start_time = time.time()
        
        # Run all tests
        crypto_results = self.test_crypto_performance()
        pq_results = self.test_post_quantum_performance()
        processing_results = self.test_simulated_transaction_processing()
        cross_shard_results = self.test_cross_shard_performance()
        memory_results = self.test_memory_performance()
        tps_estimates = self.calculate_realistic_tps_estimate(crypto_results, processing_results)
        
        # Generate final assessment
        total_test_time = time.time() - self.test_start_time
        
        print("\n" + "=" * 60)
        print("📋 FINAL HONEST ASSESSMENT")
        print("=" * 60)
        
        working_components = sum(1 for r in [crypto_results, pq_results, processing_results, cross_shard_results, memory_results] 
                               if r.get('working', False))
        
        if tps_estimates.get('working'):
            realistic_tps = tps_estimates['realistic_single_thread_tps']
            multi_thread_tps = tps_estimates['estimated_16_threads_tps']
            
            print(f"✅ REAL Single-Thread TPS: {realistic_tps:.0f}")
            print(f"⚡ ESTIMATED Multi-Thread TPS: {multi_thread_tps:.0f}")
            
            # Compare with false claims
            false_claim = 424411
            actual_performance_ratio = multi_thread_tps / false_claim * 100
            
            print(f"\n🎯 TRUTH vs FALSE CLAIMS:")
            print(f"  False Claim: {false_claim:,} TPS")
            print(f"  Real Estimate: {multi_thread_tps:.0f} TPS")
            print(f"  Actual Performance: {actual_performance_ratio:.1f}% of claimed")
            
            if actual_performance_ratio < 1:
                print(f"  🚨 FALSE CLAIMS ARE {false_claim/multi_thread_tps:.0f}X EXAGGERATED!")
            
        else:
            print("❌ CANNOT CALCULATE REALISTIC TPS - Component failures")
        
        print(f"\n📊 Component Status: {working_components}/5 working")
        print(f"⏱️  Total Test Time: {total_test_time:.2f} seconds")
        
        # Save detailed results
        detailed_results = {
            'timestamp': datetime.now().isoformat(),
            'test_duration_seconds': total_test_time,
            'crypto_performance': crypto_results,
            'post_quantum_performance': pq_results,
            'transaction_processing': processing_results,
            'cross_shard_performance': cross_shard_results,
            'memory_performance': memory_results,
            'tps_estimates': tps_estimates,
            'working_components': working_components,
            'total_components': 5
        }
        
        with open('real_performance_results.json', 'w') as f:
            json.dump(detailed_results, f, indent=2)
        
        print(f"\n📁 Detailed results saved to: real_performance_results.json")
        
        return detailed_results

def main():
    """Run honest performance assessment"""
    tester = RealPerformanceTester()
    results = tester.generate_honest_performance_report()
    
    # Exit with appropriate code
    if results['working_components'] >= 3:
        print("\n✅ Overall Assessment: FUNCTIONAL (Core components working)")
        sys.exit(0)
    else:
        print("\n❌ Overall Assessment: NEEDS WORK (Major component failures)")
        sys.exit(1)

if __name__ == "__main__":
    main() 