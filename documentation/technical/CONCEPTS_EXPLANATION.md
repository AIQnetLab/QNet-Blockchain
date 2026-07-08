# Key Concepts Explained

## 🔀 What is Sharding?

### Simple Explanation
Imagine you have a huge library with millions of books. One librarian cannot serve all visitors quickly. The solution? Divide the library into sections (shards), and assign a librarian to each section.

### In Blockchain Context
Sharding is dividing the blockchain into multiple parallel chains (shards), where each:
- Processes its portion of transactions
- Stores its portion of data
- Has its own group of validators

### How Sharding Works in QNet

> **Status:** QNet runs **single-shard by design** today. A single chain is enough
> for QNet's target throughput (~50K TPS), so the sharding auto-arm is gated OFF.
> Sharding is a **future option**, not active — the diagrams below illustrate the
> deferred multi-shard design, not current behavior.

```
Without Sharding (current, single-shard):
┌─────────────────────┐
│  All Transactions   │
│     (~50K TPS)      │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│   Single Chain      │
│  Processes All      │
└─────────────────────┘

With Sharding (future option, off today):
┌─────────────────────┐
│  All Transactions   │
│    (1M+ TPS)        │
└──────────┬──────────┘
           │
    ┌──────┴──────┬──────┬──────┐
    ▼             ▼      ▼      ▼
┌────────┐  ┌────────┐ ┌────────┐ ┌────────┐
│ Shard 1│  │ Shard 2│ │ Shard 3│ │ Shard 4│
│250K TPS│  │250K TPS│ │250K TPS│ │250K TPS│
└────────┘  └────────┘ └────────┘ └────────┘
```

### How Transactions are Assigned to Shards

```python
# Simple example
def get_shard(address):
    # Get hash of address
    hash_value = hash(address)
    # Determine shard by modulo operation
    shard_id = hash_value % 4  # If we have 4 shards
    return shard_id

# Examples:
# Address "Alice123" → Shard 2
# Address "Bob456" → Shard 0
# Address "Carol789" → Shard 3
```

### Sharding Challenges

1. **Cross-shard transactions** - when Alice (Shard 1) sends money to Bob (Shard 3)
2. **Synchronization** - shards must know about each other's state
3. **Security** - each shard has fewer validators

### Why It's Important for QNet
- Without sharding: maximum ~100-200K TPS
- With sharding: 1M+ TPS (linear scaling)

---

## 🖥️ What is CLI (Command Line Interface)?

### Simple Explanation
CLI is a program that allows you to control the system through text commands in a terminal (command line).

### Example CLI Commands for QNet

```bash
# Create new wallet
qnet wallet create --name my-wallet

# Check balance
qnet wallet balance

# Start node
qnet node start --type full

# Send transaction
qnet tx send --to Bob --amount 100 --gas 10

# Check network status
qnet network status

# View block information
qnet block info --height 12345
```

### Why CLI is Needed

1. **Automation** - can write scripts
2. **Remote management** - via SSH
3. **Efficiency** - faster than GUI
4. **For developers** - debugging and testing

### QNet CLI Structure

```
qnet
├── wallet      # Wallet management
│   ├── create
│   ├── import
│   ├── balance
│   └── list
├── node        # Node management
│   ├── start
│   ├── stop
│   ├── status
│   └── config
├── tx          # Transaction operations
│   ├── send
│   ├── status
│   └── history
└── network     # Network information
    ├── status
    ├── peers
    └── stats
```

---

## 📦 What is SDK (Software Development Kit)?

### Simple Explanation
SDK is a set of tools for developers to create applications that work with your system.

### Example: QNet SDK for JavaScript

```javascript
// Installation
npm install @qnet/sdk

// Usage
import { QNetSDK } from '@qnet/sdk';

// Initialize
const qnet = new QNetSDK({
  network: 'mainnet',
  nodeUrl: 'http://NODE_IP:8001' // Direct node connection
});

// Create wallet
const wallet = await qnet.wallet.create();

// Check balance
const balance = await qnet.getBalance('Alice123');

// Send transaction
const tx = await qnet.sendTransaction({
  from: wallet.address,
  to: 'Bob456',
  amount: 100,
  privateKey: wallet.privateKey
});

// Subscribe to new blocks
qnet.subscribe('newBlock', (block) => {
  console.log('New block:', block.height);
});
```

### What SDK Includes

1. **Libraries** for different languages:
   - JavaScript/TypeScript (for web applications)
   - Python (for scripts and bots)
   - Go (for high-performance applications)
   - Java (for Android)
   - Swift (for iOS)

2. **Documentation**:
   - API reference
   - Code examples
   - Tutorials

3. **Tools**:
   - Key generators
   - Transaction signing
   - Data encoding/decoding

### SDK Usage Examples

**1. Web Wallet**
```javascript
// Show user balance on website
const MyWallet = () => {
  const [balance, setBalance] = useState(0);
  
  useEffect(() => {
    qnet.getBalance(userAddress).then(setBalance);
  }, []);
  
  return <div>Balance: {balance} QNC</div>;
};
```

**2. Trading Bot**
```python
from qnet import SDK

qnet = SDK(network='mainnet')

# Monitor price
while True:
    price = qnet.get_price('QNC/USDT')
    if price < 0.5:
        # Buy
        qnet.send_transaction(...)
    time.sleep(60)
```

**3. Mobile Application**
```swift
// iOS app
import QNetSDK

class WalletViewController {
    func sendMoney() {
        QNet.shared.sendTransaction(
            to: recipientAddress,
            amount: 100
        ) { result in
            // Handle result
        }
    }
}
```

### Why SDK is Needed

1. **Simplifies development** - no need to know protocol details
2. **Security** - proper key handling
3. **Compatibility** - works on different platforms
4. **Ecosystem** - more apps = more users

---

## 🔗 How Everything Connects

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Sharding  │     │     CLI     │     │     SDK     │
│             │     │             │     │             │
│   Scaling   │     │    Node     │     │     App     │
│             │     │ Management  │     │Development  │
└─────────────┘     └─────────────┘     └─────────────┘
       │                    │                    │
       └────────────────────┴────────────────────┘
                            │
                     ┌──────▼──────┐
                     │    QNet     │
                     │ Blockchain  │
                     └─────────────┘
```

- **Sharding** makes the network fast (1M+ TPS)
- **CLI** allows managing nodes and wallets
- **SDK** enables building applications on QNet

All three components are critical for a successful blockchain! 