#!/usr/bin/env python3
"""
Security Fixes for QNet Economic Model
Fixes duplicate burn detection and ping spam prevention
"""

import time
import hashlib
from typing import Dict, Set, List
from dataclasses import dataclass

@dataclass
class SecurityConfig:
    """Security configuration for economic model"""
    ping_window_hours: int = 4
    max_pings_per_window: int = 1
    burn_tx_uniqueness_check: bool = True
    cooldown_enforcement: bool = True

class EnhancedSecurityChecker:
    """Enhanced security checks for QNet economic model"""
    
    def __init__(self):
        self.used_burn_transactions: Set[str] = set()
        self.node_ping_history: Dict[str, List[float]] = {}
        self.config = SecurityConfig()
        
    def verify_burn_transaction_uniqueness(self, burn_tx_hash: str) -> bool:
        """Verify burn transaction hasn't been used before"""
        if not self.config.burn_tx_uniqueness_check:
            return True
            
        if burn_tx_hash in self.used_burn_transactions:
            print(f"❌ SECURITY: Duplicate burn transaction detected: {burn_tx_hash}")
            return False
            
        self.used_burn_transactions.add(burn_tx_hash)
        print(f"✅ SECURITY: Burn transaction verified as unique: {burn_tx_hash[:16]}...")
        return True
    
    def verify_ping_rate_limit(self, node_id: str) -> bool:
        """Verify node hasn't exceeded ping rate limit"""
        current_time = time.time()
        window_start = current_time - (self.config.ping_window_hours * 3600)
        
        # Initialize ping history for new nodes
        if node_id not in self.node_ping_history:
            self.node_ping_history[node_id] = []
        
        # Clean old pings outside current window
        self.node_ping_history[node_id] = [
            ping_time for ping_time in self.node_ping_history[node_id]
            if ping_time >= window_start
        ]
        
        # Check if node has exceeded ping limit
        recent_pings = len(self.node_ping_history[node_id])
        if recent_pings >= self.config.max_pings_per_window:
            print(f"❌ SECURITY: Ping rate limit exceeded for {node_id}: {recent_pings} pings in {self.config.ping_window_hours}h window")
            return False
        
        # Record this ping attempt
        self.node_ping_history[node_id].append(current_time)
        print(f"✅ SECURITY: Ping rate limit verified for {node_id}: {recent_pings + 1}/{self.config.max_pings_per_window} pings")
        return True
    
    def get_next_allowed_ping_time(self, node_id: str) -> float:
        """Get when node can ping next"""
        if node_id not in self.node_ping_history or not self.node_ping_history[node_id]:
            return time.time()  # Can ping immediately
            
        last_ping = max(self.node_ping_history[node_id])
        next_allowed = last_ping + (self.config.ping_window_hours * 3600)
        return next_allowed
    
    def generate_secure_burn_transaction(self, wallet_address: str, amount: int, nonce: str = None) -> str:
        """Generate cryptographically secure burn transaction hash"""
        if nonce is None:
            nonce = str(time.time_ns())  # Use nanosecond timestamp for uniqueness
            
        # Include multiple entropy sources
        entropy_sources = [
            wallet_address,
            str(amount),
            nonce,
            str(time.time()),
            hashlib.sha256(wallet_address.encode()).hexdigest()[:16]
        ]
        
        combined_entropy = ":".join(entropy_sources)
        burn_tx_hash = hashlib.sha256(combined_entropy.encode()).hexdigest()
        
        # Verify uniqueness
        if not self.verify_burn_transaction_uniqueness(burn_tx_hash):
            # If collision (extremely rare), try again with different nonce
            return self.generate_secure_burn_transaction(wallet_address, amount, nonce + "_retry")
        
        return burn_tx_hash
    
    def validate_node_activation(self, burn_tx_hash: str, wallet_address: str, node_type: str, amount: int) -> bool:
        """Comprehensive validation for node activation"""
        print(f"🔐 SECURITY: Validating activation for {node_type} node...")
        
        # Check 1: Burn transaction uniqueness
        if not self.verify_burn_transaction_uniqueness(burn_tx_hash):
            return False
        
        # Check 2: Wallet format validation
        if len(wallet_address) < 32 or len(wallet_address) > 44:
            print(f"❌ SECURITY: Invalid wallet address format: {wallet_address}")
            return False
        
        # Check 3: Amount validation
        required_amounts = {"light": 1500, "full": 1500, "super": 1500}
        if amount < required_amounts.get(node_type, 0):
            print(f"❌ SECURITY: Insufficient burn amount: {amount} < {required_amounts[node_type]}")
            return False
        
        # Check 4: Node type validation
        if node_type not in ["light", "full", "super"]:
            print(f"❌ SECURITY: Invalid node type: {node_type}")
            return False
        
        print(f"✅ SECURITY: Node activation validation passed for {node_type} node")
        return True
    
    def get_security_report(self) -> Dict:
        """Generate security report"""
        total_nodes = len(self.node_ping_history)
        total_burns = len(self.used_burn_transactions)
        
        # Calculate ping statistics
        recent_pings = 0
        current_time = time.time()
        window_start = current_time - (self.config.ping_window_hours * 3600)
        
        for ping_history in self.node_ping_history.values():
            recent_pings += len([p for p in ping_history if p >= window_start])
        
        return {
            "total_nodes": total_nodes,
            "total_burn_transactions": total_burns,
            "recent_pings": recent_pings,
            "ping_window_hours": self.config.ping_window_hours,
            "max_pings_per_window": self.config.max_pings_per_window,
            "security_features": {
                "burn_uniqueness_check": self.config.burn_tx_uniqueness_check,
                "ping_rate_limiting": True,
                "wallet_validation": True,
                "amount_validation": True
            }
        }

