"""
Regional management for QNet network.
Handles geographic distribution and regional optimization.
"""

from typing import Dict, List, Optional, Set, Tuple
from dataclasses import dataclass
from enum import Enum
import math


class Region(Enum):
    """Supported geographic regions."""
    NORTH_AMERICA = "north_america"
    SOUTH_AMERICA = "south_america"
    EUROPE = "europe"
    AFRICA = "africa"
    ASIA_PACIFIC = "asia_pacific"
    MIDDLE_EAST = "middle_east"
    OCEANIA = "oceania"
    
    @classmethod
    def from_string(cls, region_str: str) -> Optional['Region']:
        """Convert string to Region enum."""
        region_map = {
            "na": cls.NORTH_AMERICA,
            "north_america": cls.NORTH_AMERICA,
            "us": cls.NORTH_AMERICA,
            "usa": cls.NORTH_AMERICA,
            "canada": cls.NORTH_AMERICA,
            
            "sa": cls.SOUTH_AMERICA,
            "south_america": cls.SOUTH_AMERICA,
            "brazil": cls.SOUTH_AMERICA,
            "latam": cls.SOUTH_AMERICA,
            
            "eu": cls.EUROPE,
            "europe": cls.EUROPE,
            "uk": cls.EUROPE,
            "germany": cls.EUROPE,
            "france": cls.EUROPE,
            
            "africa": cls.AFRICA,
            "af": cls.AFRICA,
            "south_africa": cls.AFRICA,
            
            "asia": cls.ASIA_PACIFIC,
            "ap": cls.ASIA_PACIFIC,
            "asia_pacific": cls.ASIA_PACIFIC,
            "china": cls.ASIA_PACIFIC,
            "japan": cls.ASIA_PACIFIC,
            "jp": cls.ASIA_PACIFIC,
            "india": cls.ASIA_PACIFIC,
            "singapore": cls.ASIA_PACIFIC,
            
            "me": cls.MIDDLE_EAST,
            "middle_east": cls.MIDDLE_EAST,
            "uae": cls.MIDDLE_EAST,
            "israel": cls.MIDDLE_EAST,
            
            "oceania": cls.OCEANIA,
            "oc": cls.OCEANIA,
            "australia": cls.OCEANIA,
            "au": cls.OCEANIA,
            "nz": cls.OCEANIA,
        }
        
        normalized = region_str.lower().replace("-", "_").replace(" ", "_")
        return region_map.get(normalized)


@dataclass
class RegionInfo:
    """Information about a region."""
    region: Region
    name: str
    timezone_offset: int  # UTC offset in hours
    primary_languages: List[str]
    estimated_latency: Dict[Region, int]  # Latency to other regions in ms


