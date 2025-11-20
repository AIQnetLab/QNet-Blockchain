# QNet Dilithium3 WASM Module

CRYSTALS-Dilithium3 post-quantum digital signatures compiled to WebAssembly for React Native.

## Features

- ✅ **NIST Level 3 Security** (192-bit equivalent)
- ✅ **Production-ready** pqcrypto-dilithium implementation
- ✅ **Optimized for mobile** - ~200KB WASM binary
- ✅ **Hybrid signatures** - Ed25519 + Dilithium3
- ✅ **React Native compatible** via Hermes WASM support

## Building

```bash
# Install Rust and wasm-pack
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
cargo install wasm-pack

# Build WASM module
cd applications/qnet-mobile/rust-dilithium
chmod +x build.sh
./build.sh
```

## Usage in React Native

```javascript
import init, { 
  Dilithium3Keypair, 
  dilithium3_sign, 
  dilithium3_verify,
  create_hybrid_signature 
} from './crypto/wasm/qnet_dilithium_wasm';

// Initialize WASM module
await init();

// Generate keypair
const keypair = new Dilithium3Keypair();
console.log('Public key:', keypair.public_key);
console.log('Secret key:', keypair.secret_key);

// Sign message
const message = new TextEncoder().encode('Hello, QNet!');
const signature = dilithium3_sign(message, keypair.secret_key);

// Verify signature
const isValid = dilithium3_verify(message, signature, keypair.public_key);
console.log('Valid:', isValid);

// Create hybrid signature (Ed25519 + Dilithium3)
const ed25519Sig = nacl.sign.detached(message, ed25519SecretKey);
const hybridSig = create_hybrid_signature(
  message,
  Buffer.from(ed25519Sig).toString('base64'),
  keypair.secret_key
);
```

## Performance

- **Keypair generation**: ~50ms on modern mobile devices
- **Signing**: ~30ms
- **Verification**: ~20ms
- **WASM binary size**: ~200KB (optimized)

## Security

- Based on NIST-standardized CRYSTALS-Dilithium
- Resistant to quantum computer attacks
- Follows CISCO/NIST post-quantum migration guidelines
- Production-ready implementation from pqcrypto project

## License

Part of QNet Blockchain Project