def test_security_improvements():
    """Test the security improvements"""
    print("🔐 Testing QNet Security Improvements")
    print("=" * 50)
    
    security = EnhancedSecurityChecker()
    
    # Test 1: Duplicate burn prevention
    print("\n📋 Test 1: Duplicate Burn Prevention")
    wallet = "test_wallet_security_1"
    burn_tx1 = security.generate_secure_burn_transaction(wallet, 1500)
    burn_tx2 = security.generate_secure_burn_transaction(wallet, 1500)
    
    # Try to use same burn transaction twice
    print("   Testing first activation...")
    result1 = security.validate_node_activation(burn_tx1, wallet, "light", 1500)
    
    print("   Testing duplicate burn...")
    result2 = security.validate_node_activation(burn_tx1, wallet, "full", 1500)  # Same TX!
    
    if result1 and not result2:
        print("   ✅ Duplicate burn prevention: WORKING")
    else:
        print("   ❌ Duplicate burn prevention: FAILED")
    
    # Test 2: Ping rate limiting
    print("\n📋 Test 2: Ping Rate Limiting")
    node_id = "test_node_ping_spam"
    
    # Try multiple pings in same window
    ping_results = []
    for i in range(5):
        result = security.verify_ping_rate_limit(node_id)
        ping_results.append(result)
        print(f"   Ping {i+1}: {'✅' if result else '❌'}")
    
    # Should only allow 1 ping per 4-hour window
    allowed_pings = sum(ping_results)
    if allowed_pings == 1:
        print("   ✅ Ping rate limiting: WORKING")
    else:
        print(f"   ❌ Ping rate limiting: FAILED (allowed {allowed_pings} pings)")
    
    # Test 3: Security report
    print("\n📋 Test 3: Security Report")
    report = security.get_security_report()
    print(f"   Total Nodes: {report['total_nodes']}")
    print(f"   Total Burns: {report['total_burn_transactions']}")
    print(f"   Recent Pings: {report['recent_pings']}")
    print(f"   Security Features: {len([k for k, v in report['security_features'].items() if v])}/4 enabled")
    
    # Final assessment
    security_score = 0
    if result1 and not result2:  # Duplicate burn prevention
        security_score += 25
    if allowed_pings == 1:  # Ping rate limiting
        security_score += 25
    if report['total_burn_transactions'] > 0:  # Burn tracking
        security_score += 25
    if report['total_nodes'] > 0:  # Node tracking
        security_score += 25
    
    print(f"\n🎯 Overall Security Score: {security_score}%")
    
    if security_score >= 75:
        print("   Status: ✅ SECURITY IMPROVEMENTS SUCCESSFUL")
    else:
        print("   Status: ❌ SECURITY IMPROVEMENTS NEED WORK")
    
    return security_score >= 75

if __name__ == "__main__":
    success = test_security_improvements()
    exit(0 if success else 1) 