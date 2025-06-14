#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: ip_fix.py
Improved external IP detection for QNet nodes with better error handling 
and multiple service providers for redundancy.
"""

import os
import socket
import logging
import requests
import time
from typing import Optional

# Configure logging
logging.basicConfig(level=logging.INFO, 
                   format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger('ip_fix')

def get_external_ip() -> Optional[str]:
    """
    Get external IP address using multiple services with fallback mechanisms.
    
    Returns:
        str: External IP address if found, None otherwise
    """
    # List of IP detection services in order of preference
    services = [
        "https://api.ipify.org",
        "https://ifconfig.me/ip",
        "https://icanhazip.com",
        "https://ipecho.net/plain",
        "https://checkip.amazonaws.com"
    ]
    
    # Try each service with timeout and retry logic
    for service in services:
        try:
            # Use a reasonable timeout to prevent hanging
            logger.info(f"Trying to get external IP from {service}")
            response = requests.get(service, timeout=5)
            
            if response.status_code == 200:
                ip = response.text.strip()
                
                # Basic validation of the returned IP
                if ip and len(ip) >= 7 and _is_valid_ip(ip):  # Simple validation
                    logger.info(f"Successfully got external IP: {ip}")
                    return ip
        except requests.RequestException as e:
            logger.warning(f"Error getting IP from {service}: {e}")
        except Exception as e:
            logger.warning(f"Unexpected error getting IP from {service}: {e}")
    
    # If all external services fail, try getting local network IP
    # This is not as reliable but better than nothing
    logger.warning("All external IP services failed, trying to get local IP")
    return get_local_ip()

def get_local_ip() -> Optional[str]:
    """
    Get local network IP address as fallback.
    
    Returns:
        str: Local IP address if found, None otherwise
    """
    try:
        # Create a socket connection to a known external server
        # This trick helps determine which local interface would be used
        # for external connections
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))  # Google's DNS server
        local_ip = s.getsockname()[0]
        s.close()
        
        logger.info(f"Using local IP as fallback: {local_ip}")
        return local_ip
    except Exception as e:
        logger.error(f"Error getting local IP: {e}")
        
        # Last resort fallback - less reliable
        try:
            hostname = socket.gethostname()
            local_ip = socket.gethostbyname(hostname)
            if local_ip != "127.0.0.1":  # Avoid returning localhost
                logger.info(f"Using hostname-based IP as fallback: {local_ip}")
                return local_ip
        except Exception as e:
            logger.error(f"Error getting hostname-based IP: {e}")
    
    return None

def _is_valid_ip(ip: str) -> bool:
    """
    Validate that a string is a valid IPv4 address.
    
    Args:
        ip: String to validate
        
    Returns:
        bool: True if valid IPv4 address, False otherwise
    """
    try:
        # Validate IP format using socket
        socket.inet_aton(ip)
        
        # Additional validation - should have 4 parts separated by dots
        parts = ip.split('.')
        if len(parts) != 4:
            return False
            
        # Each part should be a number between 0 and 255
        for part in parts:
            if not part.isdigit() or int(part) < 0 or int(part) > 255:
                return False
                
        # Should not be a special address
        if ip == "0.0.0.0" or ip == "127.0.0.1":
            return False
            
        return True
    except socket.error:
        return False

def main():
    """Main function to run when script is executed directly."""
    # Try to get external IP
    max_retries = 3
    retry_delay = 5  # seconds
    
    for attempt in range(max_retries):
        external_ip = get_external_ip()
        
        if external_ip:
            # Set environment variable for other components to use
            os.environ["QNET_EXTERNAL_IP"] = external_ip
            print(f"Using external IP: {external_ip}")
            
            # Also write to a file for persistence
            try:
                with open("/app/data/external_ip.txt", "w") as f:
                    f.write(external_ip)
            except Exception as e:
                logger.warning(f"Could not write to external IP file: {e}")
                
            return
        
        # Wait before retrying
        if attempt < max_retries - 1:
            logger.warning(f"Retrying to get external IP in {retry_delay} seconds...")
            time.sleep(retry_delay)
    
    logger.error("Failed to determine external IP after multiple attempts")
    
    # Use a placeholder value to prevent other components from failing
    os.environ["QNET_EXTERNAL_IP"] = "0.0.0.0"
    print("WARNING: Could not determine external IP, using placeholder")

if __name__ == "__main__":
    main()