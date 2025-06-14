"""
Seed phrase generator for node activation.
Generates deterministic BIP39 mnemonics from burn transaction data.
"""

import hashlib
import secrets
from typing import Tuple, Optional
from mnemonic import Mnemonic
import json
from datetime import datetime

# QNet-specific salt for additional entropy
QNET_SALT = "QNET_NODE_ACTIVATION_V1"

class SeedGenerator:
    """Generates deterministic seed phrases for node activation."""
    
    def __init__(self, language: str = "english"):
        """Initialize seed generator.
        
        Args:
            language: BIP39 language for mnemonic generation
        """
        self.mnemo = Mnemonic(language)
        
    def generate_from_burn(self, 
                          burn_tx_hash: str,
                          wallet_address: str,
                          node_type: str,
                          amount: int,
                          timestamp: Optional[int] = None) -> Tuple[str, str]:
        """Generate seed phrase from burn transaction data.
        
        Args:
            burn_tx_hash: Transaction hash of the burn
            wallet_address: Address that burned tokens
            node_type: Type of node (light/full/super)
            amount: Amount of tokens burned
            timestamp: Transaction timestamp (optional)
            
        Returns:
            Tuple of (mnemonic phrase, node_id)
        """
        # Create deterministic entropy from burn data
        entropy_data = f"{burn_tx_hash}:{wallet_address}:{node_type}:{amount}"
        if timestamp:
            entropy_data += f":{timestamp}"
        entropy_data += f":{QNET_SALT}"
        
        # Generate 512-bit hash
        full_hash = hashlib.sha512(entropy_data.encode()).digest()
        
        # Use first 256 bits for mnemonic
        entropy = full_hash[:32]
        
        # Generate BIP39 mnemonic
        mnemonic = self.mnemo.to_mnemonic(entropy)
        
        # Generate node ID from remaining bits
        node_id = hashlib.sha256(full_hash[32:]).hexdigest()[:16]
        
        return mnemonic, node_id
    
    def verify_mnemonic(self, mnemonic: str) -> bool:
        """Verify if a mnemonic is valid.
        
        Args:
            mnemonic: Mnemonic phrase to verify
            
        Returns:
            True if valid, False otherwise
        """
        return self.mnemo.check(mnemonic)
    
    def mnemonic_to_seed(self, mnemonic: str, passphrase: str = "") -> bytes:
        """Convert mnemonic to seed bytes.
        
        Args:
            mnemonic: BIP39 mnemonic phrase
            passphrase: Optional passphrase
            
        Returns:
            64-byte seed
        """
        return self.mnemo.to_seed(mnemonic, passphrase)
    
    def derive_keys(self, mnemonic: str) -> dict:
        """Derive various keys from mnemonic.
        
        Args:
            mnemonic: BIP39 mnemonic phrase
            
        Returns:
            Dictionary with derived keys
        """
        seed = self.mnemonic_to_seed(mnemonic)
        
        # Derive different keys for different purposes
        keys = {
            'node_identity': self._derive_key(seed, b"node_identity"),
            'consensus': self._derive_key(seed, b"consensus"),
            'networking': self._derive_key(seed, b"networking"),
            'encryption': self._derive_key(seed, b"encryption")
        }
        
        return keys
    
    def _derive_key(self, seed: bytes, purpose: bytes) -> dict:
        """Derive a key pair for specific purpose.
        
        Args:
            seed: Master seed
            purpose: Purpose identifier
            
        Returns:
            Dictionary with private and public keys
        """
        # Combine seed with purpose
        key_material = hashlib.sha512(seed + purpose).digest()
        
        # Use first 32 bytes as private key
        private_key = key_material[:32]
        
        # Derive public key (simplified - in production use proper curve)
        public_key = hashlib.sha256(private_key + b"public").digest()
        
        return {
            'private': private_key.hex(),
            'public': public_key.hex()
        }
    
    def generate_activation_proof(self, 
                                 mnemonic: str,
                                 burn_tx_hash: str,
                                 wallet_address: str) -> dict:
        """Generate activation proof for blockchain verification.
        
        Args:
            mnemonic: Node's mnemonic phrase
            burn_tx_hash: Burn transaction hash
            wallet_address: Original wallet address
            
        Returns:
            Activation proof dictionary
        """
        keys = self.derive_keys(mnemonic)
        
        proof = {
            'burn_tx_hash': burn_tx_hash,
            'wallet_address': wallet_address,
            'node_public_key': keys['node_identity']['public'],
            'consensus_public_key': keys['consensus']['public'],
            'timestamp': int(datetime.now().timestamp()),
            'version': 1
        }
        
        # Sign the proof (simplified - use proper signing in production)
        proof_data = json.dumps(proof, sort_keys=True)
        signature = hashlib.sha256(
            proof_data.encode() + 
            bytes.fromhex(keys['node_identity']['private'])
        ).hexdigest()
        
        proof['signature'] = signature
        
        return proof


# Utility functions for client-side generation
def generate_client_side_js() -> str:
    """Generate JavaScript code for client-side seed generation.
    
    Returns:
        JavaScript code as string
    """
    return '''
// Client-side seed generation for QNet nodes
async function generateNodeSeed(burnTxHash, walletAddress, nodeType, amount) {
    const QNET_SALT = "QNET_NODE_ACTIVATION_V1";
    
    // Create entropy string
    const entropyData = `${burnTxHash}:${walletAddress}:${nodeType}:${amount}:${QNET_SALT}`;
    
    // Generate SHA-512 hash
    const encoder = new TextEncoder();
    const data = encoder.encode(entropyData);
    const hashBuffer = await crypto.subtle.digest('SHA-512', data);
    const hashArray = new Uint8Array(hashBuffer);
    
    // Use first 32 bytes for entropy
    const entropy = hashArray.slice(0, 32);
    
    // Generate mnemonic using bip39 library
    // Note: Include bip39.js library in your project
    const mnemonic = bip39.entropyToMnemonic(Buffer.from(entropy));
    
    // Generate node ID
    const nodeIdData = hashArray.slice(32);
    const nodeIdBuffer = await crypto.subtle.digest('SHA-256', nodeIdData);
    const nodeIdArray = new Uint8Array(nodeIdBuffer);
    const nodeId = Array.from(nodeIdArray.slice(0, 8))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    
    return {
        mnemonic: mnemonic,
        nodeId: nodeId
    };
}

// Verify mnemonic on client side
function verifyMnemonic(mnemonic) {
    return bip39.validateMnemonic(mnemonic);
}
'''


if __name__ == "__main__":
    # Example usage
    generator = SeedGenerator()
    
    # Simulate burn transaction data
    burn_tx = "5a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6"
    wallet = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty"
    node_type = "full"
    amount = 1500
    
    # Generate seed
    mnemonic, node_id = generator.generate_from_burn(
        burn_tx, wallet, node_type, amount
    )
    
    print(f"Generated mnemonic: {mnemonic}")
    print(f"Node ID: {node_id}")
    
    # Verify and derive keys
    if generator.verify_mnemonic(mnemonic):
        keys = generator.derive_keys(mnemonic)
        print(f"Node public key: {keys['node_identity']['public']}") 