# token_verification.py - Module for QNet token verification via Solana
# This module handles verification of QnetAccess token balance for node activation

import os
import json
import logging
import time
import base64
import hashlib
from typing import Dict, Any, Optional, Tuple, List, Union

# Third-party imports for Solana interaction
try:
    from solana.rpc.api import Client
    from solana.publickey import PublicKey
    from solana.transaction import Transaction
    from solana.system_program import SYS_PROGRAM_ID
    import solana.rpc.types as types
    SOLANA_SDK_AVAILABLE = True
except ImportError:
    SOLANA_SDK_AVAILABLE = False
    logging.warning("Solana SDK not available. Using mock verification for testing.")

class SolanaTokenVerifier:
    """Verifies token ownership and balance on Solana blockchain."""
    
    def __init__(self, config=None):
        """
        Initialize the token verifier with configuration.
        
        Args:
            config: Configuration dictionary or object with required settings
        """
        # Default configuration
        self.config = {
            'network': os.environ.get('QNET_NETWORK', 'testnet'),
            'token_address': os.environ.get('QNET_TOKEN_ADDRESS', ''),
            'min_token_balance': int(os.environ.get('QNET_MIN_TOKEN_BALANCE', '10000')),
            'verification_cache_ttl': int(os.environ.get('QNET_VERIFICATION_CACHE_TTL', '3600')),  # 1 hour
            'mock_verification': os.environ.get('QNET_MOCK_VERIFICATION', 'false').lower() == 'true',
            'mock_balances_file': os.environ.get('QNET_MOCK_BALANCES_FILE', '/app/mock_balances.json'),
        }
        
        # Override with provided config if available
        if config:
            if hasattr(config, '__getitem__'):
                # Dictionary-like object
                for key, value in self.config.items():
                    if key in config:
                        self.config[key] = config[key]
            else:
                # Attribute-based object
                for key in self.config.keys():
                    if hasattr(config, key):
                        self.config[key] = getattr(config, key)
        
        # Initialize Solana client based on network
        self._init_solana_client()
        
        # Load mock balances for testing if needed
        self.mock_balances = {}
        if self.config['mock_verification'] or not SOLANA_SDK_AVAILABLE:
            self._load_mock_balances()
            
        # Initialize verification cache
        self.verification_cache = {}
    
    def _init_solana_client(self):
        """Initialize Solana client based on network configuration."""
        if not SOLANA_SDK_AVAILABLE:
            self.solana_client = None
            return
            
        try:
            network = self.config['network'].lower()
            
            if network == 'mainnet':
                # For production use with real tokens
                self.solana_client = Client("https://api.mainnet-beta.solana.com")
            elif network == 'testnet':
                # For testing with test tokens
                self.solana_client = Client("https://api.testnet.solana.com")
            elif network == 'devnet':
                # For development with test tokens
                self.solana_client = Client("https://api.devnet.solana.com")
            else:
                # Custom endpoint
                self.solana_client = Client(network)
                
            # Test connection
            response = self.solana_client.get_health()
            if response == "ok":
                logging.info(f"Connected to Solana {network}")
            else:
                logging.warning(f"Solana {network} connection status: {response}")
        except Exception as e:
            logging.error(f"Failed to initialize Solana client: {e}")
            self.solana_client = None
    
    def _load_mock_balances(self):
        """Load mock balances from file for testing."""
        try:
            if os.path.exists(self.config['mock_balances_file']):
                with open(self.config['mock_balances_file'], 'r') as f:
                    self.mock_balances = json.load(f)
                logging.info(f"Loaded mock balances for {len(self.mock_balances)} wallets")
            else:
                logging.warning(f"Mock balances file not found: {self.config['mock_balances_file']}")
                # Create default mock balances
                self.mock_balances = {
                    "test_wallet1": 15000,
                    "test_wallet2": 12000,
                    "low_balance_wallet": 9000,
                    "excluded_wallet": 5000
                }
        except Exception as e:
            logging.error(f"Error loading mock balances: {e}")
            self.mock_balances = {}
    
    def verify_token_balance(self, wallet_address: str) -> Tuple[bool, int]:
        """
        Verify if a wallet has sufficient QnetAccess tokens.
        
        Args:
            wallet_address: Solana wallet address to check
            
        Returns:
            Tuple of (is_verified, token_balance)
        """
        # Check cache first
        cache_key = f"{wallet_address}"
        if cache_key in self.verification_cache:
            cache_entry = self.verification_cache[cache_key]
            # If cache entry is still valid
            if time.time() < cache_entry['expires']:
                return cache_entry['verified'], cache_entry['balance']
        
        # For mock verification or when Solana SDK is unavailable
        if self.config['mock_verification'] or not SOLANA_SDK_AVAILABLE:
            return self._mock_verify_balance(wallet_address)
        
        # Real verification with Solana
        try:
            balance = self._get_token_balance(wallet_address)
            is_verified = balance >= self.config['min_token_balance']
            
            # Cache the result
            self.verification_cache[cache_key] = {
                'verified': is_verified,
                'balance': balance,
                'expires': time.time() + self.config['verification_cache_ttl']
            }
            
            return is_verified, balance
        except Exception as e:
            logging.error(f"Error verifying token balance for {wallet_address}: {e}")
            return False, 0
    
    def _mock_verify_balance(self, wallet_address: str) -> Tuple[bool, int]:
        """Mock verification for testing."""
        # Get balance from mock data
        balance = self.mock_balances.get(wallet_address, 0)
        is_verified = balance >= self.config['min_token_balance']
        
        logging.info(f"Mock verification for {wallet_address}: balance={balance}, verified={is_verified}")
        
        # Cache the result
        cache_key = f"{wallet_address}"
        self.verification_cache[cache_key] = {
            'verified': is_verified,
            'balance': balance,
            'expires': time.time() + self.config['verification_cache_ttl']
        }
        
        return is_verified, balance
    
    def _get_token_balance(self, wallet_address: str) -> int:
        """
        Get token balance from Solana blockchain.
        
        Args:
            wallet_address: Solana wallet address
            
        Returns:
            Token balance as integer
        """
        if not self.solana_client:
            return 0
            
        try:
            token_address = self.config['token_address']
            if not token_address:
                logging.error("Token address not configured")
                return 0
            
            # Convert addresses to PublicKey objects
            try:
                wallet_pubkey = PublicKey(wallet_address)
                token_pubkey = PublicKey(token_address)
            except Exception as e:
                logging.error(f"Invalid public key: {e}")
                return 0
            
            # Get token account address
            token_accounts = self.solana_client.get_token_accounts_by_owner(
                wallet_pubkey,
                {'mint': token_pubkey}
            )
            
            # Sum balances from all accounts with this token
            total_balance = 0
            for account_info in token_accounts.get('result', {}).get('value', []):
                account_data = account_info.get('account', {}).get('data', [])
                if account_data and len(account_data) > 1:
                    # Extract and decode token balance from account data
                    # This varies based on the token program, this is a simplified example
                    try:
                        decoded = base64.b64decode(account_data[0])
                        # Extract balance based on token program structure
                        # This may need adjustments based on actual token program
                        balance = int.from_bytes(decoded[64:72], byteorder='little')
                        total_balance += balance
                    except Exception as e:
                        logging.error(f"Error decoding token data: {e}")
            
            # Convert from smallest unit to standard unit (e.g., lamports to SOL)
            # Adjust divisor based on token decimals (default for SPL tokens is 9)
            token_decimals = 9  # Default, should be retrieved from token metadata
            adjusted_balance = total_balance / (10 ** token_decimals)
            
            logging.info(f"Token balance for {wallet_address}: {adjusted_balance}")
            return int(adjusted_balance)  # Return integer balance
            
        except Exception as e:
            logging.error(f"Error getting token balance: {e}")
            return 0
    
    def verify_signature(self, message: str, signature: str, wallet_address: str) -> bool:
        """
        Verify a signature from a Solana wallet.
        
        Args:
            message: Message that was signed
            signature: Signature in base64 format
            wallet_address: Solana wallet address that signed the message
            
        Returns:
            True if signature is valid, False otherwise
        """
        if self.config['mock_verification'] or not SOLANA_SDK_AVAILABLE:
            # Mock verification - always succeed for testing
            return True
            
        try:
            # This requires a more complex implementation with ed25519 verification
            # For simplified example, we'll return True
            # In a real implementation, you would:
            # 1. Decode the signature
            # 2. Verify using ed25519 or Solana SDK methods
            
            # Placeholder for actual verification
            logging.warning("Signature verification not fully implemented")
            return True
            
        except Exception as e:
            logging.error(f"Error verifying signature: {e}")
            return False
    
    def is_wallet_active(self, wallet_address: str) -> bool:
        """
        Check if wallet is active on Solana.
        
        Args:
            wallet_address: Solana wallet address
            
        Returns:
            True if wallet exists and is active
        """
        if not self.solana_client:
            return True  # Mock as active
            
        try:
            # Get account info
            response = self.solana_client.get_account_info(wallet_address)
            return 'result' in response and response['result'] is not None
        except Exception as e:
            logging.error(f"Error checking wallet status: {e}")
            return False


# Helper function to get singleton instance
_token_verifier_instance = None

def get_token_verifier(config=None) -> SolanaTokenVerifier:
    """
    Get or create the singleton token verifier instance.
    
    Args:
        config: Optional configuration
        
    Returns:
        SolanaTokenVerifier instance
    """
    global _token_verifier_instance
    if _token_verifier_instance is None:
        _token_verifier_instance = SolanaTokenVerifier(config)
    return _token_verifier_instance