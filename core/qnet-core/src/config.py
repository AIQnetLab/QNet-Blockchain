"""
QNet Core Configuration
Central configuration for all QNet blockchain parameters

ARCHITECTURE NOTE:
- This file contains BASE CONSTANTS and FORMULA PARAMETERS only
- Dynamic pricing is calculated in Rust (quantum_crypto.rs)
- Python config is for documentation and non-critical services
- Rust is the SINGLE SOURCE OF TRUTH for all pricing logic
"""

import os
from typing import Dict, Any
from dataclasses import dataclass

@dataclass
class NetworkConfig:
    """Network configuration parameters"""
    name: str = "QNet"
    version: str = "2.0.0"
    genesis_timestamp: int = 0  # Dynamic: set from first block creation
    
    # Block timing
    microblock_interval_seconds: int = 1    # 1 second microblocks
    macroblock_interval_seconds: int = 90   # 90 seconds macroblocks
    microblocks_per_macroblock: int = 90    # 90 microblocks per macroblock
    
    # Performance targets
    target_tps: int = 100_000
    max_block_size: int = 50_000_000  # 50MB
    max_transactions_per_microblock: int = 50_000

    def get_network_launch_timestamp(self) -> int:
        """Get network launch timestamp from blockchain or current time if not set"""
        if self.genesis_timestamp == 0:
            import time
            return int(time.time())
        return self.genesis_timestamp
    
    def set_network_launch_timestamp(self, timestamp: int):
        """Set network launch timestamp from genesis block"""
        if self.genesis_timestamp == 0:
            self.genesis_timestamp = timestamp

@dataclass 
class TokenConfig:
    """$1DEV and QNC token configuration"""
    
    # ============== $1DEV (Phase 1 - Solana) ==============
    one_dev_total_supply: int = 1_000_000_000  # 1 billion
    one_dev_decimals: int = 6
    
    # DYNAMIC PRICING PARAMETERS (actual calculation in Rust)
    # Formula: base_price - (burn_percentage / 10) * reduction_per_step
    one_dev_base_price: int = 1_500           # Base: 1500 1DEV
    one_dev_reduction_per_10_percent: int = 150  # -150 per 10% burned
    one_dev_min_price: int = 300              # Floor: 300 1DEV
    
    # Burn progression
    burn_threshold_for_transition: float = 0.9  # 90% burned triggers Phase 2
    max_years_before_transition: int = 5
    
    # ============== QNC (Phase 2 - Native) ==============
    qnc_total_supply: int = 4_294_967_296  # 2^32 for quantum reference
    qnc_decimals: int = 9  # 1 QNC = 10^9 nanoQNC
    
    # DYNAMIC PRICING PARAMETERS (actual calculation in Rust)
    # Formula: base_price * network_multiplier
    qnc_base_prices = {
        "light": 5_000,   # Base: 5,000 QNC
        "full": 7_500,    # Base: 7,500 QNC
        "super": 10_000   # Base: 10,000 QNC
    }
    
    # Network multiplier thresholds
    # CANONICAL VALUES - same across all components (JS, Python, Rust)
    # ≤100K: 0.5x, ≤300K: 1.0x, ≤1M: 2.0x, >1M: 3.0x
    network_multiplier_min: float = 0.5
    network_multiplier_max: float = 3.0

@dataclass
class NodeConfig:
    """Node activation and operation configuration"""
    
    # Node types with capabilities (pricing is DYNAMIC - see TokenConfig)
    node_types = {
        "light": {
            "capabilities": ["basic_validation", "mobile_optimized"],
            "resource_requirements": "minimal",
            "max_connections": 50,
            "storage_requirement": "headers_only"
        },
        "full": {
            "capabilities": ["full_validation", "consensus_participation", "single_shard"],
            "resource_requirements": "moderate",
            "max_connections": 200,
            "storage_requirement": "full_blockchain"
        },
        "super": {
            "capabilities": ["priority_validation", "cross_shard", "triple_shard", "leadership"],
            "resource_requirements": "high",
            "max_connections": 500,
            "storage_requirement": "full_blockchain_plus_shards"
        }
    }
    
    # Genesis validator addresses (free activation)
    # Format: 19 hex + "eon" + 15 hex + 4 hex checksum = 41 chars
    # SOURCE OF TRUTH: genesis_constants.rs (Rust)
    genesis_validators = [
        "7bc83500fd08525250feonff5503d0dce4dbdede8",  # Bootstrap Node 1
        "714a0f700a4dbcc0d88eonf635ace76ed2eb9a186",  # Bootstrap Node 2
        "357842d58e86cc300cfeon0203e16eef3e7044db1",  # Bootstrap Node 3
        "4f710f9b3152659c56aeond4c05f2731a1890aedf",  # Bootstrap Node 4
        "8fa8ebe9e85dee95080eond0a7365096572f03e1c"   # Bootstrap Node 5
    ]

