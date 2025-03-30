# QNet SDK

Software Development Kit for integrating with the QNet blockchain.

## Features

- **Client libraries** for interacting with QNet nodes
- **Transaction creation and signing** utilities
- **Wallet management** functions
- **Examples** for common use cases
- **Cross-platform compatibility**

## Repository Structure

- `src/sdk/`: Core SDK code
- `examples/`: Example applications and usage patterns
- `docs/`: SDK documentation

## Usage

```python
from qnet_sdk import QNetClient

# Initialize client
client = QNetClient("http://localhost:8000")

# Get blockchain info
status = client.get_status()
print(f"Current height: {status['height']}")