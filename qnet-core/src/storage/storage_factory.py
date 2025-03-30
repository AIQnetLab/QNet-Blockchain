#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: storage_factory.py
Factory for creating different storage backends for QNet
"""

import os
import logging
import importlib
from typing import Any, Optional, Dict

# Default storage type if not specified
DEFAULT_STORAGE_TYPE = "memory"

# Storage instance cache
_storage_instances = {}

def get_storage(storage_type: Optional[str] = None, config: Optional[Dict[str, Any]] = None) -> Any:
    """
    Get a storage instance of the specified type.
    
    Args:
        storage_type: Storage type ('memory', 'rocksdb', etc.)
                     If None, uses QNET_STORAGE_TYPE env var or default
        config: Optional configuration parameters
        
    Returns:
        Storage instance
    """
    # Determine storage type
    if storage_type is None:
        storage_type = os.environ.get('QNET_STORAGE_TYPE', DEFAULT_STORAGE_TYPE)
    
    # Check if we already have a cached instance of this type
    if storage_type in _storage_instances:
        return _storage_instances[storage_type]
    
    # Create new storage instance
    try:
        if storage_type == 'memory':
            storage = _create_memory_storage(config)
        elif storage_type == 'rocksdb':
            storage = _create_rocksdb_storage(config)
        else:
            logging.warning(f"Unknown storage type '{storage_type}', falling back to memory storage")
            storage = _create_memory_storage(config)
        
        # Cache the instance
        _storage_instances[storage_type] = storage
        
        return storage
    except Exception as e:
        logging.error(f"Failed to create {storage_type} storage: {e}")
        
        # If the requested storage failed and it's not already a fallback,
        # try to create memory storage as a fallback
        if storage_type != 'memory' and storage_type != DEFAULT_STORAGE_TYPE:
            logging.warning(f"Falling back to memory storage")
            return get_storage('memory', config)
        
        # If we're already trying memory storage and it failed, re-raise the exception
        raise

def _create_memory_storage(config: Optional[Dict[str, Any]] = None) -> Any:
    """
    Create a memory storage instance.
    
    Args:
        config: Optional configuration parameters
        
    Returns:
        Memory storage instance
    """
    try:
        # Try to import memory_storage module
        from memory_storage import StorageManager
        
        # Extract relevant config options
        storage_config = {}
        if config:
            # Map generic config to memory storage config
            if 'data_dir' in config:
                storage_config['data_dir'] = config['data_dir']
            if 'use_compression' in config:
                storage_config['use_compression'] = config['use_compression']
            if 'memory_limit_mb' in config:
                storage_config['max_memory_mb'] = config['memory_limit_mb']
        
        # Set default data directory if not specified
        if 'data_dir' not in storage_config:
            storage_config['data_dir'] = os.environ.get('QNET_DATA_DIR', '/app/data')
        
        # Create and return instance
        return StorageManager(**storage_config)
    except ImportError:
        # If the modern version is not available, try to import legacy version
        try:
            from storage import MemoryStorageManager
            
            # Legacy storage may have different parameters
            storage_config = {}
            if config and 'data_dir' in config:
                storage_config['data_dir'] = config['data_dir']
            
            return MemoryStorageManager(**storage_config)
        except ImportError:
            logging.error("Neither modern nor legacy memory storage modules found")
            raise

def _create_rocksdb_storage(config: Optional[Dict[str, Any]] = None) -> Any:
    """
    Create a RocksDB storage instance.
    
    Args:
        config: Optional configuration parameters
        
    Returns:
        RocksDB storage instance
    """
    try:
        # First try to import modern rocksdb_storage
        try:
            from rocksdb_storage import RocksDBStorageManager
            
            # Extract relevant config options
            storage_config = {}
            if config:
                if 'data_dir' in config:
                    storage_config['db_path'] = os.path.join(config['data_dir'], 'rocksdb')
                if 'max_open_files' in config:
                    storage_config['max_open_files'] = config['max_open_files']
            
            # Set default DB path if not specified
            if 'db_path' not in storage_config:
                data_dir = os.environ.get('QNET_DATA_DIR', '/app/data')
                storage_config['db_path'] = os.path.join(data_dir, 'rocksdb')
            
            return RocksDBStorageManager(**storage_config)
        except ImportError:
            # If modern version not available, try legacy storage
            from storage import RocksDBStorageManager
            
            # Legacy storage may have different parameters
            storage_config = {}
            if config and 'data_dir' in config:
                storage_config['data_dir'] = config['data_dir']
            
            return RocksDBStorageManager(**storage_config)
    except ImportError:
        # Check if rocksdb Python package is available
        try:
            import rocksdb
            logging.error("RocksDB package is available but QNet RocksDB storage module not found")
        except ImportError:
            logging.error("RocksDB Python package not installed")
        
        raise ImportError("RocksDB storage not available")

def get_available_storage_types() -> Dict[str, bool]:
    """
    Get a dictionary of available storage types.
    
    Returns:
        Dictionary mapping storage type names to availability (True/False)
    """
    available = {
        'memory': True,  # Memory storage is always available
        'rocksdb': False
    }
    
    # Check if RocksDB is available
    try:
        import rocksdb
        # Try to import storage module
        try:
            from rocksdb_storage import RocksDBStorageManager
            available['rocksdb'] = True
        except ImportError:
            try:
                from storage import RocksDBStorageManager
                available['rocksdb'] = True
            except ImportError:
                pass
    except ImportError:
        pass
    
    return available

def clear_storage_cache() -> None:
    """Clear the storage instance cache."""
    global _storage_instances
    # Close any open storage instances
    for storage_type, instance in _storage_instances.items():
        if hasattr(instance, 'close'):
            try:
                instance.close()
            except Exception as e:
                logging.warning(f"Error closing {storage_type} storage: {e}")
    
    # Clear cache
    _storage_instances = {}