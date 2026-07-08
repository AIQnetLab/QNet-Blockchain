# Smart Contracts and dApps on QNet

## 🚀 Overview

QNet supports a complete ecosystem of smart contracts and decentralized applications (dApps) with unique advantages:

- **WebAssembly (WASM) Virtual Machine** - High performance and support for multiple languages
- **Mobile Optimization** - Contracts work even on smartphones
- **Post-Quantum Security** - Protection against quantum computer attacks
- **Low Fees** - Accessibility for mass adoption

## 📝 Writing Smart Contracts

### Supported Languages

QNet supports any language that compiles to WebAssembly:

- **Rust** (recommended) - Maximum performance
- **AssemblyScript** - TypeScript-like syntax
- **C/C++** - For system developers
- **Go** - Simplicity and reliability
- **Python** (via Pyodide) - For rapid prototyping

### Simple Contract Example (Rust)

```rust
use qnet_sdk::prelude::*;

#[qnet_contract]
pub struct TokenContract {
    name: String,
    symbol: String,
    total_supply: u64,
    balances: HashMap<Address, u64>,
}

#[qnet_methods]
impl TokenContract {
    #[init]
    pub fn new(name: String, symbol: String, initial_supply: u64) -> Self {
        let mut balances = HashMap::new();
        balances.insert(env::sender(), initial_supply);
        
        Self {
            name,
            symbol,
            total_supply: initial_supply,
            balances,
        }
    }
    
    pub fn transfer(&mut self, to: Address, amount: u64) -> Result<()> {
        let sender = env::sender();
        let sender_balance = self.balances.get(&sender).unwrap_or(&0);
        
        require!(*sender_balance >= amount, "Insufficient balance");
        
        self.balances.insert(sender, sender_balance - amount);
        let to_balance = self.balances.get(&to).unwrap_or(&0);
        self.balances.insert(to, to_balance + amount);
        
        emit!(Transfer {
            from: sender,
            to,
            amount
        });
        
        Ok(())
    }
    
    #[view]
    pub fn balance_of(&self, account: Address) -> u64 {
        *self.balances.get(&account).unwrap_or(&0)
    }
}
```

### AssemblyScript Example

```typescript
import { Contract, State, Address } from "@qnet/sdk-as";

@contract
export class NFTContract extends Contract {
  @state tokens: Map<u64, Address> = new Map();
  @state nextTokenId: u64 = 1;
  @state baseURI: string = "";
  
  constructor() {
    super();
  }
  
  mint(to: Address, metadata: string): u64 {
    const tokenId = this.nextTokenId;
    this.tokens.set(tokenId, to);
    this.nextTokenId++;
    
    this.emit("Mint", {
      to: to.toString(),
      tokenId: tokenId.toString(),
      metadata
    });
    
    return tokenId;
  }
  
  @view
  ownerOf(tokenId: u64): Address | null {
    return this.tokens.get(tokenId);
  }
}
```

## 🛠️ QNet SDK

### Installation

```bash
# Rust SDK
cargo add qnet-sdk

# JavaScript/TypeScript SDK
npm install @qnet/sdk

# Python SDK
pip install qnet-sdk
```

### Contract Deployment

```javascript
// JavaScript example
import { QNetClient, ContractFactory } from '@qnet/sdk';

async function deployContract() {
  // Connect to network
  const client = new QNetClient('https://rpc.qnet.network');
  
  // Load compiled WASM
  const wasm = await fs.readFile('./token_contract.wasm');
  
  // Create contract factory
  const factory = new ContractFactory(wasm, abi, client);
  
  // Deploy
  const contract = await factory.deploy({
    args: ['MyToken', 'MTK', 1000000],
    gas: 1000000,
  });
  
  console.log('Contract deployed at:', contract.address);
}
```

## 🎮 dApp Development

### dApp Architecture on QNet

```
dApp Architecture
├── Frontend (any framework)
│   ├── React/Next.js
│   ├── Vue/Nuxt
│   └── Svelte/SvelteKit
├── Smart Contracts
│   ├── Core Logic (WASM)
│   ├── Storage (on-chain)
│   └── Events
└── Backend (optional)
    ├── Indexer
    ├── IPFS Gateway
    └── API Cache
```

### React Integration Example

