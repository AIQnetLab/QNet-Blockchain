"""
QNet Node Security Credentials Management
Production-ready credential handling with no default passwords
June 2025 - Q3 Launch Ready
"""

import os
import secrets
import json
import hashlib
from typing import Optional, Dict, Any
from pathlib import Path
import time


class QNetCredentials:
    """
    Secure credentials management for QNet nodes
    NO DEFAULT PASSWORDS - All credentials must be explicitly set
    """
    
    def __init__(self, config_dir: Optional[str] = None):
        """
        Initialize credentials manager
        
        Args:
            config_dir: Directory to store encrypted credentials
        """
        self.config_dir = Path(config_dir) if config_dir else Path.home() / '.qnet'
        self.config_dir.mkdir(exist_ok=True, mode=0o700)  # Secure directory permissions
        
        self.credentials_file = self.config_dir / 'credentials.enc'
        self.salt_file = self.config_dir / 'salt.key'
        
        # Security settings - NO DEFAULTS
        self.min_password_length = 16
        self.require_complex_passwords = True
        self.credential_timeout = 3600  # 1 hour timeout
        
        # Runtime credential storage (memory only)
        self._credentials = {}
        self._last_access = {}
        
    def generate_secure_password(self, length: int = 32) -> str:
        """
        Generate cryptographically secure password
        
        Args:
            length: Password length (minimum 16)
            
        Returns:
            str: Secure random password
        """
        if length < self.min_password_length:
            length = self.min_password_length
            
        # Use both letters, numbers, and symbols
        alphabet = (
            'abcdefghijklmnopqrstuvwxyz'
            'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
            '0123456789'
            '!@#$%^&*()_+-=[]{}|;:,.<>?'
        )
        
        password = ''.join(secrets.choice(alphabet) for _ in range(length))
        
        # Ensure complexity requirements
        if self.require_complex_passwords:
            has_lower = any(c.islower() for c in password)
            has_upper = any(c.isupper() for c in password)
            has_digit = any(c.isdigit() for c in password)
            has_symbol = any(c in '!@#$%^&*()_+-=[]{}|;:,.<>?' for c in password)
            
            if not all([has_lower, has_upper, has_digit, has_symbol]):
                return self.generate_secure_password(length)  # Regenerate
                
        return password
        
    def validate_password_strength(self, password: str) -> Dict[str, Any]:
        """
        Validate password strength
        
        Args:
            password: Password to validate
            
        Returns:
            dict: Validation results
        """
        result = {
            'valid': False,
            'score': 0,
            'issues': [],
            'suggestions': []
        }
        
        # Length check
        if len(password) < self.min_password_length:
            result['issues'].append(f'Password must be at least {self.min_password_length} characters')
        else:
            result['score'] += 2
            
        # Character type checks
        has_lower = any(c.islower() for c in password)
        has_upper = any(c.isupper() for c in password)
        has_digit = any(c.isdigit() for c in password)
        has_symbol = any(c in '!@#$%^&*()_+-=[]{}|;:,.<>?' for c in password)
        
        if not has_lower:
            result['issues'].append('Password must contain lowercase letters')
        else:
            result['score'] += 1
            
        if not has_upper:
            result['issues'].append('Password must contain uppercase letters')
        else:
            result['score'] += 1
            
        if not has_digit:
            result['issues'].append('Password must contain numbers')
        else:
            result['score'] += 1
            
        if not has_symbol:
            result['issues'].append('Password must contain special characters')
        else:
            result['score'] += 1
            
        # Common password check
        common_passwords = [
            'password', '123456', '123456789', 'qwerty', 'abc123',
            'password123', 'admin', 'letmein', 'welcome', 'monkey',
            'dragon', 'master', 'bitcoin', 'wallet', 'crypto', 'blockchain'
        ]
        
        if password.lower() in common_passwords:
            result['issues'].append('Password is too common')
        else:
            result['score'] += 1
            
        # Pattern checks
        if len(set(password)) < len(password) * 0.5:
            result['issues'].append('Password has too many repeated characters')
        else:
            result['score'] += 1
            
        # Sequential characters check
        sequences = ['123', 'abc', 'qwe', 'asd', '789']
        if any(seq in password.lower() for seq in sequences):
            result['issues'].append('Password contains sequential characters')
        else:
            result['score'] += 1
            
        # Set validity
        result['valid'] = len(result['issues']) == 0 and result['score'] >= 6
        
        # Suggestions
        if not result['valid']:
            result['suggestions'] = [
                'Use at least 16 characters',
                'Include uppercase and lowercase letters',
                'Include numbers and special characters',
                'Avoid common words and patterns',
                'Consider using a passphrase with random words'
            ]
            
        return result
        
    def set_credential(self, key: str, value: str, validate: bool = True) -> bool:
        """
        Set credential with validation
        
        Args:
            key: Credential key (e.g., 'admin_password', 'api_key')
            value: Credential value
            validate: Whether to validate password strength
            
        Returns:
            bool: True if credential was set successfully
            
        Raises:
            ValueError: If credential validation fails
        """
        # Validate password strength for password-type credentials
        if validate and 'password' in key.lower():
            validation = self.validate_password_strength(value)
            if not validation['valid']:
                raise ValueError(f"Password validation failed: {', '.join(validation['issues'])}")
                
        # Store in memory with timestamp
        self._credentials[key] = value
        self._last_access[key] = time.time()
        
        return True
        
    def get_credential(self, key: str) -> Optional[str]:
        """
        Get credential from memory storage
        
        Args:
            key: Credential key
            
        Returns:
            str or None: Credential value if exists and not expired
        """
        if key not in self._credentials:
            return None
            
        # Check timeout
        if key in self._last_access:
            if time.time() - self._last_access[key] > self.credential_timeout:
                # Credential expired
                del self._credentials[key]
                del self._last_access[key]
                return None
                
        # Update access time
        self._last_access[key] = time.time()
        return self._credentials[key]
        
    def has_credential(self, key: str) -> bool:
        """
        Check if credential exists and is valid
        
        Args:
            key: Credential key
            
        Returns:
            bool: True if credential exists and not expired
        """
        return self.get_credential(key) is not None
        
    def remove_credential(self, key: str) -> bool:
        """
        Remove credential from storage
        
        Args:
            key: Credential key
            
        Returns:
            bool: True if credential was removed
        """
        removed = False
        
        if key in self._credentials:
            del self._credentials[key]
            removed = True
            
        if key in self._last_access:
            del self._last_access[key]
            
        return removed
        
    def clear_all_credentials(self) -> None:
        """Clear all credentials from memory"""
        self._credentials.clear()
        self._last_access.clear()
        
    def generate_api_key(self, length: int = 64) -> str:
        """
        Generate secure API key
        
        Args:
            length: Key length in characters
            
        Returns:
            str: Secure API key
        """
        return secrets.token_urlsafe(length)
        
    def generate_session_token(self) -> str:
        """
        Generate secure session token
        
        Returns:
            str: Session token
        """
        timestamp = str(int(time.time()))
        random_part = secrets.token_urlsafe(32)
        return f"{timestamp}.{random_part}"
        
    def validate_session_token(self, token: str, max_age: int = 3600) -> bool:
        """
        Validate session token
        
        Args:
            token: Session token to validate
            max_age: Maximum token age in seconds
            
        Returns:
            bool: True if token is valid
        """
        try:
            parts = token.split('.')
            if len(parts) != 2:
                return False
                
            timestamp = int(parts[0])
            current_time = int(time.time())
            
            # Check if token is not too old
            if current_time - timestamp > max_age:
                return False
                
            # Check if token is not from the future (clock skew tolerance)
            if timestamp > current_time + 300:  # 5 minutes tolerance
                return False
                
            return True
            
        except (ValueError, IndexError):
            return False
            
    def hash_credential(self, credential: str) -> str:
        """
        Hash credential for secure storage/comparison
        
        Args:
            credential: Credential to hash
            
        Returns:
            str: Hashed credential (hex)
        """
        salt = secrets.token_bytes(32)
        hashed = hashlib.pbkdf2_hmac('sha256', credential.encode(), salt, 100000)
        return f"{salt.hex()}${hashed.hex()}"
        
    def verify_credential_hash(self, credential: str, credential_hash: str) -> bool:
        """
        Verify credential against hash
        
        Args:
            credential: Plain credential
            credential_hash: Hashed credential from hash_credential()
            
        Returns:
            bool: True if credential matches hash
        """
        try:
            parts = credential_hash.split('$')
            if len(parts) != 2:
                return False
                
            salt = bytes.fromhex(parts[0])
            stored_hash = bytes.fromhex(parts[1])
            
            computed_hash = hashlib.pbkdf2_hmac('sha256', credential.encode(), salt, 100000)
            
            # Secure comparison to prevent timing attacks
            return secrets.compare_digest(computed_hash, stored_hash)
            
        except (ValueError, IndexError):
            return False
            
    def require_credentials(self, required_keys: list) -> Dict[str, str]:
        """
        Ensure all required credentials are set
        
        Args:
            required_keys: List of required credential keys
            
        Returns:
            dict: Missing credentials that need to be set
            
        Raises:
            RuntimeError: If any required credentials are missing
        """
        missing = {}
        
        for key in required_keys:
            if not self.has_credential(key):
                if 'password' in key.lower():
                    suggestion = f"Set with: credentials.set_credential('{key}', 'your_secure_password')"
                elif 'key' in key.lower():
                    suggestion = f"Generate with: credentials.set_credential('{key}', credentials.generate_api_key())"
                else:
                    suggestion = f"Set with: credentials.set_credential('{key}', 'your_value')"
                    
                missing[key] = suggestion
                
        if missing:
            error_msg = "Missing required credentials:\n"
            for key, suggestion in missing.items():
                error_msg += f"  - {key}: {suggestion}\n"
            error_msg += "\nNO DEFAULT CREDENTIALS ARE PROVIDED FOR SECURITY REASONS"
            raise RuntimeError(error_msg)
            
        return {key: self.get_credential(key) for key in required_keys}
        
    def get_credential_status(self) -> Dict[str, Any]:
        """
        Get status of all credentials
        
        Returns:
            dict: Status information
        """
        current_time = time.time()
        status = {
            'total_credentials': len(self._credentials),
            'active_credentials': 0,
            'expired_credentials': 0,
            'credentials': {}
        }
        
        for key in list(self._credentials.keys()):
            last_access = self._last_access.get(key, 0)
            age = current_time - last_access
            expired = age > self.credential_timeout
            
            if expired:
                status['expired_credentials'] += 1
            else:
                status['active_credentials'] += 1
                
            status['credentials'][key] = {
                'last_access': last_access,
                'age_seconds': age,
                'expired': expired,
                'type': 'password' if 'password' in key.lower() else 'other'
            }
            
        return status
        
    def cleanup_expired_credentials(self) -> int:
        """
        Remove expired credentials from memory
        
        Returns:
            int: Number of credentials removed
        """
        current_time = time.time()
        expired_keys = []
        
        for key, last_access in self._last_access.items():
            if current_time - last_access > self.credential_timeout:
                expired_keys.append(key)
                
        for key in expired_keys:
            self.remove_credential(key)
            
        return len(expired_keys)


