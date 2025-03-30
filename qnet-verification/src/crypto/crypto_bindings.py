#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: crypto_bindings.py
Enhanced bindings to Rust cryptographic functions with Python fallbacks.
Supports multiple post-quantum algorithms from NIST standards.
"""

import os
import ctypes
import json
from ctypes import c_char_p, c_bool, c_uint64
import hashlib
import logging
import platform

# Paths to Rust library
_lib_paths = [
    # Try different locations for the library
    os.path.join(os.path.dirname(__file__), "../rust/target/release/libqnet_core.so"),
    os.path.join(os.path.dirname(__file__), "../rust/target/release/libqnet_core.dylib"),
    os.path.join(os.path.dirname(__file__), "libqnet_core.so"),
    "/usr/local/lib/libqnet_core.so",
    "/usr/lib/libqnet_core.so",
]

# Add platform-specific library extensions
if platform.system() == "Windows":
    _lib_paths.extend([
        os.path.join(os.path.dirname(__file__), "../rust/target/release/qnet_core.dll"),
        os.path.join(os.path.dirname(__file__), "qnet_core.dll"),
    ])
elif platform.system() == "Darwin":  # macOS
    _lib_paths.extend([
        os.path.join(os.path.dirname(__file__), "../rust/target/release/libqnet_core.dylib"),
        os.path.join(os.path.dirname(__file__), "libqnet_core.dylib"),
    ])

_lib = None

# Try to load the library
for path in _lib_paths:
    if os.path.exists(path):
        try:
            _lib = ctypes.CDLL(path)
            logging.info(f"Loaded Rust library from {path}")
            break
        except Exception as e:
            logging.warning(f"Could not load library from {path}: {e}")

# If not found in predefined paths, try to find in system paths
if _lib is None:
    try:
        import ctypes.util
        lib_path = ctypes.util.find_library('qnet_core')
        if lib_path:
            try:
                _lib = ctypes.CDLL(lib_path)
                logging.info(f"Loaded Rust library from system: {lib_path}")
            except Exception as e:
                logging.warning(f"Failed to load system library: {e}")
    except Exception as e:
        logging.warning(f"Error searching for system library: {e}")

# Check if library was loaded
if _lib is None:
    logging.warning("Could not load Rust library. Falling back to Python implementation.")

# Supported PQ Algorithms
class PQAlgorithm:
    DILITHIUM2 = "Dilithium2"
    DILITHIUM3 = "Dilithium3"
    DILITHIUM5 = "Dilithium5"
    FALCON512 = "Falcon512"
    FALCON1024 = "Falcon1024"
    SPHINCS_SHAKE128S = "SPHINCS+-SHAKE128s-simple"

# Enhanced Cryptography functions with PQ support
class CryptoRust:
    @staticmethod
    def verify_signature(message, signature_hex, public_key_hex, algorithm=PQAlgorithm.DILITHIUM2):
        """Verifies post-quantum signature via Rust"""
        if _lib is None:
            # Fallback to Python implementation
            return CryptoPython.verify_signature(message, signature_hex, public_key_hex, algorithm)
            
        _lib.verify_pq_signature.argtypes = [c_char_p, c_char_p, c_char_p, c_char_p]
        _lib.verify_pq_signature.restype = c_bool
        
        message_bytes = message.encode('utf-8') if isinstance(message, str) else message
        sig_bytes = signature_hex.encode('utf-8') if isinstance(signature_hex, str) else signature_hex
        pk_bytes = public_key_hex.encode('utf-8') if isinstance(public_key_hex, str) else public_key_hex
        algo_bytes = algorithm.encode('utf-8') if isinstance(algorithm, str) else algorithm
        
        return _lib.verify_pq_signature(message_bytes, sig_bytes, pk_bytes, algo_bytes)
    
    @staticmethod
    def generate_keypair(algorithm=PQAlgorithm.DILITHIUM2):
        """Generates a new post-quantum keypair via Rust"""
        if _lib is None:
            # Fallback to Python implementation
            return CryptoPython.generate_keypair(algorithm)
            
        _lib.generate_pq_keypair.argtypes = [c_char_p]
        _lib.generate_pq_keypair.restype = c_char_p
        _lib.free_keypair.argtypes = [c_char_p]
        _lib.free_keypair.restype = None
        
        algo_bytes = algorithm.encode('utf-8') if isinstance(algorithm, str) else algorithm
        
        result_ptr = _lib.generate_pq_keypair(algo_bytes)
        if not result_ptr:
            logging.warning(f"Failed to generate keypair for {algorithm} in Rust, falling back to Python")
            return CryptoPython.generate_keypair(algorithm)
        
        try:
            result = ctypes.cast(result_ptr, c_char_p).value.decode('utf-8')
            public_key, secret_key = result.split(':', 1)
            return public_key, secret_key
        except Exception as e:
            logging.error(f"Error processing keypair result: {e}")
            return CryptoPython.generate_keypair(algorithm)
        finally:
            if result_ptr:
                _lib.free_keypair(result_ptr)
                
    @staticmethod
    def sign_message(message, secret_key_hex, algorithm=PQAlgorithm.DILITHIUM2):
        """Signs a message using post-quantum algorithm via Rust"""
        if _lib is None:
            # Fallback to Python implementation
            return CryptoPython.sign_message(message, secret_key_hex, algorithm)
            
        _lib.sign_message_pq.argtypes = [c_char_p, c_char_p, c_char_p]
        _lib.sign_message_pq.restype = c_char_p
        _lib.free_string.argtypes = [c_char_p]
        _lib.free_string.restype = None
        
        message_bytes = message.encode('utf-8') if isinstance(message, str) else message
        sk_bytes = secret_key_hex.encode('utf-8') if isinstance(secret_key_hex, str) else secret_key_hex
        algo_bytes = algorithm.encode('utf-8') if isinstance(algorithm, str) else algorithm
        
        result_ptr = _lib.sign_message_pq(message_bytes, sk_bytes, algo_bytes)
        if not result_ptr:
            logging.warning(f"Failed to sign message using {algorithm} in Rust, falling back to Python")
            return CryptoPython.sign_message(message, secret_key_hex, algorithm)
        
        try:
            signature = ctypes.cast(result_ptr, c_char_p).value.decode('utf-8')
            return signature
        except Exception as e:
            logging.error(f"Error processing signature result: {e}")
            return CryptoPython.sign_message(message, secret_key_hex, algorithm)
        finally:
            if result_ptr:
                _lib.free_string(result_ptr)
                
    @staticmethod
    def get_algorithm_info():
        """Get information about available post-quantum algorithms"""
        if _lib is None:
            # Fallback to Python implementation
            return {}
            
        _lib.get_pq_algorithm_info.argtypes = []
        _lib.get_pq_algorithm_info.restype = c_char_p
        _lib.free_string.argtypes = [c_char_p]
        _lib.free_string.restype = None
        
        result_ptr = _lib.get_pq_algorithm_info()
        if not result_ptr:
            logging.warning("Failed to get algorithm info from Rust")
            return {}
        
        try:
            info_json = ctypes.cast(result_ptr, c_char_p).value.decode('utf-8')
            return json.loads(info_json)
        except Exception as e:
            logging.error(f"Error processing algorithm info: {e}")
            return {}
        finally:
            if result_ptr:
                _lib.free_string(result_ptr)

class MerkleRust:
    @staticmethod
    def compute_merkle_root(transaction_hashes):
        """Computes Merkle root from transaction hashes"""
        if _lib is None:
            # Fallback to Python implementation
            return MerklePython.compute_merkle_root(transaction_hashes)
            
        _lib.compute_merkle_root.argtypes = [c_char_p, c_uint64]
        _lib.compute_merkle_root.restype = c_char_p
        _lib.free_string.argtypes = [c_char_p]
        _lib.free_string.restype = None
        
        # Serialize hash list to JSON
        json_str = json.dumps(transaction_hashes).encode('utf-8')
        
        # Call Rust function
        result_ptr = _lib.compute_merkle_root(json_str, len(transaction_hashes))
        if not result_ptr:
            logging.warning("Failed to compute Merkle root in Rust, falling back to Python")
            return MerklePython.compute_merkle_root(transaction_hashes)
        
        try:
            merkle_root = ctypes.cast(result_ptr, c_char_p).value.decode('utf-8')
            return merkle_root
        except Exception as e:
            logging.error(f"Error processing Merkle root result: {e}")
            return MerklePython.compute_merkle_root(transaction_hashes)
        finally:
            if result_ptr:
                _lib.free_string(result_ptr)
                
    @staticmethod
    def generate_merkle_proof(transaction_hashes, tx_index):
        """Generates a Merkle proof for a transaction"""
        if _lib is None:
            # Fallback to Python implementation
            return MerklePython.generate_merkle_proof(transaction_hashes, tx_index)
            
        _lib.generate_merkle_proof.argtypes = [c_char_p, c_uint64]
        _lib.generate_merkle_proof.restype = c_char_p
        _lib.free_string.argtypes = [c_char_p]
        _lib.free_string.restype = None
        
        # Serialize hash list to JSON
        json_str = json.dumps(transaction_hashes).encode('utf-8')
        
        # Call Rust function
        result_ptr = _lib.generate_merkle_proof(json_str, tx_index)
        if not result_ptr:
            logging.warning("Failed to generate Merkle proof in Rust, falling back to Python")
            return MerklePython.generate_merkle_proof(transaction_hashes, tx_index)
        
        try:
            proof_json = ctypes.cast(result_ptr, c_char_p).value.decode('utf-8')
            return json.loads(proof_json)
        except Exception as e:
            logging.error(f"Error processing Merkle proof: {e}")
            return MerklePython.generate_merkle_proof(transaction_hashes, tx_index)
        finally:
            if result_ptr:
                _lib.free_string(result_ptr)
                
    @staticmethod
    def verify_merkle_proof(tx_hash, merkle_root, merkle_proof):
        """Verifies a Merkle proof"""
        if _lib is None:
            # Fallback to Python implementation
            return MerklePython.verify_merkle_proof(tx_hash, merkle_root, merkle_proof)
        
        # For now, use Python implementation as the Rust version
        # needs more complex argument passing
        return MerklePython.verify_merkle_proof(tx_hash, merkle_root, merkle_proof)

# Python fallback implementations
class CryptoPython:
    @staticmethod
    def verify_signature(message, signature_hex, public_key_hex, algorithm=PQAlgorithm.DILITHIUM2):
        """Python implementation of signature verification (simplified)"""
        logging.warning(f"Using Python fallback for {algorithm} signature verification")
        
        # This is a placeholder for actual PQ verification
        # In a production environment, this would need to be properly implemented
        return True
    
    @staticmethod
    def generate_keypair(algorithm=PQAlgorithm.DILITHIUM2):
        """Python implementation of keypair generation (simplified)"""
        logging.warning(f"Using Python fallback for {algorithm} keypair generation")
        import os
        # These are not actual PQ keys, just placeholders
        pub_key = os.urandom(32).hex()
        sec_key = os.urandom(64).hex()
        return pub_key, sec_key
        
    @staticmethod
    def sign_message(message, secret_key_hex, algorithm=PQAlgorithm.DILITHIUM2):
        """Python implementation of message signing (simplified)"""
        logging.warning(f"Using Python fallback for {algorithm} message signing")
        import os
        # This is a placeholder for actual PQ signing
        signature = os.urandom(64).hex()
        return signature

class MerklePython:
    @staticmethod
    def compute_merkle_root(transaction_hashes):
        """Python implementation of Merkle root computation"""
        if not transaction_hashes:
            return hashlib.sha256(b"").hexdigest()
            
        if len(transaction_hashes) == 1:
            return transaction_hashes[0]
            
        # Function for recursive tree building
        def build_tree(hashes):
            if len(hashes) == 1:
                return hashes[0]
                
            new_level = []
            # Process hash pairs
            for i in range(0, len(hashes), 2):
                if i + 1 < len(hashes):
                    combined = hashes[i] + hashes[i + 1]
                else:
                    combined = hashes[i] + hashes[i]  # Duplicate last element if odd number
                    
                new_hash = hashlib.sha256(combined.encode()).hexdigest()
                new_level.append(new_hash)
                
            # Recursively build next level
            return build_tree(new_level)
            
        return build_tree(transaction_hashes)
        
    @staticmethod
    def generate_merkle_proof(transaction_hashes, tx_index):
        """Generate a Merkle proof for a transaction"""
        if not transaction_hashes:
            return []
            
        if tx_index >= len(transaction_hashes):
            return []
            
        proof = []
        current_hashes = transaction_hashes.copy()
        current_index = tx_index
        
        while len(current_hashes) > 1:
            is_odd_index = current_index % 2 == 1
            pair_index = current_index - 1 if is_odd_index else current_index + 1
            
            if 0 <= pair_index < len(current_hashes):
                # Add the sibling to the proof
                proof.append((current_hashes[pair_index], not is_odd_index))
            else:
                # If no sibling (odd number of elements at the end), use self
                proof.append((current_hashes[current_index], False))
                
            # Move to next level
            next_level = []
            for i in range(0, len(current_hashes), 2):
                left = current_hashes[i]
                right = current_hashes[i + 1] if i + 1 < len(current_hashes) else left
                
                combined = left + right
                new_hash = hashlib.sha256(combined.encode()).hexdigest()
                next_level.append(new_hash)
                
            current_index = current_index // 2
            current_hashes = next_level
            
        return proof
        
    @staticmethod
    def verify_merkle_proof(tx_hash, merkle_root, merkle_proof):
        """Verify a Merkle proof"""
        current_hash = tx_hash
        
        for proof_hash, is_left in merkle_proof:
            if is_left:
                combined = proof_hash + current_hash
            else:
                combined = current_hash + proof_hash
                
            current_hash = hashlib.sha256(combined.encode()).hexdigest()
            
        return current_hash == merkle_root

# Export interfaces for use in main code
verify_signature = CryptoRust.verify_signature
generate_keypair = CryptoRust.generate_keypair
sign_message = CryptoRust.sign_message
compute_merkle_root = MerkleRust.compute_merkle_root
generate_merkle_proof = MerkleRust.generate_merkle_proof
verify_merkle_proof = MerkleRust.verify_merkle_proof
get_algorithm_info = CryptoRust.get_algorithm_info