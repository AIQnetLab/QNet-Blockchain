#!/usr/bin/env python3
# -*- coding: utf-8 -*-

# File: QNet-Project/qnet-node/src/config_loader.py

import configparser
import os
import logging
from typing import Optional, Any, List, Dict # Added List import, and Dict

# Default configuration path relative to this file's location
# Assumes config_loader.py is in src/
DEFAULT_CONFIG_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../config/config.ini'))

# Configure logging specifically for this module if needed, or rely on global config
logger = logging.getLogger(__name__)

class AppConfig:
    """Loads and provides access to application configuration."""

    def __init__(self, config_path: Optional[str] = None):
        """
        Initialize configuration loader.

        Args:
            config_path: Optional path to the config.ini file.
                         Defaults to PROJECT_ROOT/config/config.ini.
        """
        self.parser = configparser.ConfigParser(interpolation=None) # Disable interpolation for simple key-value
        self.config_path = config_path or DEFAULT_CONFIG_PATH
        self._load_config()

    def _load_config(self):
        """Load configuration from file and environment variables."""
        # Start with default values or empty parser
        self.parser = configparser.ConfigParser(interpolation=None)

        if os.path.exists(self.config_path):
            try:
                self.parser.read(self.config_path)
                logger.info(f"Loaded configuration from {self.config_path}")
            except Exception as e:
                logger.error(f"Error reading config file {self.config_path}: {e}")
        else:
            logger.warning(f"Config file not found at {self.config_path}, using defaults and environment variables.")

        # Environment variables override file settings
        # Iterate through potential sections based on common naming conventions
        # This part might need adjustment based on how env vars are structured (e.g., QNET_NETWORK_PORT)
        for section in self.parser.sections():
             for key in self.parser[section]:
                 # Standard format QNET_SECTION_KEY
                 env_var_name = f"QNET_{section.upper()}_{key.upper()}"
                 env_value = os.environ.get(env_var_name)
                 if env_value is not None:
                     logger.info(f"Overriding config [{section}]{key} with environment variable {env_var_name}")
                     # Ensure the section exists before setting
                     if not self.parser.has_section(section):
                         self.parser.add_section(section)
                     self.parser.set(section, key, env_value)

        # Also check for common top-level env vars like QNET_PORT if they don't match section_key format
        # Example: Check QNET_PORT which might correspond to [Network] port
        network_port_env = os.environ.get("QNET_PORT")
        if network_port_env is not None:
             if not self.parser.has_section("Network"): self.parser.add_section("Network")
             if not self.parser.has_option("Network", "port") or self.parser.get("Network", "port") != network_port_env:
                 logger.info("Overriding config [Network]port with environment variable QNET_PORT")
                 self.parser.set("Network", "port", network_port_env)

        dashboard_port_env = os.environ.get("QNET_DASHBOARD_PORT")
        if dashboard_port_env is not None:
             if not self.parser.has_section("Network"): self.parser.add_section("Network")
             if not self.parser.has_option("Network", "dashboard_port") or self.parser.get("Network", "dashboard_port") != dashboard_port_env:
                 logger.info("Overriding config [Network]dashboard_port with environment variable QNET_DASHBOARD_PORT")
                 self.parser.set("Network", "dashboard_port", dashboard_port_env)

        external_ip_env = os.environ.get("QNET_EXTERNAL_IP")
        if external_ip_env is not None:
             if not self.parser.has_section("Network"): self.parser.add_section("Network")
             if not self.parser.has_option("Network", "external_ip") or self.parser.get("Network", "external_ip") != external_ip_env:
                 logger.info("Overriding config [Network]external_ip with environment variable QNET_EXTERNAL_IP")
                 self.parser.set("Network", "external_ip", external_ip_env)

        data_dir_env = os.environ.get("QNET_DATA_DIR")
        if data_dir_env is not None:
             if not self.parser.has_section("Storage"): self.parser.add_section("Storage")
             if not self.parser.has_option("Storage", "data_dir") or self.parser.get("Storage", "data_dir") != data_dir_env:
                 logger.info("Overriding config [Storage]data_dir with environment variable QNET_DATA_DIR")
                 self.parser.set("Storage", "data_dir", data_dir_env)

        storage_type_env = os.environ.get("QNET_STORAGE_TYPE")
        if storage_type_env is not None:
             if not self.parser.has_section("Storage"): self.parser.add_section("Storage")
             if not self.parser.has_option("Storage", "storage_type") or self.parser.get("Storage", "storage_type") != storage_type_env:
                 logger.info("Overriding config [Storage]storage_type with environment variable QNET_STORAGE_TYPE")
                 self.parser.set("Storage", "storage_type", storage_type_env)

    def get(self, section: str, key: str, fallback: Optional[Any] = None) -> Optional[str]:
        """Get a configuration value."""
        env_var_name = f"QNET_{section.upper()}_{key.upper()}"
        env_value = os.environ.get(env_var_name)
        if env_value is not None:
            return env_value
        try:
            return self.parser.get(section, key, fallback=fallback)
        except configparser.NoSectionError:
            return fallback
        except configparser.NoOptionError:
             # Check common top-level overrides if specific section/key fails
             if section == "Network" and key == "port":
                 return os.environ.get("QNET_PORT", fallback)
             if section == "Network" and key == "dashboard_port":
                 return os.environ.get("QNET_DASHBOARD_PORT", fallback)
             if section == "Network" and key == "external_ip":
                  return os.environ.get("QNET_EXTERNAL_IP", fallback)
             if section == "Storage" and key == "data_dir":
                  return os.environ.get("QNET_DATA_DIR", fallback)
             if section == "Storage" and key == "storage_type":
                  return os.environ.get("QNET_STORAGE_TYPE", fallback)
             return fallback


    def getint(self, section: str, key: str, fallback: Optional[int] = None) -> Optional[int]:
        """Get an integer configuration value."""
        value = self.get(section, key)
        if value is None:
            return fallback
        try:
            return int(value)
        except (ValueError, TypeError):
            logger.warning(f"Could not parse integer from config [{section}]{key}='{value}'. Falling back to {fallback}.")
            return fallback

    def getfloat(self, section: str, key: str, fallback: Optional[float] = None) -> Optional[float]:
        """Get a float configuration value."""
        value = self.get(section, key)
        if value is None:
            return fallback
        try:
            return float(value)
        except (ValueError, TypeError):
            logger.warning(f"Could not parse float from config [{section}]{key}='{value}'. Falling back to {fallback}.")
            return fallback

    def getboolean(self, section: str, key: str, fallback: Optional[bool] = None) -> Optional[bool]:
        """Get a boolean configuration value."""
        value = self.get(section, key)
        if value is None:
            return fallback
        try:
            # Handle configparser's boolean interpretation if needed, or be explicit
            if isinstance(value, bool): return value # Already boolean
            if value.lower() in ('true', 'yes', '1', 'on'):
                return True
            elif value.lower() in ('false', 'no', '0', 'off'):
                return False
            else:
                logger.warning(f"Could not parse boolean from config [{section}]{key}='{value}'. Falling back to {fallback}.")
                return fallback
        except AttributeError: # Handle if value is not a string
            logger.warning(f"Could not parse boolean from config [{section}]{key}='{value}'. Falling back to {fallback}.")
            return fallback

    def getlist(self, section: str, key: str, delimiter: str = ',', fallback: Optional[list] = None) -> List[str]:
         """Get a list configuration value."""
         value = self.get(section, key)
         if value is None or value == '': # Treat empty string as empty list unless fallback provided
             return fallback if fallback is not None else []
         # Split by delimiter and strip whitespace from each item
         return [item.strip() for item in value.split(delimiter) if item.strip()]

    def get_section(self, section: str) -> Optional[Dict[str, str]]:
         """Get a whole section as a dictionary."""
         if self.parser.has_section(section):
             return dict(self.parser.items(section))
         # Check environment variables for section keys if section doesn't exist in file
         env_prefix = f"QNET_{section.upper()}_"
         section_data = {}
         for env_key, env_value in os.environ.items():
             if env_key.startswith(env_prefix):
                 config_key = env_key[len(env_prefix):].lower()
                 section_data[config_key] = env_value
         return section_data if section_data else None # Return dict if found via env, else None

    def reload(self):
         """Reload configuration from file and environment."""
         # Reset parser completely before reloading
         self.parser = configparser.ConfigParser(interpolation=None)
         self._load_config()

# Singleton instance
_app_config_instance = None

def get_config(config_path: Optional[str] = None) -> AppConfig:
    """Get the singleton AppConfig instance, initializing if needed."""
    global _app_config_instance
    if _app_config_instance is None:
        _app_config_instance = AppConfig(config_path)
    # Optionally reload if a different path is provided later, though typically should be set once
    elif config_path and _app_config_instance.config_path != config_path:
         logger.warning(f"Re-initializing config with new path: {config_path}")
         _app_config_instance = AppConfig(config_path)

    return _app_config_instance