"""
Tests for regional support in QNet.
"""

import unittest
import sys
import os

# Add parent directory to path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from testing.integration.qnet_node.src.network.regions import Region, RegionManager
from testing.integration.qnet_node.src.network.geo_location import GeoLocationService


class TestRegionalSupport(unittest.TestCase):
    """Test regional functionality."""
    
    def setUp(self):
        """Set up test fixtures."""
        self.region_manager = RegionManager()
        self.geo_service = GeoLocationService()
    
    def test_region_parsing(self):
        """Test region string parsing."""
        # Test full names
        self.assertEqual(Region.from_string("north_america"), Region.NORTH_AMERICA)
        self.assertEqual(Region.from_string("europe"), Region.EUROPE)
        self.assertEqual(Region.from_string("asia_pacific"), Region.ASIA_PACIFIC)
        
        # Test shortcuts
        self.assertEqual(Region.from_string("na"), Region.NORTH_AMERICA)
        self.assertEqual(Region.from_string("eu"), Region.EUROPE)
        self.assertEqual(Region.from_string("ap"), Region.ASIA_PACIFIC)
        
        # Test country codes
        self.assertEqual(Region.from_string("us"), Region.NORTH_AMERICA)
        self.assertEqual(Region.from_string("uk"), Region.EUROPE)
        self.assertEqual(Region.from_string("jp"), Region.ASIA_PACIFIC)
        self.assertEqual(Region.from_string("au"), Region.OCEANIA)
        
        # Test invalid
        self.assertIsNone(Region.from_string("invalid"))
        self.assertIsNone(Region.from_string(""))
    
    def test_latency_calculation(self):
        """Test inter-regional latency calculations."""
        # Same region
        self.assertEqual(
            self.region_manager.get_latency(Region.EUROPE, Region.EUROPE),
            5  # Local latency
        )
        
        # Adjacent regions
        self.assertEqual(
            self.region_manager.get_latency(Region.NORTH_AMERICA, Region.EUROPE),
            80
        )
        
        # Distant regions
        self.assertEqual(
            self.region_manager.get_latency(Region.SOUTH_AMERICA, Region.AFRICA),
            200
        )
        
        # Symmetric
        self.assertEqual(
            self.region_manager.get_latency(Region.EUROPE, Region.ASIA_PACIFIC),
            self.region_manager.get_latency(Region.ASIA_PACIFIC, Region.EUROPE)
        )
    
    def test_node_distribution(self):
        """Test node distribution tracking."""
        # Register nodes
        for _ in range(100):
            self.region_manager.register_node(Region.NORTH_AMERICA)
        for _ in range(50):
            self.region_manager.register_node(Region.EUROPE)
        for _ in range(30):
            self.region_manager.register_node(Region.ASIA_PACIFIC)
        
        # Check stats
        stats = self.region_manager.get_distribution_stats()
        self.assertEqual(stats["total_nodes"], 180)
        self.assertEqual(stats["regions_active"], 3)
        
        # Check distribution
        dist = stats["distribution"]
        self.assertEqual(dist["north_america"]["count"], 100)
        self.assertAlmostEqual(dist["north_america"]["percentage"], 55.56, places=1)
        self.assertEqual(dist["europe"]["count"], 50)
        self.assertEqual(dist["asia_pacific"]["count"], 30)
        
        # Unregister some nodes
        for _ in range(20):
            self.region_manager.unregister_node(Region.NORTH_AMERICA)
        
        stats = self.region_manager.get_distribution_stats()
        self.assertEqual(stats["total_nodes"], 160)
    
    def test_concentration_index(self):
        """Test concentration index calculation."""
        # Perfect distribution
        for region in Region:
            for _ in range(10):
                self.region_manager.register_node(region)
        
        stats = self.region_manager.get_distribution_stats()
        self.assertAlmostEqual(stats["concentration_index"], 0.0, places=2)
        
        # Reset
        self.region_manager = RegionManager()
        
        # All in one region
        for _ in range(100):
            self.region_manager.register_node(Region.EUROPE)
        
        stats = self.region_manager.get_distribution_stats()
        self.assertAlmostEqual(stats["concentration_index"], 1.0, places=2)
    
    def test_nearby_regions(self):
        """Test finding nearby regions."""
        # From North America
        nearby = self.region_manager.get_nearby_regions(Region.NORTH_AMERICA, max_latency=100)
        self.assertIn(Region.EUROPE, nearby)
        self.assertNotIn(Region.ASIA_PACIFIC, nearby)  # Too far (150ms)
        
        # From Europe
        nearby = self.region_manager.get_nearby_regions(Region.EUROPE, max_latency=100)
        self.assertIn(Region.NORTH_AMERICA, nearby)
        self.assertIn(Region.AFRICA, nearby)
        self.assertIn(Region.MIDDLE_EAST, nearby)
        
        # Check ordering (closest first)
        self.assertEqual(nearby[0], Region.AFRICA)  # 60ms
    
    def test_backup_regions(self):
        """Test backup region suggestions."""
        # Register some nodes
        self.region_manager.register_node(Region.EUROPE)
        self.region_manager.register_node(Region.ASIA_PACIFIC)
        
        # Get backups for North America
        backups = self.region_manager.suggest_backup_regions(Region.NORTH_AMERICA)
        
        # Should include nearby and populated regions
        self.assertIn(Region.EUROPE, backups)  # Nearby and has nodes
        self.assertEqual(len(backups), 3)  # 2 nearby + 1 distributed
    
    def test_optimal_coverage(self):
        """Test optimal region selection for global coverage."""
        # With no nodes, should return strategic regions
        optimal = self.region_manager.get_optimal_regions_for_global_coverage(3)
        self.assertEqual(len(optimal), 3)
        self.assertIn(Region.NORTH_AMERICA, optimal)
        self.assertIn(Region.EUROPE, optimal)
        self.assertIn(Region.ASIA_PACIFIC, optimal)
        
        # With some nodes
        self.region_manager.register_node(Region.SOUTH_AMERICA)
        self.region_manager.register_node(Region.AFRICA)
        
        optimal = self.region_manager.get_optimal_regions_for_global_coverage(3)
        self.assertIn(Region.SOUTH_AMERICA, optimal)  # Has nodes
        self.assertIn(Region.AFRICA, optimal)  # Has nodes
    
    def test_cloud_provider_detection(self):
        """Test cloud provider detection."""
        # AWS IPs
        self.assertEqual(self.geo_service.detect_cloud_provider("52.1.2.3"), "AWS")
        self.assertEqual(self.geo_service.detect_cloud_provider("54.1.2.3"), "AWS")
        
        # Google Cloud
        self.assertEqual(self.geo_service.detect_cloud_provider("35.190.1.2"), "Google Cloud")
        
        # Azure
        self.assertEqual(self.geo_service.detect_cloud_provider("20.1.2.3"), "Azure")
        
        # Non-cloud IP
        self.assertIsNone(self.geo_service.detect_cloud_provider("1.2.3.4"))
    
    def test_private_ip_detection(self):
        """Test private IP detection."""
        # Private IPs
        self.assertTrue(self.geo_service._is_private_ip("192.168.1.1"))
        self.assertTrue(self.geo_service._is_private_ip("10.0.0.1"))
        self.assertTrue(self.geo_service._is_private_ip("172.16.0.1"))
        self.assertTrue(self.geo_service._is_private_ip("127.0.0.1"))
        
        # Public IPs
        self.assertFalse(self.geo_service._is_private_ip("8.8.8.8"))
        self.assertFalse(self.geo_service._is_private_ip("1.1.1.1"))


if __name__ == '__main__':
    unittest.main() 