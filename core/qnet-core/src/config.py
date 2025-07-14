"""
QNet Core Configuration
Central configuration for all QNet blockchain parameters
"""

import os
from typing import Dict, Any
from dataclasses import dataclass

@dataclass
class NetworkConfig:
    """Network configuration parameters"""
    name: str = "QNet"
    version: str = "2.0.0"
    genesis_timestamp: int = 1640995200  # 2022-01-01 00:00:00 UTC
    
    # Block timing (corrected parameters)
    microblock_interval_seconds: int = 1    # 1 second microblocks
    macroblock_interval_seconds: int = 90   # 90 seconds macroblocks
    microblocks_per_macroblock: int = 90    # 90 microblocks per macroblock
    
    # Performance targets
    target_tps: int = 100_000
    max_block_size: int = 50_000_000  # 50MB
    max_transactions_per_microblock: int = 50_000

@dataclass 
class TokenConfig:
    """$1DEV and QNC token configuration"""
    
    # $1DEV (Solana phase)
    one_dev_total_supply: int = 1_000_000_000  # 1 billion
    one_dev_decimals: int = 6
    one_dev_burn_amount: int = 1_500  # Same for all node types
    
    # Burn progression
    burn_threshold_for_transition: float = 0.9  # 90% burned triggers QNC
    max_years_before_transition: int = 5
    
    # QNC (Native phase)
    qnc_total_supply: int = 4_294_967_296  # 2^32 for quantum reference
    qnc_decimals: int = 6
    
    # QNC phase - spending mechanism (tokens go to Pool 3 redistribution)
    qnc_spending_requirements = {
        "light": 5_000,   # Spend 5k QNC (goes to Pool 3)
        "full": 7_500,    # Spend 7.5k QNC (goes to Pool 3)
        "super": 10_000   # Spend 10k QNC (goes to Pool 3)
    }

@dataclass
class NodeConfig:
    """Node activation and operation configuration"""
    
    # Node types with uniform $1DEV requirements
    node_types = {
        "light": {
            "burn_amount_1dev": 1_500,
            "capabilities": ["basic_validation", "mobile_optimized"],
            "resource_requirements": "minimal",
            "max_connections": 50,
            "storage_requirement": "headers_only"
        },
        "full": {
            "burn_amount_1dev": 1_500, 
            "capabilities": ["full_validation", "consensus_participation", "single_shard"],
            "resource_requirements": "moderate",
            "max_connections": 200,
            "storage_requirement": "full_blockchain"
        },
        "super": {
            "burn_amount_1dev": 1_500,
            "capabilities": ["priority_validation", "cross_shard", "triple_shard", "leadership"],
            "resource_requirements": "high",
            "max_connections": 500,
            "storage_requirement": "full_blockchain_plus_shards"
        }
    }
    
    # Genesis validator addresses (free activation)
    genesis_validators = [
        "QNetGenesis1xxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "QNetGenesis2xxxxxxxxxxxxxxxxxxxxxxxxxxxxx", 
        "QNetGenesis3xxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "QNetGenesis4xxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    ]

@dataclass
class SolanaConfig:
    """Solana integration configuration"""
    rpc_mainnet: str = "https://api.devnet.solana.com"
    rpc_devnet: str = "https://api.devnet.solana.com"
    
    # $1DEV token details
    one_dev_mint: str = "1DEVxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"  # Placeholder
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
    
    # Adaptive timing
    enable_adaptive_timing: bool = True
    safety_factor: float = 1.5
    
    # Participation requirements
    minimum_validators: int = 3
    maximum_validators: int = 1000
    
    # Reputation system
    enable_reputation: bool = True
    reputation_history_size: int = 100
    reputation_decay_factor: float = 0.95

