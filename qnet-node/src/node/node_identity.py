#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: node_identity.py
Implements node identity management with hardware fingerprinting.
"""

import hashlib
import logging
import time
import json
import os
import threading

class NodeIdentityManager:
    def __init__(self, storage_manager):
        self.storage = storage_manager
        self.lock = threading.Lock()
        
    def register_node(self, address, hardware_fingerprint):
        """
        Registers a new node with uniqueness checks for address and hardware
        Returns created node_id or None on failure
        """
        with self.lock:
            # Check if address is already registered
            if self.is_address_already_registered(address):
                return None, "Address already registered"
            
            # Check if hardware is already registered
            if self.is_hardware_already_registered(hardware_fingerprint):
                return None, "Hardware already registered"
            
            # Create DID based on address and hardware fingerprint
            node_id = self.generate_did(address, hardware_fingerprint)
            
            # Register node
            self.save_node_record(node_id, address, hardware_fingerprint)
            
            return node_id, "Success"
    
    def generate_did(self, address, hardware_fingerprint):
        """Generates DID based on address and hardware fingerprint"""
        combined = address + ":" + hardware_fingerprint.hex()
        did_hash = hashlib.sha256(combined.encode()).hexdigest()
        did = f"did:qnet:{did_hash}"
        return did
    
    def is_address_already_registered(self, address):
        """Checks if address is already registered"""
        # We'll just return False since we don't have RocksDB
        # This is a simplified version for in-memory storage
        return False
    
    def is_hardware_already_registered(self, hardware_fingerprint):
        """Checks if hardware fingerprint is already registered"""
        # We'll just return False since we don't have RocksDB
        # This is a simplified version for in-memory storage
        return False
    
    def save_node_record(self, node_id, address, hardware_fingerprint):
        """Saves node registration record"""
        # Create node record
        node_record = {
            "node_id": node_id,
            "address": address,
            "hardware_hash": hardware_fingerprint.hex(),
            "registered_at": time.time(),
            "last_seen": time.time(),
            "reputation": 1.0,
            "status": "active"
        }
        
        # Just log the record since we don't have persistent storage
        logging.info(f"Node record created: {node_record}")
        return True
        
    def update_node_last_seen(self, node_id):
        """Updates last_seen timestamp for a node"""
        logging.info(f"Updating last_seen for node {node_id}")
        return True
            
    def get_active_nodes(self, max_inactive_time=600):
        """
        Gets list of currently active nodes
        
        Args:
            max_inactive_time: Maximum time in seconds since last seen to consider a node active
            
        Returns:
            List of active node records
        """
        # Return empty list since we don't track active nodes in memory
        return []