```jsx
import { QNetProvider, useContract, useAccount } from '@qnet/react';

function App() {
  return (
    <QNetProvider network="mainnet">
      <TokenDApp />
    </QNetProvider>
  );
}

function TokenDApp() {
  const { account, connect } = useAccount();
  const token = useContract('0x123...', TokenABI);
  
  const [balance, setBalance] = useState('0');
  
  useEffect(() => {
    if (account && token) {
      token.balanceOf(account).then(setBalance);
    }
  }, [account, token]);
  
  async function transfer() {
    const tx = await token.transfer(recipientAddress, amount);
    await tx.wait();
    console.log('Transfer complete!');
  }
  
  return (
    <div>
      {!account ? (
        <button onClick={connect}>Connect Wallet</button>
      ) : (
        <div>
          <p>Balance: {balance} tokens</p>
          <button onClick={transfer}>Send Tokens</button>
        </div>
      )}
    </div>
  );
}
```

## 📱 Mobile Development

### React Native SDK

```javascript
import { QNetMobile } from '@qnet/mobile-sdk';

// Initialize for mobile devices
const qnet = new QNetMobile({
  // Automatic battery optimization
  powerMode: 'balanced',
  // Caching for offline work
  enableCache: true,
});

// Contract interaction same as web
const contract = qnet.contract(address, abi);
```

### Flutter SDK

```dart
import 'package:qnet_sdk/qnet_sdk.dart';

class MyDApp extends StatefulWidget {
  @override
  _MyDAppState createState() => _MyDAppState();
}

class _MyDAppState extends State<MyDApp> {
  final qnet = QNetClient();
  
  Future<void> interactWithContract() async {
    final contract = await qnet.getContract(
      address: '0x123...',
      abi: contractAbi,
    );
    
    final result = await contract.call('balanceOf', [userAddress]);
    setState(() {
      balance = result.toString();
    });
  }
}
```

## 🔧 Developer Tools

### QNet Studio (IDE)

Browser-based IDE for smart contract development:
- Syntax highlighting for Rust/AssemblyScript
- Built-in WASM compiler
- Contract debugger
- One-click testnet

### CLI Tools

```bash
# Create new project
qnet init my-dapp

# Compile contracts
qnet compile

# Local testnet
qnet node --dev

# Deploy
qnet deploy --network mainnet

# Verify contract
qnet verify 0x123... ./src/contract.rs
```

### Testing

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use qnet_sdk::testing::*;
    
    #[test]
    fn test_transfer() {
        let mut contract = TokenContract::new(
            "Test".to_string(),
            "TST".to_string(),
            1000
        );
        
        // Set context
        testing::set_caller(alice());
        
        // Execute transfer
        contract.transfer(bob(), 100).unwrap();
        
        // Check balances
        assert_eq!(contract.balance_of(alice()), 900);
        assert_eq!(contract.balance_of(bob()), 100);
    }
}
```

## 💰 Gas Economics

### Cost Calculation

- Basic operation: 1 gas
- Storage read: 100 gas
- Storage write: 1000 gas
- Contract creation: 10000 gas + code size

### Gas Optimization

```rust
// ❌ Inefficient
for i in 0..users.len() {
    balances.insert(users[i], amount);
}

// ✅ Efficient - batch operation
let updates: Vec<(Address, u64)> = users
    .iter()
    .map(|user| (*user, amount))
    .collect();
balances.batch_insert(updates);
```

## 🌐 Ecosystem

### Ready Solutions

1. **QNet DEX** - Decentralized exchange
2. **QNet Names** - Domain name system
3. **QNet Storage** - Decentralized storage
4. **QNet Oracle** - External data oracles
5. **QNet Bridge** - Cross-chain bridges

### Contract Marketplace

Developers can publish and monetize their contracts:
- Audited templates
- Business-ready solutions
- Composable modules

## 🎓 Learning

### Documentation
- [Complete Guide](https://docs.qnet.network)
- [Contract Examples](https://github.com/qnet/examples)
- [Video Tutorials](https://youtube.com/qnet)

### Community
- Discord: https://discord.gg/qnet-dev
- Forum: https://forum.qnet.network
- Stack Overflow: tag `qnet`

## 🚀 Why QNet for dApps?

1. **Speed**: ~50,000 TPS on a single shard thanks to WASM and Rust
2. **Scalability**: Single-shard today (sharding is deferred by design and off; a future option)
3. **Mobility**: Works on any device
4. **Security**: Post-quantum cryptography (pure ML-DSA-65 signatures)
5. **Simplicity**: Familiar languages and tools
6. **Community**: Active developer support

---

**Start building the future of Web3 on QNet today!** 