@dataclass
class SolanaConfig:
    """Solana integration configuration (Phase 1)"""
    rpc_mainnet: str = "https://api.mainnet-beta.solana.com"
    rpc_devnet: str = "https://api.devnet.solana.com"
    
    # $1DEV token details - REAL DEVNET TOKEN
    one_dev_mint: str = "62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ"
    mint_authority: str = "6gesV5Dojg9tfH9TRytvXabnQT8U7oMbz5VKpTFi8rG4"
    burn_address: str = "1nc1nerator11111111111111111111111111111111"
    
    # Bridge monitoring
    check_interval_seconds: int = 30
    confirmation_blocks: int = 32
    
    # Burn verification
    minimum_burn_confirmations: int = 64
    verify_burn_signature: bool = True

@dataclass
class ConsensusConfig:
    """Consensus mechanism parameters"""
    
    # Commit-reveal consensus
    commit_timeout_seconds: int = 30
    reveal_timeout_seconds: int = 30
    
    # Producer rotation
    rotation_interval_blocks: int = 30  # Producer changes every 30 blocks
    finality_window_blocks: int = 10    # Entropy from 10 blocks behind
    
    # Adaptive timing
    enable_adaptive_timing: bool = True
    safety_factor: float = 1.5
    
    # Participation requirements
    minimum_validators: int = 3
    maximum_validators: int = 1000
    
    # Reputation system
    enable_reputation: bool = True
    initial_reputation: float = 70.0    # Start at 70%
    consensus_threshold: float = 70.0   # Need 70% to participate
    reputation_history_size: int = 100
    reputation_decay_factor: float = 0.95

@dataclass  
class PhaseTransitionConfig:
    """Configuration for 1DEV → QNC transition"""
    
    # Transition triggers (whichever comes first)
    burn_percentage_threshold: float = 90.0  # 90% of 1DEV burned
    time_threshold_years: int = 5            # OR 5 years elapsed
    
    # Migration settings
    allow_free_migration: bool = True        # Free migration from 1DEV nodes
    migration_grace_period_days: int = 90    # 90 days to migrate
    
    # Pool 3 (Activation Pool) configuration
    pool3_enabled: bool = True
    pool3_redistribution: bool = True        # QNC redistributes to ALL active nodes
    pool3_distribution_frequency_hours: int = 4  # Every 4 hours
    
    # Reward pool distribution ratios
    reward_pools = {
        "pool1_base_emission": {
            "description": "Base emission with halving every 4 years",
            "halving_interval_years": 4
        },
        "pool2_transaction_fees": {
            "super_nodes": 0.70,  # 70% to super nodes
            "full_nodes": 0.30,  # 30% to full nodes
            "light_nodes": 0.00  # 0% to light nodes
        },
        "pool3_activation_deposits": {
            "redistribution_ratio": 1.0,  # 100% redistributed
            "all_node_types": True        # All types benefit
        }
    }
    
    # Network ping configuration
    ping_frequency_hours: int = 4
    ping_randomization: bool = True
    missed_ping_penalty: bool = True
    
    # Risk disclaimers
    experimental_warnings = {
        "network_disclaimer": "Experimental blockchain research project",
        "risk_warning": "Participation involves risk of total token loss",
        "no_guarantees": "No guarantees of network operation or rewards",
        "regulatory_notice": "Users responsible for regulatory compliance"
    }

@dataclass
class DynamicPricingConfig:
    """
    Dynamic pricing configuration (REFERENCE ONLY)
    
    IMPORTANT: Actual dynamic pricing is calculated in Rust (quantum_crypto.rs)
    This class documents the pricing logic for reference.
    """
    
    # Phase 1: 1DEV burn pricing
    # Price decreases as more 1DEV is burned (incentivizes early adoption)
    phase1_formula = """
    base_price = 1500
    reduction_per_10_percent = 150
    min_price = 300
    
    dynamic_price = max(min_price, base_price - (burn_percentage / 10) * reduction_per_10_percent)
    
    Examples:
    - 0% burned:  1500 1DEV
    - 20% burned: 1200 1DEV
    - 50% burned: 750 1DEV
    - 80% burned: 300 1DEV (minimum)
    """
    
    # Phase 2: QNC spending pricing
    # Price increases with network size (prevents node inflation)
    # CANONICAL VALUES - same across all components
    phase2_formula = """
    base_prices = {"light": 5000, "full": 7500, "super": 10000}
    
    network_multiplier = {
        ≤100K nodes:  0.5x (early adopter discount)
        ≤300K nodes:  1.0x (base price)
        ≤1M nodes:    2.0x (high demand)
        >1M nodes:    3.0x (maximum cap)
    }
    
    final_price = base_prices[node_type] * network_multiplier
    
    Examples (Super Node):
    - 50K nodes:  5,000 QNC (0.5x)
    - 200K nodes: 10,000 QNC (1.0x)
    - 500K nodes: 20,000 QNC (2.0x)
    - 2M nodes:   30,000 QNC (3.0x max)
    """