@dataclass  
class PhaseTransitionConfig:
    """Configuration for 1DEV → QNC transition"""
    
    # Transition triggers
    burn_percentage_threshold: float = 90.0  # 90% of 1DEV burned
    time_threshold_years: int = 5           # OR 5 years elapsed
    
    # Phase 2 activation mechanics (QNC spending)
    activation_costs = {
        "light": 5000,   # 5,000 QNC spent for light node activation
        "full": 7500,    # 7,500 QNC spent for full node activation
        "super": 10000   # 10,000 QNC spent for super node activation
    }
    
    # Pool 3 (Activation Pool) configuration
    pool3_enabled: bool = True                    # Enable Pool #3 for Phase 2
    pool3_qnc_redistribution: bool = True        # QNC sent to Pool #3 redistributes to ALL active nodes
    pool3_activation_deposits: bool = True       # Node activation QNC goes to Pool #3
    pool3_all_nodes_benefit: bool = True         # All node types receive Pool #3 rewards
    pool3_distribution_frequency: int = 4        # Distribute rewards every 4 hours (with pings)
    
    # Migration settings
    allow_free_migration: bool = True       # Free migration from 1DEV nodes
    migration_grace_period_days: int = 90   # 90 days to migrate
    
    # Reward pool distribution
    reward_pools = {
        "pool1_base_emission": 0.0,         # Calculated dynamically with halving
        "pool2_transaction_fees": {
            "super_nodes": 0.7,             # 70% to super nodes
            "full_nodes": 0.3,              # 30% to full nodes
            "light_nodes": 0.0              # 0% to light nodes
        },
        "pool3_activation_bonus": 1.0       # 100% of activation payments redistributed
    }
    
    # Network ping configuration
    ping_frequency_hours: int = 4           # Network pings every 4 hours
    ping_randomization: bool = True         # Randomize ping timing
    missed_ping_penalty: bool = True        # No rewards for missed pings
    
    # Risk and experimental disclaimers
    experimental_warnings = {
        "network_disclaimer": "Experimental blockchain research project",
        "risk_warning": "Participation involves risk of total token loss",
        "no_guarantees": "No guarantees of network operation or rewards",
        "regulatory_notice": "Users responsible for regulatory compliance"
    }

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
        
        # Load environment-specific overrides
        self._load_environment_config()
    
    def _load_environment_config(self):
        """Load environment-specific configuration"""
        if self.environment == "testnet":
            self.solana.rpc_mainnet = self.solana.rpc_devnet
            self.tokens.one_dev_burn_amount = 100  # Reduced for testing
            self.consensus.minimum_validators = 1
            
        elif self.environment == "devnet":
            self.tokens.one_dev_burn_amount = 10   # Minimal for development
            self.consensus.minimum_validators = 1
            self.transition.burn_percentage_threshold = 50.0  # 50% for faster testing
    
    def get_burn_requirements(self) -> Dict[str, int]:
        """Get current burn requirements for all node types"""
        return {
            node_type: 1_500  # Uniform requirement
            for node_type in self.nodes.node_types.keys()
        }
    
    def get_qnc_holding_requirements(self) -> Dict[str, int]:
        """Get QNC holding requirements (post-transition)"""
        return self.tokens.qnc_holding_requirements.copy()
    
    def is_post_transition(self, total_burned: int, network_age_years: float) -> bool:
        """Check if network has transitioned to QNC phase"""
        burn_ratio = total_burned / self.tokens.one_dev_total_supply
        
        burn_threshold_met = burn_ratio >= (self.transition.burn_percentage_threshold / 100)
        time_threshold_met = network_age_years >= self.transition.time_threshold_years
        
        return burn_threshold_met or time_threshold_met
    
    def get_node_activation_method(self, total_burned: int, network_age_years: float) -> str:
        """Get current node activation method"""
        if self.is_post_transition(total_burned, network_age_years):
            return "qnc_holding"  # Simple QNC wallet holding
        else:
            return "1dev_burn"    # $1DEV token burning on Solana
    
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
        
        # Check genesis whitelist
        if wallet_address in self.nodes.genesis_validators:
            return {
                "valid": True,
                "method": "genesis_free",
                "requirements": {},
                "note": "Genesis validator - free activation"
            }
        
        # Determine activation method
        method = self.get_node_activation_method(total_burned, network_age_years)
        
        if method == "1dev_burn":
            return {
                "valid": True,
                "method": "1dev_burn",
                "requirements": {
                    "token": "$1DEV",
                    "amount": 1_500,
                    "chain": "Solana",
                    "action": "burn"
                }
            }
        else:  # qnc_holding
            holding_required = self.tokens.qnc_holding_requirements[node_type]
            return {
                "valid": True,
                "method": "qnc_holding", 
                "requirements": {
                    "token": "QNC",
                    "amount": holding_required,
                    "chain": "QNet",
                    "action": "hold_in_wallet"
                }
            }

# Global configuration instance
config = QNetConfig(environment=os.getenv("QNET_ENV", "mainnet"))

# Export commonly used values
MICROBLOCK_INTERVAL = config.network.microblock_interval_seconds
MACROBLOCK_INTERVAL = config.network.macroblock_interval_seconds  
TARGET_TPS = config.network.target_tps
ONE_DEV_BURN_AMOUNT = config.tokens.one_dev_burn_amount
QNC_HOLDING_REQUIREMENTS = config.tokens.qnc_holding_requirements 