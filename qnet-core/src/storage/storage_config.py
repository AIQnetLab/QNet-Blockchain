#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: storage_config.py
Complete configuration for QNet storage systems
"""

import os
import logging
import json
from typing import Dict, Any, Optional, Tuple

# Supported storage types
STORAGE_TYPE_MEMORY = "memory"
STORAGE_TYPE_ROCKSDB = "rocksdb"

class StorageConfig:
    """Configuration for QNet storage systems"""
    
    def __init__(self, config_file: Optional[str] = None):
        """
        Initialize storage configuration
        
        Args:
            config_file: Optional path to configuration file
        """
        # Default values
        self.storage_type = os.environ.get("QNET_STORAGE_TYPE", STORAGE_TYPE_ROCKSDB)
        self.data_dir = os.environ.get("QNET_DATA_DIR", "/app/blockchain_data")
        
        # RocksDB parameters
        self.rocksdb_create_if_missing = True
        self.rocksdb_max_open_files = int(os.environ.get("QNET_ROCKSDB_MAX_OPEN_FILES", "300"))
        self.rocksdb_write_buffer_size = int(os.environ.get("QNET_ROCKSDB_WRITE_BUFFER_SIZE", "67108864"))  # 64MB
        self.rocksdb_max_write_buffer_number = int(os.environ.get("QNET_ROCKSDB_MAX_WRITE_BUFFER", "3"))
        self.rocksdb_target_file_size_base = int(os.environ.get("QNET_ROCKSDB_TARGET_FILE_SIZE", "67108864"))  # 64MB
        self.rocksdb_max_background_compactions = int(os.environ.get("QNET_ROCKSDB_MAX_BACKGROUND_COMPACTIONS", "4"))
        self.rocksdb_max_background_flushes = int(os.environ.get("QNET_ROCKSDB_MAX_BACKGROUND_FLUSHES", "2"))
        self.rocksdb_bloom_filter_bits = int(os.environ.get("QNET_ROCKSDB_BLOOM_FILTER_BITS", "10"))
        
        # In-memory storage parameters
        self.memory_limit_mb = int(os.environ.get("QNET_MEMORY_LIMIT_MB", "512"))
        self.memory_eviction_policy = os.environ.get("QNET_MEMORY_EVICTION_POLICY", "lru")
        self.memory_checkpoint_interval = int(os.environ.get("QNET_MEMORY_CHECKPOINT_INTERVAL", "3600"))  # 1 hour
        self.memory_checkpoint_enabled = os.environ.get("QNET_MEMORY_CHECKPOINT_ENABLED", "true").lower() == "true"
        self.memory_checkpoint_dir = os.environ.get("QNET_MEMORY_CHECKPOINT_DIR", "/app/snapshots")
        
        # Common storage parameters
        self.block_cache_size_mb = int(os.environ.get("QNET_BLOCK_CACHE_SIZE_MB", "128"))
        self.compaction_interval = int(os.environ.get("QNET_COMPACTION_INTERVAL", "86400"))  # 24 hours
        self.backup_enabled = os.environ.get("QNET_BACKUP_ENABLED", "true").lower() == "true"
        self.backup_interval = int(os.environ.get("QNET_BACKUP_INTERVAL", "86400"))  # 24 hours
        self.backup_count = int(os.environ.get("QNET_BACKUP_COUNT", "7"))
        self.backup_dir = os.environ.get("QNET_BACKUP_DIR", "/app/snapshots")
        
        # Load configuration from file if specified
        if config_file and os.path.exists(config_file):
            self._load_config_file(config_file)
            
        # Check and correct configuration
        self._validate_config()
        
    def _load_config_file(self, config_file: str) -> None:
        """
        Load configuration from file
        
        Args:
            config_file: Path to configuration file
        """
        try:
            with open(config_file, 'r') as f:
                config_data = json.load(f)
                
            # Update parameters from file
            for key, value in config_data.items():
                if hasattr(self, key):
                    setattr(self, key, value)
                    
            logging.info(f"Loaded storage configuration from {config_file}")
        except Exception as e:
            logging.error(f"Failed to load storage configuration from {config_file}: {e}")
        
    def _validate_config(self) -> None:
        """Validate and adjust configuration"""
        # Check storage type
        if self.storage_type not in [STORAGE_TYPE_MEMORY, STORAGE_TYPE_ROCKSDB]:
            logging.warning(f"Invalid storage type: {self.storage_type}. Falling back to memory storage.")
            self.storage_type = STORAGE_TYPE_MEMORY
            
        # Check RocksDB availability if selected
        if self.storage_type == STORAGE_TYPE_ROCKSDB:
            try:
                import rocksdb
            except ImportError:
                logging.warning("RocksDB Python bindings not available. Falling back to memory storage.")
                self.storage_type = STORAGE_TYPE_MEMORY
                
        # Check directories
        self._ensure_directory(self.data_dir)
        if self.backup_enabled:
            self._ensure_directory(self.backup_dir)
        if self.memory_checkpoint_enabled:
            self._ensure_directory(self.memory_checkpoint_dir)
            
        # Adjust limits
        if self.memory_limit_mb < 64:
            logging.warning(f"Memory limit too low: {self.memory_limit_mb}MB. Setting to 64MB.")
            self.memory_limit_mb = 64
            
        if self.rocksdb_max_open_files < 50:
            logging.warning(f"RocksDB max_open_files too low: {self.rocksdb_max_open_files}. Setting to 50.")
            self.rocksdb_max_open_files = 50
            
    def _ensure_directory(self, directory: str) -> None:
        """
        Check if directory exists and create it if necessary
        
        Args:
            directory: Path to directory to check
        """
        if not os.path.exists(directory):
            try:
                os.makedirs(directory, exist_ok=True)
                logging.info(f"Created directory: {directory}")
            except Exception as e:
                logging.error(f"Failed to create directory {directory}: {e}")
                
    def get_rocksdb_options(self) -> Dict[str, Any]:
        """
        Returns dictionary of options for RocksDB
        
        Returns:
            Dict[str, Any]: Dictionary of RocksDB options
        """
        return {
            'create_if_missing': self.rocksdb_create_if_missing,
            'max_open_files': self.rocksdb_max_open_files,
            'write_buffer_size': self.rocksdb_write_buffer_size,
            'max_write_buffer_number': self.rocksdb_max_write_buffer_number,
            'target_file_size_base': self.rocksdb_target_file_size_base,
            'max_background_compactions': self.rocksdb_max_background_compactions,
            'max_background_flushes': self.rocksdb_max_background_flushes,
            'bloom_filter_bits_per_key': self.rocksdb_bloom_filter_bits,
        }
        
    def get_memory_options(self) -> Dict[str, Any]:
        """
        Returns dictionary of options for in-memory storage
        
        Returns:
            Dict[str, Any]: Dictionary of in-memory storage options
        """
        return {
            'memory_limit_mb': self.memory_limit_mb,
            'eviction_policy': self.memory_eviction_policy,
            'checkpoint_enabled': self.memory_checkpoint_enabled,
            'checkpoint_interval': self.memory_checkpoint_interval,
            'checkpoint_dir': self.memory_checkpoint_dir,
        }
        
    def get_backup_options(self) -> Dict[str, Any]:
        """
        Returns dictionary of options for backups
        
        Returns:
            Dict[str, Any]: Dictionary of backup options
        """
        return {
            'enabled': self.backup_enabled,
            'interval': self.backup_interval,
            'count': self.backup_count,
            'dir': self.backup_dir,
        }
        
    def save_config(self, config_file: str) -> bool:
        """
        Saves current configuration to file
        
        Args:
            config_file: Path to file to save
            
        Returns:
            bool: True if configuration saved successfully, False otherwise
        """
        try:
            config_data = {}
            
            # Collect all attributes that don't start with underscore
            for key, value in self.__dict__.items():
                if not key.startswith('_'):
                    config_data[key] = value
                    
            # Create directory for configuration if it doesn't exist
            os.makedirs(os.path.dirname(config_file), exist_ok=True)
            
            # Save configuration to file
            with open(config_file, 'w') as f:
                json.dump(config_data, f, indent=2)
                
            logging.info(f"Saved storage configuration to {config_file}")
            return True
        except Exception as e:
            logging.error(f"Failed to save storage configuration to {config_file}: {e}")
            return False
            
    def get_storage_manager(self):
        """
        Creates and returns appropriate storage manager
        
        Returns:
            StorageManager: Storage manager of appropriate type
        """
        if self.storage_type == STORAGE_TYPE_ROCKSDB:
            try:
                from storage.rocksdb_storage import RocksDBStorageManager
                return RocksDBStorageManager(self)
            except ImportError:
                logging.error("Failed to import RocksDB storage manager. Falling back to memory storage.")
                self.storage_type = STORAGE_TYPE_MEMORY
                
        # Default or fallback to in-memory storage
        from storage.memory_storage import MemoryStorageManager
        return MemoryStorageManager(self)