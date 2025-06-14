"""
Geographic location detection for QNet nodes.
Determines node region based on IP address.
"""

import socket
from typing import Optional, Dict, Tuple
import ipaddress
import logging

# Try to import requests, but make it optional
try:
    import requests
    REQUESTS_AVAILABLE = True
except ImportError:
    REQUESTS_AVAILABLE = False

from .regions import Region

logger = logging.getLogger(__name__)


class GeoLocationService:
    """Service for determining geographic location from IP addresses."""
    
    # Free GeoIP services (no API key required)
    GEOIP_SERVICES = [
        "http://ip-api.com/json/{ip}",
        "https://ipapi.co/{ip}/json/",
        "https://geolocation-db.com/json/{ip}",
    ]
    
    # IP ranges for common cloud providers (to detect datacenter IPs)
    CLOUD_PROVIDERS = {
        "Google Cloud": [
            "35.184.0.0/13",
            "35.190.0.0/15",  # More specific for 35.190.x.x
            "35.192.0.0/12",
            "35.208.0.0/12",
            "35.224.0.0/12",
            "35.240.0.0/12",
            "34.0.0.0/8",
        ],
        "AWS": [
            "52.0.0.0/11",
            "54.0.0.0/8",
            "18.0.0.0/8",
            # Removed 35.0.0.0/8 as it conflicts with Google Cloud ranges
        ],
        "Azure": [
            "13.64.0.0/11",
            "13.96.0.0/12",
            "20.0.0.0/8",
            "40.0.0.0/8",
        ],
        "DigitalOcean": [
            "104.131.0.0/16",
            "159.65.0.0/16",
            "167.99.0.0/16",
            "178.128.0.0/16",
        ],
    }
    
    def __init__(self):
        """Initialize geo location service."""
        self._cache: Dict[str, Region] = {}
    
    def get_region_from_ip(self, ip: str) -> Optional[Region]:
        """Get region from IP address.
        
        Args:
            ip: IP address to lookup
            
        Returns:
            Region or None if cannot determine
        """
        # Check cache first
        if ip in self._cache:
            return self._cache[ip]
        
        # Skip for localhost/private IPs
        if self._is_private_ip(ip):
            logger.debug(f"Private IP {ip}, defaulting to None")
            return None
        
        # Try to get location from GeoIP services
        location_data = self._query_geoip_services(ip)
        if not location_data:
            logger.warning(f"Could not determine location for IP {ip}")
            return None
        
        # Map location to region
        region = self._map_location_to_region(location_data)
        
        # Cache result
        if region:
            self._cache[ip] = region
            
        return region
    
    def _is_private_ip(self, ip: str) -> bool:
        """Check if IP is private/local."""
        try:
            ip_obj = ipaddress.ip_address(ip)
            return ip_obj.is_private or ip_obj.is_loopback
        except ValueError:
            return False
    
    def _query_geoip_services(self, ip: str) -> Optional[Dict]:
        """Query GeoIP services for location data."""
        if not REQUESTS_AVAILABLE:
            logger.warning("requests module not available, cannot query GeoIP services")
            return None
            
        for service_url in self.GEOIP_SERVICES:
            try:
                url = service_url.format(ip=ip)
                response = requests.get(url, timeout=5)
                if response.status_code == 200:
                    data = response.json()
                    
                    # Normalize response format
                    return self._normalize_geoip_response(data, service_url)
                    
            except Exception as e:
                logger.debug(f"GeoIP service {service_url} failed: {e}")
                continue
        
        return None
    
    def _normalize_geoip_response(self, data: Dict, service_url: str) -> Dict:
        """Normalize different GeoIP service responses."""
        normalized = {}
        
        if "ip-api.com" in service_url:
            normalized = {
                "country": data.get("country"),
                "country_code": data.get("countryCode"),
                "region": data.get("regionName"),
                "city": data.get("city"),
                "lat": data.get("lat"),
                "lon": data.get("lon"),
                "timezone": data.get("timezone"),
            }
        elif "ipapi.co" in service_url:
            normalized = {
                "country": data.get("country_name"),
                "country_code": data.get("country_code"),
                "region": data.get("region"),
                "city": data.get("city"),
                "lat": data.get("latitude"),
                "lon": data.get("longitude"),
                "timezone": data.get("timezone"),
            }
        elif "geolocation-db.com" in service_url:
            normalized = {
                "country": data.get("country_name"),
                "country_code": data.get("country_code"),
                "region": data.get("state"),
                "city": data.get("city"),
                "lat": data.get("latitude"),
                "lon": data.get("longitude"),
                "timezone": None,
            }
        
        return normalized
    
    def _map_location_to_region(self, location: Dict) -> Optional[Region]:
        """Map location data to QNet region."""
        country_code = location.get("country_code", "").upper()
        
        # Country code to region mapping
        country_region_map = {
            # North America
            "US": Region.NORTH_AMERICA,
            "CA": Region.NORTH_AMERICA,
            "MX": Region.NORTH_AMERICA,
            
            # South America
            "BR": Region.SOUTH_AMERICA,
            "AR": Region.SOUTH_AMERICA,
            "CL": Region.SOUTH_AMERICA,
            "CO": Region.SOUTH_AMERICA,
            "PE": Region.SOUTH_AMERICA,
            "VE": Region.SOUTH_AMERICA,
            
            # Europe
            "GB": Region.EUROPE,
            "DE": Region.EUROPE,
            "FR": Region.EUROPE,
            "IT": Region.EUROPE,
            "ES": Region.EUROPE,
            "NL": Region.EUROPE,
            "BE": Region.EUROPE,
            "CH": Region.EUROPE,
            "AT": Region.EUROPE,
            "SE": Region.EUROPE,
            "NO": Region.EUROPE,
            "DK": Region.EUROPE,
            "FI": Region.EUROPE,
            "PL": Region.EUROPE,
            "CZ": Region.EUROPE,
            "RO": Region.EUROPE,
            "GR": Region.EUROPE,
            "PT": Region.EUROPE,
            "IE": Region.EUROPE,
            
            # Asia Pacific
            "CN": Region.ASIA_PACIFIC,
            "JP": Region.ASIA_PACIFIC,
            "KR": Region.ASIA_PACIFIC,
            "IN": Region.ASIA_PACIFIC,
            "SG": Region.ASIA_PACIFIC,
            "MY": Region.ASIA_PACIFIC,
            "TH": Region.ASIA_PACIFIC,
            "ID": Region.ASIA_PACIFIC,
            "PH": Region.ASIA_PACIFIC,
            "VN": Region.ASIA_PACIFIC,
            "TW": Region.ASIA_PACIFIC,
            "HK": Region.ASIA_PACIFIC,
            
            # Middle East
            "AE": Region.MIDDLE_EAST,
            "SA": Region.MIDDLE_EAST,
            "IL": Region.MIDDLE_EAST,
            "TR": Region.MIDDLE_EAST,
            "EG": Region.MIDDLE_EAST,
            "JO": Region.MIDDLE_EAST,
            "KW": Region.MIDDLE_EAST,
            "QA": Region.MIDDLE_EAST,
            
            # Africa
            "ZA": Region.AFRICA,
            "NG": Region.AFRICA,
            "KE": Region.AFRICA,
            "GH": Region.AFRICA,
            "MA": Region.AFRICA,
            "TN": Region.AFRICA,
            "ET": Region.AFRICA,
            
            # Oceania
            "AU": Region.OCEANIA,
            "NZ": Region.OCEANIA,
            "FJ": Region.OCEANIA,
        }
        
        return country_region_map.get(country_code)
    
    def detect_cloud_provider(self, ip: str) -> Optional[str]:
        """Detect if IP belongs to a cloud provider.
        
        Args:
            ip: IP address to check
            
        Returns:
            Cloud provider name or None
        """
        try:
            ip_obj = ipaddress.ip_address(ip)
            
            for provider, ranges in self.CLOUD_PROVIDERS.items():
                for ip_range in ranges:
                    if ip_obj in ipaddress.ip_network(ip_range):
                        return provider
                        
        except ValueError:
            pass
            
        return None
    
    def get_external_ip(self) -> Optional[str]:
        """Get external IP address of this node."""
        if not REQUESTS_AVAILABLE:
            logger.warning("requests module not available, cannot auto-detect external IP")
            # Try to get local IP as fallback
            try:
                hostname = socket.gethostname()
                local_ip = socket.gethostbyname(hostname)
                return local_ip
            except:
                return None
                
        try:
            # Try multiple services
            services = [
                "https://api.ipify.org",
                "https://icanhazip.com",
                "https://ident.me",
            ]
            
            for service in services:
                try:
                    response = requests.get(service, timeout=5)
                    if response.status_code == 200:
                        return response.text.strip()
                except:
                    continue
                    
        except Exception as e:
            logger.error(f"Failed to get external IP: {e}")
            
        return None
    
    def auto_detect_region(self) -> Optional[Region]:
        """Auto-detect region for this node."""
        # Get external IP
        external_ip = self.get_external_ip()
        if not external_ip:
            logger.warning("Could not determine external IP")
            return None
        
        logger.info(f"Detected external IP: {external_ip}")
        
        # Check if cloud provider
        provider = self.detect_cloud_provider(external_ip)
        if provider:
            logger.info(f"Running on {provider}")
        
        # Get region
        region = self.get_region_from_ip(external_ip)
        if region:
            logger.info(f"Auto-detected region: {region.value}")
        
        return region 