# QNet Node

Network node implementation for the QNet blockchain with peer discovery and synchronization capabilities.

## Features

- **Decentralized peer discovery** for network growth
- **Efficient block and transaction synchronization**
- **Network partition management** for improved resilience
- **Resource-efficient operation** suitable for mobile and low-power devices
- **Docker containerization** for easy deployment

## Repository Structure

- `src/node/`: Core node functionality
- `src/discovery/`: Peer discovery mechanisms
- `src/sync/`: Blockchain synchronization logic
- `config/`: Configuration files
- `scripts/`: Utility scripts for installation and maintenance
- `docker/`: Docker-related files

## Installation

For detailed installation instructions, see `scripts/install/install.sh`

## Docker Deployment

```bash
docker-compose up -d