class QNetConfig:
    """Main QNet configuration manager"""
    
    def __init__(self, environment: str = "mainnet"):
        self.environment = environment
        self.network = NetworkConfig()
        self.tokens = TokenConfig()
        self.nodes = NodeConfig()
        self.solana = SolanaConfig()
        self.consensus = ConsensusConfig()
        self.transition = PhaseTransitionConfig()
        self.pricing = DynamicPricingConfig()
        
        self._load_environment_config()
    
    def _load_environment_config(self):
        """Load environment-specific configuration"""
        if self.environment == "testnet":
            self.solana.rpc_mainnet = self.solana.rpc_devnet
            self.tokens.one_dev_base_price = 100  # Reduced for testing
            self.consensus.minimum_validators = 1
            
        elif self.environment == "devnet":
            self.tokens.one_dev_base_price = 10   # Minimal for development
            self.consensus.minimum_validators = 1
            self.transition.burn_percentage_threshold = 50.0
    
    def get_phase1_price_estimate(self, burn_percentage: float) -> int:
        """
        Estimate Phase 1 price (for display only)
        ACTUAL PRICE is calculated in Rust
        """
        base = self.tokens.one_dev_base_price
        reduction = self.tokens.one_dev_reduction_per_10_percent
        min_price = self.tokens.one_dev_min_price
        
        reduction_steps = int(burn_percentage) // 10
        dynamic_price = base - (reduction_steps * reduction)
        return max(min_price, dynamic_price)
    
    def get_phase2_price_estimate(self, node_type: str, network_size: int) -> int:
        """
        Estimate Phase 2 price (for display only)
        ACTUAL PRICE is calculated in Rust
        """
        base_price = self.tokens.qnc_base_prices.get(node_type, 5000)
        
        # Network multiplier calculation
        # CANONICAL VALUES - same across all components
        if network_size <= 100_000:
            multiplier = 0.5       # ≤100K: Early adopter discount
        elif network_size <= 300_000:
            multiplier = 1.0       # ≤300K: Base price
        elif network_size <= 1_000_000:
            multiplier = 2.0       # ≤1M: High demand
        else:
            multiplier = 3.0       # >1M: Maximum (cap)
        
        return int(base_price * multiplier)
    
    def is_genesis_validator(self, wallet_address: str) -> bool:
        """Check if address is a genesis validator (free activation)"""
        return wallet_address.lower() in [v.lower() for v in self.nodes.genesis_validators]
    
    def is_post_transition(self, total_burned: int, network_age_years: float) -> bool:
        """Check if network has transitioned to QNC phase"""
        burn_ratio = total_burned / self.tokens.one_dev_total_supply
        burn_threshold_met = burn_ratio >= (self.transition.burn_percentage_threshold / 100)
        time_threshold_met = network_age_years >= self.transition.time_threshold_years
        return burn_threshold_met or time_threshold_met
    
    def get_activation_method(self, total_burned: int, network_age_years: float) -> str:
        """Get current node activation method"""
        if self.is_post_transition(total_burned, network_age_years):
            return "qnc_spending"  # Phase 2: QNC spending
        return "1dev_burn"         # Phase 1: 1DEV burn
    
    def validate_node_activation(
        self, 
        node_type: str, 
        wallet_address: str,
        total_burned: int = 0,
        network_age_years: float = 0
    ) -> Dict[str, Any]:
        """Validate node activation requirements"""
        
        if node_type not in self.nodes.node_types:
            return {"valid": False, "error": "Invalid node type"}
        
        # Check genesis whitelist (free activation)
        if self.is_genesis_validator(wallet_address):
            return {
                "valid": True,
                "method": "genesis_free",
                "price": 0,
                "note": "Genesis validator - free activation"
            }
        
        method = self.get_activation_method(total_burned, network_age_years)
        
        if method == "1dev_burn":
            # Phase 1: Estimate price (actual from Rust)
            burn_pct = (total_burned / self.tokens.one_dev_total_supply) * 100
            estimated_price = self.get_phase1_price_estimate(burn_pct)
            return {
                "valid": True,
                "method": "1dev_burn",
                "price_estimate": estimated_price,
                "token": "$1DEV",
                "chain": "Solana",
                "action": "burn",
                "note": "Price is DYNAMIC - query /api/v1/activation/price for exact amount"
            }
        else:
            # Phase 2: Estimate price (actual from Rust)
            # Network size would come from blockchain query
            estimated_price = self.get_phase2_price_estimate(node_type, 50000)  # Assume 50K
            return {
                "valid": True,
                "method": "qnc_spending",
                "price_estimate": estimated_price,
                "token": "QNC",
                "chain": "QNet",
                "action": "spend",
                "note": "Price is DYNAMIC - query /api/v1/activation/price for exact amount"
            }

# Global configuration instance
config = QNetConfig(environment=os.getenv("QNET_ENV", "mainnet"))

# Export commonly used constants
MICROBLOCK_INTERVAL = config.network.microblock_interval_seconds
MACROBLOCK_INTERVAL = config.network.macroblock_interval_seconds  
TARGET_TPS = config.network.target_tps
QNC_DECIMALS = config.tokens.qnc_decimals
ONE_DEV_DECIMALS = config.tokens.one_dev_decimals
