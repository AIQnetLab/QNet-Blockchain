import os
import socket
import requests

def get_external_ip():
    """Get external IP address using multiple services"""
    services = [
        "https://api.ipify.org",
        "https://ifconfig.me/ip",
        "https://icanhazip.com",
        "https://ipecho.net/plain"
    ]
    
    for service in services:
        try:
            response = requests.get(service, timeout=5)
            if response.status_code == 200:
                ip = response.text.strip()
                return ip
        except:
            continue
    
    return None

# Force external IP for container
external_ip = get_external_ip()
if external_ip:
    os.environ["QNET_EXTERNAL_IP"] = external_ip
    print(f"Using external IP: {external_ip}")