class RegionManager:
    """Manages regional information and optimization."""
    
    # Estimated latencies between regions (in milliseconds)
    INTER_REGION_LATENCY = {
        (Region.NORTH_AMERICA, Region.EUROPE): 80,
        (Region.NORTH_AMERICA, Region.ASIA_PACIFIC): 150,
        (Region.NORTH_AMERICA, Region.SOUTH_AMERICA): 120,
        (Region.EUROPE, Region.ASIA_PACIFIC): 180,
        (Region.EUROPE, Region.AFRICA): 60,
        (Region.EUROPE, Region.MIDDLE_EAST): 70,
        (Region.ASIA_PACIFIC, Region.OCEANIA): 100,
        (Region.MIDDLE_EAST, Region.ASIA_PACIFIC): 90,
        (Region.AFRICA, Region.MIDDLE_EAST): 80,
        (Region.SOUTH_AMERICA, Region.AFRICA): 200,
    }
    
    def __init__(self):
        """Initialize region manager."""
        self.regions = self._init_regions()
        self.node_distribution: Dict[Region, int] = {r: 0 for r in Region}
    
    def _init_regions(self) -> Dict[Region, RegionInfo]:
        """Initialize region information."""
        regions = {}
        
        # Define region info
        region_data = [
            (Region.NORTH_AMERICA, "North America", -5, ["en", "es", "fr"]),
            (Region.SOUTH_AMERICA, "South America", -3, ["es", "pt"]),
            (Region.EUROPE, "Europe", 1, ["en", "de", "fr", "es", "it"]),
            (Region.AFRICA, "Africa", 2, ["en", "fr", "ar", "sw"]),
            (Region.ASIA_PACIFIC, "Asia Pacific", 8, ["zh", "ja", "ko", "hi", "en"]),
            (Region.MIDDLE_EAST, "Middle East", 3, ["ar", "he", "en"]),
            (Region.OCEANIA, "Oceania", 10, ["en"]),
        ]
        
        for region, name, tz_offset, languages in region_data:
            latencies = self._calculate_latencies(region)
            regions[region] = RegionInfo(
                region=region,
                name=name,
                timezone_offset=tz_offset,
                primary_languages=languages,
                estimated_latency=latencies
            )
        
        return regions
    
    def _calculate_latencies(self, from_region: Region) -> Dict[Region, int]:
        """Calculate estimated latencies from one region to all others."""
        latencies = {from_region: 5}  # Local latency
        
        for (r1, r2), latency in self.INTER_REGION_LATENCY.items():
            if r1 == from_region:
                latencies[r2] = latency
            elif r2 == from_region:
                latencies[r1] = latency
        
        # Fill in missing values with estimates
        for region in Region:
            if region not in latencies:
                # Estimate based on geographic distance
                latencies[region] = 250  # Default high latency
        
        return latencies
    
    def get_latency(self, from_region: Region, to_region: Region) -> int:
        """Get estimated latency between two regions."""
        if from_region == to_region:
            return 5  # Local latency
        
        # Check direct mapping
        key1 = (from_region, to_region)
        key2 = (to_region, from_region)
        
        if key1 in self.INTER_REGION_LATENCY:
            return self.INTER_REGION_LATENCY[key1]
        elif key2 in self.INTER_REGION_LATENCY:
            return self.INTER_REGION_LATENCY[key2]
        else:
            return 250  # Default high latency
    
    def register_node(self, region: Region) -> None:
        """Register a node in a region."""
        self.node_distribution[region] += 1
    
    def unregister_node(self, region: Region) -> None:
        """Unregister a node from a region."""
        if self.node_distribution[region] > 0:
            self.node_distribution[region] -= 1
    
    def get_distribution_stats(self) -> Dict[str, any]:
        """Get node distribution statistics."""
        total_nodes = sum(self.node_distribution.values())
        if total_nodes == 0:
            return {
                "total_nodes": 0,
                "regions_active": 0,
                "distribution": {},
                "concentration_index": 0.0
            }
        
        distribution = {
            region.value: {
                "count": count,
                "percentage": (count / total_nodes) * 100
            }
            for region, count in self.node_distribution.items()
        }
        
        # Calculate concentration index (0 = perfect distribution, 1 = all in one region)
        concentration = self._calculate_concentration_index()
        
        return {
            "total_nodes": total_nodes,
            "regions_active": sum(1 for count in self.node_distribution.values() if count > 0),
            "distribution": distribution,
            "concentration_index": concentration
        }
    
    def _calculate_concentration_index(self) -> float:
        """Calculate Herfindahl-Hirschman Index for concentration."""
        total = sum(self.node_distribution.values())
        if total == 0:
            return 0.0
        
        hhi = sum((count / total) ** 2 for count in self.node_distribution.values())
        
        # Normalize to 0-1 range
        min_hhi = 1 / len(Region)  # Perfect distribution
        max_hhi = 1.0  # All in one region
        
        return (hhi - min_hhi) / (max_hhi - min_hhi)
    
    def get_nearby_regions(self, region: Region, max_latency: int = 100) -> List[Region]:
        """Get regions within specified latency."""
        nearby = []
        region_info = self.regions[region]
        
        for other_region, latency in region_info.estimated_latency.items():
            if other_region != region and latency <= max_latency:
                nearby.append(other_region)
        
        return sorted(nearby, key=lambda r: region_info.estimated_latency[r])
    
    def suggest_backup_regions(self, primary_region: Region) -> List[Region]:
        """Suggest backup regions for redundancy."""
        # Get nearby regions first
        nearby = self.get_nearby_regions(primary_region, max_latency=150)
        
        # Add regions with good node distribution
        well_distributed = [
            r for r, count in self.node_distribution.items()
            if count > 0 and r != primary_region and r not in nearby
        ]
        
        # Combine results
        result = nearby[:2] + well_distributed[:1]
        
        # If we don't have enough, add any other regions
        if len(result) < 3:
            all_regions = [r for r in Region if r != primary_region and r not in result]
            result.extend(all_regions[:3 - len(result)])
        
        return result[:3]
    
    def get_optimal_regions_for_global_coverage(self, num_regions: int = 3) -> List[Region]:
        """Get optimal regions for global coverage."""
        if num_regions >= len(Region):
            return list(Region)
        
        # Start with regions that have nodes
        active_regions = [r for r, count in self.node_distribution.items() if count > 0]
        
        if len(active_regions) >= num_regions:
            # Sort by node count and geographic diversity
            return sorted(active_regions, key=lambda r: self.node_distribution[r], reverse=True)[:num_regions]
        
        # Add strategic regions for coverage
        strategic_regions = [
            Region.NORTH_AMERICA,  # Americas coverage
            Region.EUROPE,         # Europe/Africa coverage
            Region.ASIA_PACIFIC,   # Asia/Oceania coverage
        ]
        
        result = list(active_regions)
        for region in strategic_regions:
            if region not in result and len(result) < num_regions:
                result.append(region)
        
        return result[:num_regions] 