#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Main API server for QNet Node
Handles all HTTP endpoints and routes
"""

import os
import sys
import logging
from flask import Flask

# Optional CORS import
try:
    from flask_cors import CORS
    CORS_AVAILABLE = True
except ImportError:
    CORS_AVAILABLE = False
    print("WARNING: flask-cors not available. Install with: pip install flask-cors")

# Add project paths to sys.path
current_dir = os.path.dirname(os.path.abspath(__file__))
src_dir = os.path.abspath(os.path.join(current_dir, '..'))
project_root = os.path.abspath(os.path.join(current_dir, '..', '..', '..'))

if src_dir not in sys.path:
    sys.path.insert(0, src_dir)
if project_root not in sys.path:
    sys.path.insert(0, project_root)

# Setup logging
logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)

# Create Flask app
app = Flask(__name__)

# Enable CORS if available
if CORS_AVAILABLE:
    CORS(app)
    print("✓ CORS enabled")
else:
    print("⚠ CORS not enabled (flask-cors not installed)")

# Configure Flask logging
app.logger.setLevel(logging.DEBUG)

# Import configuration
try:
    from config_loader import get_config
    config = get_config()
    app.logger.info(f"Loaded configuration from {config.config_file_path if hasattr(config, 'config_file_path') else 'default location'}")
    app.logger.info("Configuration loaded successfully")
except ImportError as e:
    app.logger.error(f"Failed to import config_loader: {e}")
    # Create dummy config
    class DummyConfig:
        def get(self, section, key, fallback=None): return fallback
        def getint(self, section, key, fallback=None): return fallback
        def getboolean(self, section, key, fallback=None): return fallback
    config = DummyConfig()

# Import and register activation bridge API
try:
    from activation_bridge_api import activation_bp
    app.register_blueprint(activation_bp, url_prefix='/api/v1/activation')
    app.logger.info("✓ Activation Bridge API registered successfully")
    
    # Verify critical functions are available
    import activation_bridge_api
    if hasattr(activation_bridge_api, 'check_solana_burn_tx_details'):
        app.logger.info("✓ check_solana_burn_tx_details function found")
    else:
        app.logger.error("✗ check_solana_burn_tx_details function NOT found")
        
except ImportError as e:
    app.logger.error(f"✗ Failed to import activation_bridge_api: {e}")
    app.logger.error("Activation endpoints will not be available")

# Import and register smart contracts API
try:
    from smart_contracts_api import smart_contracts_bp
    app.register_blueprint(smart_contracts_bp, url_prefix='/api/v1/contracts')
    app.logger.info("✓ Smart Contracts API registered successfully")
except ImportError as e:
    app.logger.error(f"✗ Failed to import smart_contracts_api: {e}")
    app.logger.error("Smart contract endpoints will not be available")

# Import and register pricing API
try:
    from pricing_api import pricing_bp
    app.register_blueprint(pricing_bp, url_prefix='/api/v1/pricing')
    app.logger.info("✓ Pricing API registered successfully")
except ImportError as e:
    app.logger.error(f"✗ Failed to import pricing_api: {e}")
    app.logger.error("Pricing endpoints will not be available")

# Health check endpoint
@app.route('/health', methods=['GET'])
def health_check():
    """Basic health check endpoint"""
    return {
        "status": "healthy",
        "message": "QNet API Server is running",
        "version": config.get("App", "version", fallback="unknown")
    }

# Root endpoint
@app.route('/', methods=['GET'])
def root():
    """Root endpoint with API information"""
    return {
        "name": "QNet Node API",
        "version": config.get("App", "version", fallback="unknown"),
        "status": "running",
        "endpoints": {
            "/health": "Health check",
            "/api/v1/activation/request_activation_token": "Request activation token",
            "/api/v1/activation/health": "Activation service health",
            "/api/v1/activation/config": "Activation service config",
            "/api/v1/activation/test_signature": "Test signature verification",
            "/api/v1/contracts/health": "Smart contracts service health",
            "/api/v1/contracts/deploy": "Deploy smart contract",
            "/api/v1/contracts/call": "Call contract method",
            "/api/v1/contracts/view": "View contract state",
            "/api/v1/contracts/estimate_gas": "Estimate gas for operation",
            "/api/v1/contracts/templates": "Get contract templates",
            "/api/v1/pricing/current_prices": "Get current node activation prices",
            "/api/v1/pricing/price_for_node": "Get price for specific node type",
            "/api/v1/pricing/burn_progress": "Get QNA burn progress",
            "/api/v1/pricing/value_preservation": "Calculate QNA value preservation",
            "/api/v1/pricing/price_history": "Get historical pricing data",
            "/api/v1/pricing/simulate_pricing": "Simulate pricing scenarios"
        }
    }

# Error handlers
@app.errorhandler(404)
def not_found(error):
    return {"error": "Endpoint not found"}, 404

@app.errorhandler(500)
def internal_server_error(error):
    app.logger.error(f"Internal server error: {error}")
    return {"error": "Internal server error"}, 500

if __name__ == '__main__':
    print("=" * 60)
    print("QNet Node API Server Starting")
    print("=" * 60)
    
    # Get server configuration
    host = config.get("Network", "external_ip", fallback="0.0.0.0")
    if host == "auto":
        host = "0.0.0.0"
    port = config.getint("Network", "port", fallback=8000)
    debug = config.getboolean("System", "debug", fallback=True)
    
    print(f"Host: {host}")
    print(f"Port: {port}")
    print(f"Debug: {debug}")
    print("=" * 60)
    
    # Log loaded activation modules
    activation_modules = [mod for mod in sys.modules.keys() if 'activation' in mod.lower()]
    if activation_modules:
        print("Loaded activation modules:")
        for mod in activation_modules:
            print(f"  - {mod}")
    else:
        print("No activation modules found")
    
    # Log loaded smart contract modules
    contract_modules = [mod for mod in sys.modules.keys() if 'contract' in mod.lower() or 'vm' in mod.lower()]
    if contract_modules:
        print("Loaded smart contract modules:")
        for mod in contract_modules:
            print(f"  - {mod}")
    
    print("=" * 60)
    print("Starting Flask development server...")
    print("Press Ctrl+C to stop")
    print("=" * 60)
    
    try:
        app.run(
            host=host,
            port=port,
            debug=debug,
            use_reloader=False  # Disable reloader to prevent module caching issues
        )
    except KeyboardInterrupt:
        print("\n" + "=" * 60)
        print("Server stopped by user")
        print("=" * 60)
    except Exception as e:
        print(f"\nServer error: {e}")
        sys.exit(1)