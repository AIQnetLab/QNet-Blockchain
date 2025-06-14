"""
QNet Wallet Security Module - Simplified Version
Simple encryption without external dependencies
Production-ready implementation for secure wallet storage
June 2025 - Q3 Launch Ready
"""

import hashlib
import secrets
import string
import json
import base64
import re
from typing import Dict, Tuple, Optional


class WalletSecurityError(Exception):
    """Wallet security error"""
    pass


class WalletSecurity:
    """
    Production-ready wallet security implementation
    Simple encryption without external dependencies
    """
    
    def __init__(self):
        """Initialize wallet security"""
        self.salt_length = 32  # 256 bits
        self.key_length = 32   # 256 bits
        self.iv_length = 16    # 128 bits
        self.iterations = 100000  # PBKDF2 iterations
        
    def validate_password_strength(self, password: str) -> Dict[str, any]:
        """Validate password strength"""
        if not password:
            return {
                'valid': False,
                'strength': 'Empty',
                'score': 0,
                'requirements': []
            }
        
        score = 0
        requirements = []
        
        # Length check
        if len(password) >= 12:
            score += 2
            requirements.append("✓ Length >= 12 characters")
        else:
            requirements.append("✗ Length >= 12 characters")
        
        # Character checks
        if re.search(r'[A-Z]', password):
            score += 1
            requirements.append("✓ Contains uppercase letters")
        else:
            requirements.append("✗ Contains uppercase letters")
        
        if re.search(r'[a-z]', password):
            score += 1
            requirements.append("✓ Contains lowercase letters")
        else:
            requirements.append("✗ Contains lowercase letters")
        
        if re.search(r'[0-9]', password):
            score += 1
            requirements.append("✓ Contains numbers")
        else:
            requirements.append("✗ Contains numbers")
        
        if re.search(r'[!@#$%^&*(),.?":{}|<>]', password):
            score += 1
            requirements.append("✓ Contains special characters")
        else:
            requirements.append("✗ Contains special characters")
        
        # Common password check
        common_passwords = ['password', 'qwerty', '123456', 'admin', 'password123']
        if password.lower() not in common_passwords:
            score += 1
            requirements.append("✓ Not a common password")
        else:
            score -= 2
            requirements.append("✗ Common password detected")
        
        # Determine strength
        if score >= 6:
            strength = "Very Strong"
            valid = True
        elif score >= 5:
            strength = "Strong" 
            valid = True
        elif score >= 4:
            strength = "Medium"
            valid = True
        else:
            strength = "Weak"
            valid = False
        
        return {
            'valid': valid,
            'strength': strength,
            'score': score,
            'requirements': requirements
        }
        
    def generate_secure_password(self, length: int = 32) -> str:
        """Generate cryptographically secure password"""
        if length < 12:
            length = 12
            
        # Character sets
        lowercase = string.ascii_lowercase
        uppercase = string.ascii_uppercase
        digits = string.digits
        special = "!@#$%^&*(),.?\":{}|<>"
        
        # Ensure at least one character from each set
        password = [
            secrets.choice(lowercase),
            secrets.choice(uppercase), 
            secrets.choice(digits),
            secrets.choice(special)
        ]
        
        # Fill remaining length
        all_chars = lowercase + uppercase + digits + special
        for _ in range(length - 4):
            password.append(secrets.choice(all_chars))
        
        # Shuffle
        secrets.SystemRandom().shuffle(password)
        
        return ''.join(password)
        
    def _derive_key(self, password: str, salt: bytes) -> bytes:
        """Derive key using PBKDF2"""
        password_bytes = password.encode('utf-8')
        return hashlib.pbkdf2_hmac('sha256', password_bytes, salt, self.iterations)[:self.key_length]
        
    def encrypt_wallet(self, wallet_data: str, password: str) -> str:
        """Encrypt wallet data"""
        try:
            # Validate password
            validation = self.validate_password_strength(password)
            if not validation['valid']:
                raise WalletSecurityError(f"Password too weak: {validation['strength']}")
            
            # Generate salt and IV
            salt = secrets.token_bytes(self.salt_length)
            iv = secrets.token_bytes(self.iv_length)
            
            # Derive key
            key = self._derive_key(password, salt)
            
            # Simple stream cipher (XOR with key stream)
            data_bytes = wallet_data.encode('utf-8')
            
            # Create key stream
            key_stream = b''
            counter = 0
            while len(key_stream) < len(data_bytes):
                hasher = hashlib.sha256()
                hasher.update(key)
                hasher.update(iv)
                hasher.update(counter.to_bytes(4, 'big'))
                key_stream += hasher.digest()
                counter += 1
            
            # Encrypt with XOR
            ciphertext = bytes(a ^ b for a, b in zip(data_bytes, key_stream[:len(data_bytes)]))
            
            # Create authentication tag
            auth_data = salt + iv + ciphertext
            auth_tag = hashlib.sha256(key + auth_data).digest()[:16]
            
            # Package result
            encrypted_data = {
                'version': '1.0',
                'algorithm': 'Stream-Cipher-SHA256',
                'kdf': 'PBKDF2',
                'iterations': self.iterations,
                'salt': base64.b64encode(salt).decode('utf-8'),
                'iv': base64.b64encode(iv).decode('utf-8'),
                'tag': base64.b64encode(auth_tag).decode('utf-8'),
                'ciphertext': base64.b64encode(ciphertext).decode('utf-8')
            }
            
            return base64.b64encode(json.dumps(encrypted_data).encode('utf-8')).decode('utf-8')
            
        except Exception as e:
            raise WalletSecurityError(f"Encryption failed: {str(e)}")
            
    def decrypt_wallet(self, encrypted_data: str, password: str) -> str:
        """Decrypt wallet data"""
        try:
            # Decode
            encrypted_json = base64.b64decode(encrypted_data.encode('utf-8')).decode('utf-8')
            data = json.loads(encrypted_json)
            
            # Extract components
            salt = base64.b64decode(data['salt'])
            iv = base64.b64decode(data['iv'])
            tag = base64.b64decode(data['tag'])
            ciphertext = base64.b64decode(data['ciphertext'])
            
            # Derive key
            key = self._derive_key(password, salt)
            
            # Verify authentication
            auth_data = salt + iv + ciphertext
            expected_tag = hashlib.sha256(key + auth_data).digest()[:16]
            if not secrets.compare_digest(tag, expected_tag):
                raise WalletSecurityError("Authentication failed")
            
            # Create key stream
            key_stream = b''
            counter = 0
            while len(key_stream) < len(ciphertext):
                hasher = hashlib.sha256()
                hasher.update(key)
                hasher.update(iv)
                hasher.update(counter.to_bytes(4, 'big'))
                key_stream += hasher.digest()
                counter += 1
            
            # Decrypt
            plaintext = bytes(a ^ b for a, b in zip(ciphertext, key_stream[:len(ciphertext)]))
            
            return plaintext.decode('utf-8')
            
        except Exception as e:
            raise WalletSecurityError(f"Decryption failed: {str(e)}")
            
    def hash_with_salt(self, password: str, salt: Optional[bytes] = None) -> Tuple[str, bytes]:
        """Hash password with salt"""
        if salt is None:
            salt = secrets.token_bytes(self.salt_length)
        key = self._derive_key(password, salt)
        return base64.b64encode(key).decode('utf-8'), salt
        
    def verify_hash_with_salt(self, password: str, hash_b64: str, salt: bytes) -> bool:
        """Verify password against hash"""
        try:
            key = self._derive_key(password, salt)
            stored_key = base64.b64decode(hash_b64)
            return secrets.compare_digest(key, stored_key)
        except Exception:
            return False 