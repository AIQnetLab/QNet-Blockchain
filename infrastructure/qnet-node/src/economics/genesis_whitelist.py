"""
Genesis Whitelist Management
Manages privileged addresses for network bootstrap
"""

from typing import List, Dict, Set
from dataclasses import dataclass
from enum import Enum
import json
import os

class WhitelistRole(Enum):
    """Roles for whitelisted addresses"""
    GENESIS_VALIDATOR = "genesis_validator"  # Initial validators
    FOUNDATION = "foundation"  # Foundation addresses
    TEAM = "team"  # Team addresses
    ADVISOR = "advisor"  # Advisor addresses
    PARTNER = "partner"  # Strategic partners
    EARLY_ACCESS = "early_access"  # Early access participants

@dataclass
class WhitelistEntry:
    """Single whitelist entry"""
    address: str
    role: WhitelistRole
    description: str
    free_activations: int = 0  # Number of free node activations
    discount_percent: float = 0  # Discount on activation price
    priority_access: bool = False  # Priority during high demand

class GenesisWhitelist:
    """Manages genesis whitelist for network bootstrap"""
    
    def __init__(self, config_path: str = None):
        self.whitelist: Dict[str, WhitelistEntry] = {}
        self.config_path = config_path or "config/genesis_whitelist.json"
        self.load_whitelist()
    
    def load_whitelist(self):
        """Load whitelist from configuration file"""
        if os.path.exists(self.config_path):
            try:
                with open(self.config_path, 'r') as f:
                    data = json.load(f)
                    for entry in data.get('whitelist', []):
                        self.add_entry(
                            address=entry['address'],
                            role=WhitelistRole(entry['role']),
                            description=entry.get('description', ''),
                            free_activations=entry.get('free_activations', 0),
                            discount_percent=entry.get('discount_percent', 0),
                            priority_access=entry.get('priority_access', False)
                        )
            except Exception as e:
                print(f"Error loading whitelist: {e}")
                self._create_default_whitelist()
        else:
            self._create_default_whitelist()
    
    def _create_default_whitelist(self):
        """Create default whitelist for genesis"""
        # Genesis validators - 5 bootstrap nodes with new BIP44/SLIP-0010 addresses
        genesis_validators = [
            {
                "address": "b07408bdc5688b92d69eonfd060d05f246f659414",
                "description": "Genesis Bootstrap Node 1 - Primary",
                "free_activations": 1,
                "priority_access": True
            },
            {
                "address": "d0da31d839ce7ef8ca8eon3f37c6b1f2150e301fc", 
                "description": "Genesis Bootstrap Node 2 - Secondary",
                "free_activations": 1,
                "priority_access": True
            },
            {
                "address": "a3d62ef91e60d66d2a2eon2caa0d87cb2a1976f31",
                "description": "Genesis Bootstrap Node 3 - Tertiary", 
                "free_activations": 1,
                "priority_access": True
            },
            {
                "address": "29e11b0a9cc89296490eoncca66139e40d72bd25d",
                "description": "Genesis Bootstrap Node 4 - Quaternary", 
                "free_activations": 1,
                "priority_access": True
            },
            {
                "address": "f8c4ed54ad92b0a94f1eonad6cc5623af63b79826",
                "description": "Genesis Bootstrap Node 5 - Quinary",
                "free_activations": 1,
                "priority_access": True
            }
        ]
        
        for validator in genesis_validators:
            self.add_entry(
                address=validator["address"],
                role=WhitelistRole.GENESIS_VALIDATOR,
                description=validator["description"],
                free_activations=validator["free_activations"],
                priority_access=validator["priority_access"]
            )
        
        # No other discounts or free activations
        # Everyone else pays full price
    
    def add_entry(
        self,
        address: str,
        role: WhitelistRole,
        description: str = "",
        free_activations: int = 0,
        discount_percent: float = 0,
        priority_access: bool = False
    ):
        """Add entry to whitelist"""
        self.whitelist[address] = WhitelistEntry(
            address=address,
            role=role,
            description=description,
            free_activations=free_activations,
            discount_percent=discount_percent,
            priority_access=priority_access
        )
    
    def is_whitelisted(self, address: str) -> bool:
        """Check if address is whitelisted"""
        return address in self.whitelist
    
    def get_entry(self, address: str) -> WhitelistEntry:
        """Get whitelist entry for address"""
        return self.whitelist.get(address)
    
    def get_discount(self, address: str) -> float:
        """Get discount percentage for address"""
        entry = self.get_entry(address)
        return entry.discount_percent if entry else 0
    
    def has_free_activation(self, address: str) -> bool:
        """Check if address has free activations remaining"""
        entry = self.get_entry(address)
        return entry and entry.free_activations > 0
    
    def use_free_activation(self, address: str) -> bool:
        """Use one free activation if available"""
        entry = self.get_entry(address)
        if entry and entry.free_activations > 0:
            entry.free_activations -= 1
            return True
        return False
    
    def get_addresses_by_role(self, role: WhitelistRole) -> List[str]:
        """Get all addresses with specific role"""
        return [
            address for address, entry in self.whitelist.items()
            if entry.role == role
        ]
    
    def get_genesis_validators(self) -> List[str]:
        """Get genesis validator addresses"""
        return self.get_addresses_by_role(WhitelistRole.GENESIS_VALIDATOR)
    
    def save_whitelist(self):
        """Save whitelist to configuration file"""
        data = {
            'whitelist': [
                {
                    'address': entry.address,
                    'role': entry.role.value,
                    'description': entry.description,
                    'free_activations': entry.free_activations,
                    'discount_percent': entry.discount_percent,
                    'priority_access': entry.priority_access
                }
                for entry in self.whitelist.values()
            ]
        }
        
        os.makedirs(os.path.dirname(self.config_path), exist_ok=True)
        with open(self.config_path, 'w') as f:
            json.dump(data, f, indent=2)
    
    def export_genesis_config(self) -> Dict:
        """Export configuration for genesis block"""
        return {
            'genesis_validators': self.get_genesis_validators(),
            'privileged_addresses': {
                address: {
                    'role': entry.role.value,
                    'priority': entry.priority_access
                }
                for address, entry in self.whitelist.items()
            },
            'total_whitelisted': len(self.whitelist),
            'roles_count': {
                role.value: len(self.get_addresses_by_role(role))
                for role in WhitelistRole
            }
        }

# Example usage
if __name__ == "__main__":
    whitelist = GenesisWhitelist()
    
    # Add some test entries
    whitelist.add_entry(
        address="TEST_EARLY_ACCESS_ADDRESS",
        role=WhitelistRole.EARLY_ACCESS,
        description="Early access participant",
        discount_percent=25
    )
    
    # Save configuration
    whitelist.save_whitelist()
    
    # Export genesis config
    genesis_config = whitelist.export_genesis_config()
    print("Genesis Configuration:")
    print(json.dumps(genesis_config, indent=2))
    
    # Test discount calculation
    test_address = "TEAM_MEMBER_1_ADDRESS"
    if whitelist.is_whitelisted(test_address):
        discount = whitelist.get_discount(test_address)
        print(f"\nAddress {test_address} has {discount}% discount") 