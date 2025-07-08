#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: safe_serialization.py
Provides secure serialization and deserialization functions to prevent RCE vulnerabilities.
"""

import json
import logging
import base64
import hashlib
import hmac
import os
import time
from typing import Any, Dict, List, Optional, Union

# Global secret key for HMAC (rotated periodically)
_HMAC_KEY = os.urandom(32)
_KEY_ROTATION_TIME = time.time() + 3600  # Rotate key every hour

# Safe types for deserialization
SAFE_TYPES = (str, int, float, bool, type(None))

def _get_hmac_key() -> bytes:
    """Get current HMAC key, rotating if needed"""
    global _HMAC_KEY, _KEY_ROTATION_TIME
    
    # Rotate key if needed
    if time.time() > _KEY_ROTATION_TIME:
        _HMAC_KEY = os.urandom(32)
        _KEY_ROTATION_TIME = time.time() + 3600
        
    return _HMAC_KEY

def serialize_safe(data: Any) -> str:
    """
    Safely serialize data with integrity protection.
    
    Args:
        data: Data to serialize (must be JSON serializable)
        
    Returns:
        str: Serialized data with HMAC
    """
    if data is None:
        return ""
        
    try:
        # Convert to JSON
        json_data = json.dumps(data)
        
        # Compute HMAC
        key = _get_hmac_key()
        h = hmac.new(key, json_data.encode(), hashlib.sha256)
        hmac_digest = h.digest()
        
        # Encode data and HMAC
        payload = base64.b64encode(json_data.encode()).decode()
        signature = base64.b64encode(hmac_digest).decode()
        
        # Return both parts
        return f"{payload}.{signature}"
    except Exception as e:
        logging.error(f"Error in serialize_safe: {e}")
        return ""

def deserialize_safe(data_str: str, require_hmac: bool = True) -> Optional[Any]:
    """
    Safely deserialize data with integrity verification.
    
    Args:
        data_str: Serialized data string
        require_hmac: Whether to require HMAC verification
        
    Returns:
        Deserialized data, or None if verification fails
    """
    if not data_str:
        return None
        
    try:
        # Check if HMAC is included
        parts = data_str.split('.')
        
        if len(parts) < 2:
            if require_hmac:
                logging.warning("Missing HMAC in serialized data")
                return None
            else:
                # Try to deserialize without HMAC
                try:
                    # Try direct JSON deserialization
                    return json.loads(data_str)
                except:
                    # Try base64 encoded JSON
                    try:
                        decoded = base64.b64decode(data_str).decode()
                        return json.loads(decoded)
                    except:
                        logging.warning("Failed to deserialize data without HMAC")
                        return None
        
        # Extract parts
        payload, signature = parts
        
        # Decode payload
        try:
            json_data = base64.b64decode(payload).decode()
        except:
            logging.warning("Invalid base64 encoding in payload")
            return None
        
        # Verify HMAC
        key = _get_hmac_key()
        h = hmac.new(key, json_data.encode(), hashlib.sha256)
        expected_hmac = h.digest()
        provided_hmac = base64.b64decode(signature)
        
        if not hmac.compare_digest(expected_hmac, provided_hmac):
            logging.warning("HMAC verification failed")
            return None
        
        # Deserialize data
        return json.loads(json_data)
    except Exception as e:
        logging.error(f"Error in deserialize_safe: {e}")
        return None

def safe_loads(json_str: str) -> Any:
    """
    Safe alternative to json.loads that prevents untrusted deserialization.
    Only basic types are allowed (str, int, float, bool, None, list, dict).
    
    Args:
        json_str: JSON string to parse
        
    Returns:
        Parsed data with only safe types
    """
    try:
        # Use json module's loads for initial parsing
        parsed = json.loads(json_str)
        
        # Sanitize parsed data
        return _sanitize_parsed_data(parsed)
    except Exception as e:
        logging.error(f"Error in safe_loads: {e}")
        return None

def _sanitize_parsed_data(data: Any) -> Any:
    """
    Recursively sanitize parsed data to ensure only safe types are used.
    
    Args:
        data: Data to sanitize
        
    Returns:
        Sanitized data
    """
    # Handle basic safe types
    if isinstance(data, SAFE_TYPES):
        return data
    
    # Handle lists
    if isinstance(data, list):
        return [_sanitize_parsed_data(item) for item in data]
    
    # Handle dictionaries
    if isinstance(data, dict):
        return {str(k): _sanitize_parsed_data(v) for k, v in data.items()}
    
    # Convert other types to string
    return str(data)

def pickle_alternative_dump(obj: Any) -> bytes:
    """
    Safe alternative to pickle.dump that uses JSON serialization.
    Only works for JSON-serializable objects.
    
    Args:
        obj: Object to serialize
        
    Returns:
        bytes: Serialized data
    """
    # Convert to JSON
    json_data = json.dumps(obj)
    
    # Compute HMAC
    key = _get_hmac_key()
    h = hmac.new(key, json_data.encode(), hashlib.sha256)
    hmac_digest = h.digest()
    
    # Encode data, add type info and HMAC
    type_info = str(type(obj).__name__).encode()
    payload = json_data.encode()
    
    # Format: [4 bytes length][type info][payload][HMAC]
    type_len = len(type_info)
    full_data = type_len.to_bytes(4, byteorder='big') + type_info + payload + hmac_digest
    
    return full_data

def pickle_alternative_load(data: bytes) -> Any:
    """
    Safe alternative to pickle.load that uses JSON deserialization.
    
    Args:
        data: Serialized data
        
    Returns:
        Deserialized object
    """
    if len(data) < 36:  # 4 bytes length + 32 bytes HMAC minimum
        logging.warning("Data too short for valid serialized format")
        return None
    
    try:
        # Extract type length
        type_len = int.from_bytes(data[:4], byteorder='big')
        
        # Extract type info and payload
        type_info = data[4:4+type_len].decode()
        payload = data[4+type_len:-32]
        hmac_digest = data[-32:]
        
        # Verify HMAC
        key = _get_hmac_key()
        h = hmac.new(key, payload, hashlib.sha256)
        expected_hmac = h.digest()
        
        if not hmac.compare_digest(expected_hmac, hmac_digest):
            logging.warning("HMAC verification failed")
            return None
        
        # Parse JSON
        obj = json.loads(payload)
        
        # Sanitize data
        return _sanitize_parsed_data(obj)
    except Exception as e:
        logging.error(f"Error in pickle_alternative_load: {e}")
        return None

# Safe serialization for network messages
def safe_message_serialize(msg_type: str, data: Dict) -> str:
    """
    Safely serialize a network message.
    
    Args:
        msg_type: Message type identifier
        data: Message data
        
    Returns:
        str: Serialized message
    """
    message = {
        "type": msg_type,
        "data": data,
        "timestamp": time.time()
    }
    return serialize_safe(message)

def safe_message_deserialize(message_str: str) -> Optional[Dict]:
    """
    Safely deserialize a network message.
    
    Args:
        message_str: Serialized message
        
    Returns:
        dict: Deserialized message, or None if invalid
    """
    message = deserialize_safe(message_str)
    
    if not message:
        return None
        
    # Verify message structure
    if not isinstance(message, dict):
        logging.warning("Invalid message format: not a dictionary")
        return None
        
    required_fields = ["type", "data", "timestamp"]
    if not all(field in message for field in required_fields):
        logging.warning("Invalid message format: missing required fields")
        return None
        
    # Check message age
    if time.time() - message["timestamp"] > 300:  # 5 minutes max age
        logging.warning("Message too old, rejecting")
        return None
        
    return message