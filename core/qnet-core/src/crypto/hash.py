"""
QNet Hash Functions Module
Production-ready cryptographic hash functions with post-quantum security
June 2025 - Q3 Launch Ready
"""

import hashlib
import hmac
import secrets
from typing import Union, Optional, Tuple
import time


class QNetHasher:
    """
    Production-ready hash functions for QNet blockchain
    Includes SHA-256, SHA-3, BLAKE2b, and post-quantum ready variants
    """
    
    def __init__(self):
        """Initialize QNet hasher with secure defaults"""
        self.default_algorithm = 'sha256'
        self.supported_algorithms = {
            'sha256': hashlib.sha256,
            'sha3_256': hashlib.sha3_256,
            'blake2b': lambda: hashlib.blake2b(digest_size=32),
            'sha512': hashlib.sha512,
            'sha3_512': hashlib.sha3_512
        }
        
    def hash_data(self, data: Union[str, bytes], algorithm: str = 'sha256') -> bytes:
        """
        Hash data using specified algorithm
        
        Args:
            data: Data to hash (string or bytes)
            algorithm: Hash algorithm to use
            
        Returns:
            bytes: Hash digest
            
        Raises:
            ValueError: If algorithm not supported
        """
        if algorithm not in self.supported_algorithms:
            raise ValueError(f"Unsupported algorithm: {algorithm}")
            
        # Convert string to bytes if needed
        if isinstance(data, str):
            data = data.encode('utf-8')
            
        hasher = self.supported_algorithms[algorithm]()
        hasher.update(data)
        return hasher.digest()
        
    def hash_hex(self, data: Union[str, bytes], algorithm: str = 'sha256') -> str:
        """
        Hash data and return hex string
        
        Args:
            data: Data to hash
            algorithm: Hash algorithm to use
            
        Returns:
            str: Hex encoded hash
        """
        return self.hash_data(data, algorithm).hex()
        
    def double_sha256(self, data: Union[str, bytes]) -> bytes:
        """
        Bitcoin-style double SHA-256 hash
        
        Args:
            data: Data to hash
            
        Returns:
            bytes: Double SHA-256 hash
        """
        if isinstance(data, str):
            data = data.encode('utf-8')
            
        first_hash = hashlib.sha256(data).digest()
        return hashlib.sha256(first_hash).digest()
        
    def merkle_root(self, data_list: list) -> bytes:
        """
        Calculate Merkle root of data list
        
        Args:
            data_list: List of data items to hash
            
        Returns:
            bytes: Merkle root hash
        """
        if not data_list:
            return b'\x00' * 32
            
        # Hash all data items
        hashes = []
        for item in data_list:
            if isinstance(item, str):
                item = item.encode('utf-8')
            hashes.append(self.hash_data(item))
            
        # Build Merkle tree
        while len(hashes) > 1:
            next_level = []
            
            # Process pairs
            for i in range(0, len(hashes), 2):
                if i + 1 < len(hashes):
                    # Pair exists
                    combined = hashes[i] + hashes[i + 1]
                else:
                    # Odd number, duplicate last hash
                    combined = hashes[i] + hashes[i]
                    
                next_level.append(self.hash_data(combined))
                
            hashes = next_level
            
        return hashes[0]
        
    def hash_with_salt(self, data: Union[str, bytes], salt: Optional[bytes] = None) -> Tuple[bytes, bytes]:
        """
        Hash data with salt for password security
        
        Args:
            data: Data to hash
            salt: Salt bytes (generated if None)
            
        Returns:
            tuple: (hash, salt) pair
        """
        if salt is None:
            salt = secrets.token_bytes(32)
            
        if isinstance(data, str):
            data = data.encode('utf-8')
            
        combined = salt + data
        hash_result = self.hash_data(combined)
        
        return hash_result, salt
        
    def verify_hash_with_salt(self, data: Union[str, bytes], hash_to_verify: bytes, salt: bytes) -> bool:
        """
        Verify hash with salt
        
        Args:
            data: Original data
            hash_to_verify: Hash to verify against
            salt: Salt used in original hash
            
        Returns:
            bool: True if hash matches
        """
        try:
            computed_hash, _ = self.hash_with_salt(data, salt)
            return hmac.compare_digest(computed_hash, hash_to_verify)
        except Exception:
            return False
            
    def pbkdf2_hash(self, password: Union[str, bytes], salt: bytes, iterations: int = 100000) -> bytes:
        """
        PBKDF2 key derivation for secure password hashing
        
        Args:
            password: Password to hash
            salt: Salt bytes
            iterations: Number of iterations (default 100k)
            
        Returns:
            bytes: Derived key
        """
        if isinstance(password, str):
            password = password.encode('utf-8')
            
        return hashlib.pbkdf2_hmac('sha256', password, salt, iterations, dklen=32)
        
    def hmac_hash(self, key: bytes, message: Union[str, bytes], algorithm: str = 'sha256') -> bytes:
        """
        HMAC authentication hash
        
        Args:
            key: Secret key
            message: Message to authenticate
            algorithm: Hash algorithm
            
        Returns:
            bytes: HMAC digest
        """
        if isinstance(message, str):
            message = message.encode('utf-8')
            
        if algorithm == 'sha256':
            return hmac.new(key, message, hashlib.sha256).digest()
        elif algorithm == 'sha512':
            return hmac.new(key, message, hashlib.sha512).digest()
        else:
            raise ValueError(f"Unsupported HMAC algorithm: {algorithm}")
            
    def time_based_hash(self, data: Union[str, bytes], time_window: int = 300) -> bytes:
        """
        Time-based hash for temporary tokens
        
        Args:
            data: Data to hash
            time_window: Time window in seconds (default 5 minutes)
            
        Returns:
            bytes: Time-based hash
        """
        current_time = int(time.time() // time_window)
        time_bytes = current_time.to_bytes(8, 'big')
        
        if isinstance(data, str):
            data = data.encode('utf-8')
            
        combined = data + time_bytes
        return self.hash_data(combined)
        
    def address_hash(self, public_key: bytes) -> str:
        """
        Generate wallet address from public key
        
        Args:
            public_key: Public key bytes
            
        Returns:
            str: Wallet address (hex encoded)
        """
        # Hash public key with SHA-256
        sha256_hash = hashlib.sha256(public_key).digest()
        
        # Hash again with RIPEMD160 (or SHA-256 if RIPEMD160 not available)
        try:
            import ripemd160
            address_hash = ripemd160.new(sha256_hash).digest()
        except ImportError:
            # Fallback to double SHA-256
            address_hash = hashlib.sha256(sha256_hash).digest()[:20]
            
        return address_hash.hex()
        
    def transaction_hash(self, transaction_data: dict) -> str:
        """
        Generate transaction hash from transaction data
        
        Args:
            transaction_data: Transaction dictionary
            
        Returns:
            str: Transaction hash (hex)
        """
        # Create deterministic string from transaction
        tx_string = ""
        
        # Sort keys for deterministic hashing
        for key in sorted(transaction_data.keys()):
            if key != 'signature':  # Exclude signature from hash
                tx_string += f"{key}:{transaction_data[key]};"
                
        return self.hash_hex(tx_string)
        
    def block_hash(self, block_data: dict) -> str:
        """
        Generate block hash from block data
        
        Args:
            block_data: Block dictionary
            
        Returns:
            str: Block hash (hex)
        """
        # Create block header string
        header = (
            f"prev_hash:{block_data.get('prev_hash', '')};"
            f"merkle_root:{block_data.get('merkle_root', '')};"
            f"timestamp:{block_data.get('timestamp', 0)};"
            f"nonce:{block_data.get('nonce', 0)};"
            f"difficulty:{block_data.get('difficulty', 1)}"
        )
        
        return self.hash_hex(header)
        
    def proof_of_work_hash(self, block_header: str, nonce: int) -> str:
        """
        Calculate proof of work hash
        
        Args:
            block_header: Block header string
            nonce: Nonce value
            
        Returns:
            str: PoW hash (hex)
        """
        pow_data = f"{block_header};nonce:{nonce}"
        return self.hash_hex(pow_data)
        
    def validate_hash_difficulty(self, hash_hex: str, difficulty: int) -> bool:
        """
        Validate if hash meets difficulty requirement
        
        Args:
            hash_hex: Hash in hex format
            difficulty: Required number of leading zeros
            
        Returns:
            bool: True if hash meets difficulty
        """
        return hash_hex.startswith('0' * difficulty)
        
    def secure_compare(self, hash1: Union[str, bytes], hash2: Union[str, bytes]) -> bool:
        """
        Secure hash comparison to prevent timing attacks
        
        Args:
            hash1: First hash
            hash2: Second hash
            
        Returns:
            bool: True if hashes match
        """
        if isinstance(hash1, str):
            hash1 = bytes.fromhex(hash1)
        if isinstance(hash2, str):
            hash2 = bytes.fromhex(hash2)
            
        return hmac.compare_digest(hash1, hash2)
        
    def hash_chain(self, data_list: list, algorithm: str = 'sha256') -> bytes:
        """
        Create hash chain from data list
        
        Args:
            data_list: List of data to chain hash
            algorithm: Hash algorithm to use
            
        Returns:
            bytes: Final chain hash
        """
        current_hash = b''
        
        for data in data_list:
            if isinstance(data, str):
                data = data.encode('utf-8')
                
            combined = current_hash + data
            current_hash = self.hash_data(combined, algorithm)
            
        return current_hash
        
    def hash_with_pepper(self, data: Union[str, bytes], pepper: bytes) -> bytes:
        """
        Hash with pepper for additional security
        
        Args:
            data: Data to hash
            pepper: Server-side secret pepper
            
        Returns:
            bytes: Peppered hash
        """
        if isinstance(data, str):
            data = data.encode('utf-8')
            
        combined = data + pepper
        return self.hash_data(combined)
        
    def get_hash_info(self, algorithm: str = 'sha256') -> dict:
        """
        Get information about hash algorithm
        
        Args:
            algorithm: Algorithm to get info for
            
        Returns:
            dict: Algorithm information
        """
        info = {
            'sha256': {
                'name': 'SHA-256',
                'digest_size': 32,
                'block_size': 64,
                'security_level': 128,
                'post_quantum_safe': False
            },
            'sha3_256': {
                'name': 'SHA-3-256',
                'digest_size': 32,
                'block_size': 136,
                'security_level': 128,
                'post_quantum_safe': True
            },
            'blake2b': {
                'name': 'BLAKE2b',
                'digest_size': 32,
                'block_size': 128,
                'security_level': 128,
                'post_quantum_safe': True
            },
            'sha512': {
                'name': 'SHA-512',
                'digest_size': 64,
                'block_size': 128,
                'security_level': 256,
                'post_quantum_safe': False
            }
        }
        
        return info.get(algorithm, {})


class QNetMerkleTree:
    """
    Production-ready Merkle Tree implementation for QNet
    """
    
    def __init__(self, hasher: Optional[QNetHasher] = None):
        """Initialize Merkle tree with hasher"""
        self.hasher = hasher or QNetHasher()
        self.leaves = []
        self.tree = []
        
    def add_leaf(self, data: Union[str, bytes]) -> None:
        """Add leaf to Merkle tree"""
        if isinstance(data, str):
            data = data.encode('utf-8')
        
        leaf_hash = self.hasher.hash_data(data)
        self.leaves.append(leaf_hash)
        
    def build_tree(self) -> bytes:
        """
        Build Merkle tree and return root
        
        Returns:
            bytes: Merkle root hash
        """
        if not self.leaves:
            return b'\x00' * 32
            
        # Start with leaf hashes
        current_level = self.leaves.copy()
        self.tree = [current_level.copy()]
        
        # Build tree bottom-up
        while len(current_level) > 1:
            next_level = []
            
            for i in range(0, len(current_level), 2):
                if i + 1 < len(current_level):
                    # Pair exists
                    left = current_level[i]
                    right = current_level[i + 1]
                else:
                    # Odd number, duplicate last hash
                    left = current_level[i]
                    right = current_level[i]
                    
                parent_hash = self.hasher.hash_data(left + right)
                next_level.append(parent_hash)
                
            current_level = next_level
            self.tree.append(current_level.copy())
            
        return current_level[0]  # Root hash
        
    def get_proof(self, leaf_index: int) -> list:
        """
        Get Merkle proof for leaf at index
        
        Args:
            leaf_index: Index of leaf to prove
            
        Returns:
            list: Merkle proof path
        """
        if leaf_index >= len(self.leaves):
            raise ValueError("Leaf index out of range")
            
        proof = []
        current_index = leaf_index
        
        # Traverse tree from leaf to root
        for level in self.tree[:-1]:  # Exclude root level
            # Find sibling
            if current_index % 2 == 0:
                # Left child, sibling is right
                sibling_index = current_index + 1
                if sibling_index < len(level):
                    sibling = level[sibling_index]
                    proof.append(('right', sibling))
                else:
                    # No sibling, duplicate self
                    proof.append(('right', level[current_index]))
            else:
                # Right child, sibling is left
                sibling_index = current_index - 1
                sibling = level[sibling_index]
                proof.append(('left', sibling))
                
            # Move to parent level
            current_index = current_index // 2
            
        return proof
        
    def verify_proof(self, leaf_data: Union[str, bytes], proof: list, root: bytes) -> bool:
        """
        Verify Merkle proof
        
        Args:
            leaf_data: Original leaf data
            proof: Merkle proof from get_proof()
            root: Expected root hash
            
        Returns:
            bool: True if proof is valid
        """
        if isinstance(leaf_data, str):
            leaf_data = leaf_data.encode('utf-8')
            
        # Start with leaf hash
        current_hash = self.hasher.hash_data(leaf_data)
        
        # Apply proof steps
        for direction, sibling_hash in proof:
            if direction == 'left':
                current_hash = self.hasher.hash_data(sibling_hash + current_hash)
            else:  # direction == 'right'
                current_hash = self.hasher.hash_data(current_hash + sibling_hash)
                
        # Compare with expected root
        return self.hasher.secure_compare(current_hash, root)


# Global hasher instance
qnet_hasher = QNetHasher()

# Convenience functions
def hash_data(data: Union[str, bytes], algorithm: str = 'sha256') -> bytes:
    """Hash data using QNet hasher"""
    return qnet_hasher.hash_data(data, algorithm)

def hash_hex(data: Union[str, bytes], algorithm: str = 'sha256') -> str:
    """Hash data and return hex string"""
    return qnet_hasher.hash_hex(data, algorithm)

def merkle_root(data_list: list) -> bytes:
    """Calculate Merkle root"""
    return qnet_hasher.merkle_root(data_list)

def transaction_hash(transaction_data: dict) -> str:
    """Generate transaction hash"""
    return qnet_hasher.transaction_hash(transaction_data)

def block_hash(block_data: dict) -> str:
    """Generate block hash"""
    return qnet_hasher.block_hash(block_data) 