# QNet Node Activation System - Integration Guide

This guide explains how to integrate the QNet Node Activation System with your existing blockchain infrastructure. The activation system provides a secure method for allowing node operators to join the network using unique activation codes.

## System Components

The activation system consists of the following components:

1. **Token Verification API (`token_verification_api.py`)**
   - Manages activation codes generation and validation
   - Stores node and code data in SQLite database
   - Provides REST API endpoints for code operations

2. **Node Startup Integration (`node_startup_integration.py`)**
   - Handles verification during node startup
   - Manages activation data storage on the node
   - Provides CLI interface for activation

3. **API Integration (`api_integration.py`)**
   - Integrates the verification system with the main node API
   - Provides additional endpoints for node status and activation
   - Sets up middleware for protecting API endpoints

4. **Activation Web Page (`activation-page.html`)**
   - Provides a web interface for users to get activation codes
   - Integrates with wallet for token verification
   - Guides users through the activation process

5. **Installation Script (`install.sh`)**
   - Installs and configures the QNet node
   - Verifies activation code during installation
   - Sets up the environment for running the node

## Integration Steps

### 1. Install Required Components

Copy the following files to your project:

```
token_verification_api.py
node_startup_integration.py
api_integration.py
```

Make sure you also create the `activation-page.html` in your website templates directory.

### 2. Set Up Database

The activation system uses SQLite for storing data. The database will be created automatically when the API is initialized, but you should ensure the directory is writable by the node process.

### 3. Update `node.py`

Add the following imports to your `node.py` file:

```python
from token_verification_api import init_integration, token_verification_bp
from node_startup_integration import verify_node_startup
from api_integration import integrate_token_verification, setup_node_verification
```

Then add these lines to the initialization section:

```python
# Initialize token verification
activation_manager = init_integration(config_file='config.ini', test_mode=app_config.getboolean('Authentication', 'test_mode', fallback=True))

# Verify node startup
if not verify_node_startup(config_file='config.ini'):
    logging.error("Node verification failed. Exiting.")
    sys.exit(1)

# Integrate token verification with API
integrate_token_verification(app, config_file='config.ini')

# Setup node verification middleware
setup_node_verification(app, app_config)
```

### 4. Update Configuration

Ensure your `config.ini` file has the necessary authentication settings:

```ini
[Authentication]
verification_enabled = true
test_mode = true  # Set to false in production
wallet_address = test_wallet1  # Used in test mode

[PumpFun]
api_url = https://api.pump.fun
token_contract = test_contract
min_balance = 10000
check_interval = 86400
grace_period = 172800
```

### 5. Add Installation Script

Place the `install.sh` script in your repository so users can easily install the node.

### 6. Add Activation Page to Website

Integrate the `activation-page.html` into your website, modifying it to match your site's design. Update the JavaScript to connect to your actual backend API endpoints.

### 7. Set up Cron Job for Verification

Add a cron job to periodically verify activation status:

```bash
# Add to /etc/crontab
0 0 * * * root python3 /path/to/your/node/verify_activation.py
```

Create a simple script called `verify_activation.py`:

```python
#!/usr/bin/env python3
from node_startup_integration import NodeActivation

# Initialize activation handler
activation = NodeActivation(config_file='config.ini')

# Verify activation
if activation.verify_activation():
    print("Activation verified successfully")
else:
    print("Activation verification failed")
```

## Production Considerations

When moving to production, consider the following:

1. **Integration with Real Token Contracts**: Replace the mock token checks with actual integration with pump.fun or other token contracts.

2. **Secure API Keys**: Use proper API key management for admin endpoints.

3. **Database Security**: Consider encrypting sensitive data in the SQLite database or migrating to a more secure database system.

4. **Rate Limiting**: Implement rate limiting on all API endpoints to prevent abuse.

5. **Monitoring**: Set up monitoring for activation failures and suspicious activity.

6. **Backup Strategy**: Ensure regular backups of the activation database.

## Testing

To test the activation system:

1. Enable test mode in `config.ini`
2. Use the special test code `QNET-TEST-TEST-TEST` for testing
3. Verify the node starts successfully with the test code
4. Check the API endpoints for proper functionality

## Troubleshooting

Common issues and solutions:

- **Database Permission Issues**: Ensure the SQLite database file is writable by the node process
- **API Connection Errors**: Check network connectivity to API endpoints
- **Code Verification Failures**: Verify the code format and that it hasn't expired
- **Node Startup Failures**: Check logs for specific error messages related to activation

For any other issues, check the logs at `/var/log/qnet/node.log` and `/var/log/qnet/activation.log`.
