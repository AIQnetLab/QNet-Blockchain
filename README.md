# QNet Improvements

This document describes key improvements to the QNet project code to address identified issues.

## 1. Fixing multiple `sed` commands in Dockerfile

Instead of using multiple `sed` commands to fix source code directly in the Dockerfile, we've adopted an approach with pre-patched files placed in a `patches/` directory. This improves readability and maintainability.

### Changes:
- Created corrected versions of `crypto.rs` and `merkle.rs` with proper Rust code handling
- Files are placed in the container during build, rather than being edited with `sed` commands
- Simplified Dockerfile build process

## 2. Proper storage system integration

Added a proper architecture for choosing storage type with the ability to switch between in-memory and RocksDB.

### Changes:
- Created `storage_config.py` module for storage configuration
- Added `storage_factory.py` factory for creating storage instances
- Implemented mechanism for automatic fallback to alternative storage type on errors
- Configuration through environment variables in docker-compose.yml

## 3. Secure key management

Completely reworked the module for managing cryptographic keys with focus on security.

### Changes:
- Implemented `KeyManager` class for centralized key management
- Added optional password protection for keys using AES-GCM
- Implemented secure key file storage (0600 permissions)
- Proper handling of data types (bytes/str) for cryptographic operations

## 4. Docker-compose.yml improvements

Updated Docker Compose configuration to enhance security and flexibility.

### Changes:
- Update to version 3.8 with modern capabilities
- Added additional security settings (cap_drop, read_only)
- Improved health check with added start_period
- Added additional environment variables for configuration

## Using the improvements

### Preparation

1. Create the `patches/` directory in the project root:
   ```bash
   mkdir -p patches
   ```

2. Place the fixed files in the appropriate locations:
   ```bash
   # Create patches/crypto.rs file
   cp crypto-rs-patch patches/crypto.rs
   
   # Create patches/merkle.rs file
   cp merkle-rs-patch patches/merkle.rs
   
   # Create patches/key_manager.py file
   cp key-manager patches/key_manager.py
   
   # Create patches/storage_config.py file
   cp storage-config patches/storage_config.py
   
   # Create patches/storage_factory.py file
   cp storage-factory patches/storage_factory.py
   ```

3. Replace existing files:
   ```bash
   # Replace Dockerfile
   cp dockerfile-improved Dockerfile
   
   # Replace docker-compose.yml
   cp docker-compose-improved docker-compose.yml
   ```

### Startup

Start the system using Docker Compose:
```bash
docker-compose up -d
```

## Testing

After implementing changes, it's recommended to test:

1. Different storage types:
   ```bash
   # Testing with RocksDB
   QNET_STORAGE_TYPE=rocksdb docker-compose up -d
   
   # Testing with memory storage
   QNET_STORAGE_TYPE=memory docker-compose up -d
   ```

2. Key generation and verification:
   ```bash
   # Check key API
   curl http://localhost:8000/api/node/public_key
   ```

3. Check logs for errors:
   ```bash
   docker-compose logs -f
   ```

## Additional improvements

1. **Tests**: Add unit tests for `KeyManager` and `StorageFactory`
2. **Monitoring**: Enhance monitoring system with Prometheus metrics
3. **CI/CD**: Add pipeline for automatic building and testing