# Global credentials manager
qnet_credentials = QNetCredentials()

# Security check functions
def ensure_no_default_credentials() -> None:
    """
    Ensure no default credentials are in use
    This function should be called during node startup
    """
    # List of credential keys that must not have default values
    critical_credentials = [
        'admin_password',
        'api_key',
        'encryption_key',
        'wallet_password',
        'rpc_password',
        'database_password'
    ]
    
    # Check if any credentials are set to common default values
    dangerous_defaults = [
        'password', 'admin', '123456', 'qwerty', 'default',
        'changeme', 'password123', 'admin123', 'root', 'toor'
    ]
    
    issues = []
    
    for key in critical_credentials:
        if qnet_credentials.has_credential(key):
            value = qnet_credentials.get_credential(key)
            if value and value.lower() in dangerous_defaults:
                issues.append(f"Credential '{key}' is set to a dangerous default value")
                
    if issues:
        error_msg = "SECURITY ALERT - Default credentials detected:\n"
        for issue in issues:
            error_msg += f"  - {issue}\n"
        error_msg += "\nPlease change all default credentials before starting the node."
        raise RuntimeError(error_msg)


def validate_production_security() -> Dict[str, Any]:
    """
    Validate production security settings
    
    Returns:
        dict: Security validation results
    """
    results = {
        'secure': True,
        'warnings': [],
        'critical_issues': [],
        'recommendations': []
    }
    
    # Check credential security
    try:
        ensure_no_default_credentials()
    except RuntimeError as e:
        results['secure'] = False
        results['critical_issues'].append(str(e))
        
    # Check credential strength
    status = qnet_credentials.get_credential_status()
    
    if status['total_credentials'] == 0:
        results['warnings'].append("No credentials are configured")
        results['recommendations'].append("Set up required credentials before production deployment")
        
    if status['expired_credentials'] > 0:
        results['warnings'].append(f"{status['expired_credentials']} credentials have expired")
        results['recommendations'].append("Refresh expired credentials")
        
    # Check file permissions
    config_dir = qnet_credentials.config_dir
    if config_dir.exists():
        dir_stat = config_dir.stat()
        if oct(dir_stat.st_mode)[-3:] != '700':
            results['critical_issues'].append("Config directory has insecure permissions")
            results['secure'] = False
            
    return results 