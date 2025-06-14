# QNet Mobile SDK

## Overview

The QNet Mobile SDK enables mobile applications to participate in the QNet blockchain network as full mining nodes. It's optimized for battery life, data usage, and mobile-specific constraints while maintaining full blockchain functionality.

## Supported Platforms

- **iOS**: 13.0+ (Swift 5.5+)
- **Android**: API 24+ (Android 7.0+)
- **React Native**: 0.70+
- **Flutter**: 3.0+

## Architecture

```
Mobile SDK Architecture
├── Core (Rust)
│   ├── Blockchain Engine
│   ├── Networking Layer
│   ├── Crypto Operations
│   └── Storage Manager
├── Platform Bindings
│   ├── iOS (Swift)
│   ├── Android (Kotlin/Java)
│   ├── React Native (JS)
│   └── Flutter (Dart)
├── Battery Manager
│   ├── Power Profiles
│   ├── Adaptive Mining
│   └── Background Tasks
└── Data Optimizer
    ├── Compression
    ├── Selective Sync
    └── Caching
```

## Key Features

### 1. Battery Optimization

```swift
// iOS Example
class QNetBatteryManager {
    enum PowerMode {
        case highPerformance    // Plugged in, full mining
        case balanced          // Normal battery, adaptive mining
        case powerSaver        // Low battery, minimal activity
        case ultraLowPower     // Critical battery, sync only
    }
    
    func configurePowerMode() -> PowerMode {
        let batteryLevel = UIDevice.current.batteryLevel
        let batteryState = UIDevice.current.batteryState
        
        switch (batteryState, batteryLevel) {
        case (.charging, _), (.full, _):
            return .highPerformance
        case (.unplugged, let level) where level > 0.5:
            return .balanced
        case (.unplugged, let level) where level > 0.2:
            return .powerSaver
        default:
            return .ultraLowPower
        }
    }
}
```

### 2. Background Mining

```kotlin
// Android Example
class QNetMiningService : Service() {
    private lateinit var wakeLock: PowerManager.WakeLock
    private lateinit var wifiLock: WifiManager.WifiLock
    
    override fun onCreate() {
        super.onCreate()
        
        // Acquire partial wake lock for mining
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = powerManager.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "QNet:MiningWakeLock"
        )
        
        // Keep WiFi active
        val wifiManager = getSystemService(Context.WIFI_SERVICE) as WifiManager
        wifiLock = wifiManager.createWifiLock(
            WifiManager.WIFI_MODE_FULL_HIGH_PERF,
            "QNet:WifiLock"
        )
    }
    
    private fun startAdaptiveMining() {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.UNMETERED)
            .setRequiresBatteryNotLow(true)
            .setRequiresCharging(false)
            .build()
            
        val miningWork = PeriodicWorkRequestBuilder<MiningWorker>(
            15, TimeUnit.MINUTES
        ).setConstraints(constraints).build()
        
        WorkManager.getInstance(this).enqueue(miningWork)
    }
}
```

### 3. Data Usage Optimization

```typescript
// React Native Example
class QNetDataOptimizer {
  private dataUsage: DataUsageTracker;
  private syncStrategy: SyncStrategy;
  
  async configureSyncMode(): Promise<SyncMode> {
    const networkInfo = await NetInfo.fetch();
    const dataUsage = await this.dataUsage.getMonthlyUsage();
    
    if (networkInfo.type === 'wifi') {
      return SyncMode.Full;
    } else if (networkInfo.type === 'cellular') {
      if (dataUsage < 100 * 1024 * 1024) { // < 100MB
        return SyncMode.HeadersOnly;
      } else {
        return SyncMode.Minimal;
      }
    }
    
    return SyncMode.Offline;
  }
  
  async compressTransaction(tx: Transaction): Promise<Buffer> {
    // Use zstd compression for transactions
    return await zstd.compress(tx.serialize(), 3);
  }
}
```

### 4. Secure Key Storage

```swift
// iOS Keychain Integration
class QNetKeyManager {
    private let keychain = KeychainWrapper.standard
    
    func generateAndStoreKeys() throws -> KeyPair {
        // Generate post-quantum keys
        let keyPair = try QNetCrypto.generateKeyPair()
        
        // Store in iOS Keychain with biometric protection
        let accessControl = SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            [.biometryCurrentSet, .privateKeyUsage],
            nil
        )
        
        keychain.set(
            keyPair.privateKey,
            forKey: "qnet_private_key",
            withAccessibility: .whenUnlockedThisDeviceOnly,
            accessControl: accessControl
        )
        
        return keyPair
    }
}
```

### 5. Push Notifications

```kotlin
// Android FCM Integration
class QNetNotificationService : FirebaseMessagingService() {
    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        when (remoteMessage.data["type"]) {
            "incoming_payment" -> handleIncomingPayment(remoteMessage.data)
            "mining_reward" -> handleMiningReward(remoteMessage.data)
            "network_alert" -> handleNetworkAlert(remoteMessage.data)
        }
    }
    
    private fun handleIncomingPayment(data: Map<String, String>) {
        val amount = data["amount"] ?: "0"
        val from = data["from"] ?: "Unknown"
        
        showNotification(
            "Payment Received",
            "You received $amount QNC from $from",
            NotificationImportance.HIGH
        )
    }
}
```

## API Reference

### Core Classes

#### QNetNode

```typescript
interface QNetNode {
  // Lifecycle
  start(config: NodeConfig): Promise<void>;
  stop(): Promise<void>;
  
  // Mining
  startMining(): Promise<void>;
  stopMining(): Promise<void>;
  getMiningStats(): Promise<MiningStats>;
  
  // Transactions
  sendTransaction(tx: Transaction): Promise<TransactionHash>;
  getTransaction(hash: string): Promise<Transaction>;
  
  // Blockchain
  getBlockHeight(): Promise<number>;
  getBlock(height: number): Promise<Block>;
  
  // Account
  getBalance(address?: string): Promise<Balance>;
  getAddress(): string;
}
```

#### NodeConfig

```typescript
interface NodeConfig {
  // Network
  network: 'mainnet' | 'testnet' | 'devnet';
  nodeType: 'light' | 'full' | 'super';
  
  // Performance
  maxConnections: number;
  maxMemoryMB: number;
  maxCPUPercent: number;
  
  // Battery
  powerMode: PowerMode;
  miningEnabled: boolean;
  backgroundSync: boolean;
  
  // Storage
  dataDirectory: string;
  maxStorageMB: number;
  pruneAfterDays: number;
}
```

## Platform-Specific Implementation

### iOS (Swift)

```swift
import QNetSDK

class ViewController: UIViewController {
    private var node: QNetNode?
    
    override func viewDidLoad() {
        super.viewDidLoad()
        setupNode()
    }
    
    private func setupNode() {
        let config = NodeConfig(
            network: .mainnet,
            nodeType: .light,
            powerMode: .balanced
        )
        
        node = QNetNode(config: config)
        
        Task {
            try await node?.start()
            
            // Start mining if conditions are met
            if await shouldStartMining() {
                try await node?.startMining()
            }
        }
    }
    
    private func shouldStartMining() async -> Bool {
        let batteryLevel = UIDevice.current.batteryLevel
        let isCharging = UIDevice.current.batteryState == .charging
        
        return batteryLevel > 0.3 || isCharging
    }
}
```

### Android (Kotlin)

```kotlin
class MainActivity : AppCompatActivity() {
    private lateinit var node: QNetNode
    
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        
        setupNode()
    }
    
    private fun setupNode() {
        val config = NodeConfig(
            network = Network.MAINNET,
            nodeType = NodeType.LIGHT,
            powerMode = PowerMode.BALANCED
        )
        
        node = QNetNode(this, config)
        
        lifecycleScope.launch {
            node.start()
            
            if (shouldStartMining()) {
                node.startMining()
            }
        }
    }
    
    private fun shouldStartMining(): Boolean {
        val batteryManager = getSystemService(BATTERY_SERVICE) as BatteryManager
        val batteryLevel = batteryManager.getIntProperty(
            BatteryManager.BATTERY_PROPERTY_CAPACITY
        )
        
        return batteryLevel > 30
    }
}
```

### React Native

```javascript
import QNetSDK from '@qnet/react-native-sdk';

export default function App() {
  const [node, setNode] = useState(null);
  const [balance, setBalance] = useState('0');
  
  useEffect(() => {
    initializeNode();
  }, []);
  
  const initializeNode = async () => {
    const config = {
      network: 'mainnet',
      nodeType: 'light',
      powerMode: 'balanced',
    };
    
    const qnetNode = new QNetSDK.Node(config);
    await qnetNode.start();
    
    setNode(qnetNode);
    
    // Update balance
    const bal = await qnetNode.getBalance();
    setBalance(bal.toString());
  };
  
  const sendPayment = async (to, amount) => {
    if (!node) return;
    
    const tx = await node.createTransaction({
      to,
      amount,
      fee: 'auto',
    });
    
    const hash = await node.sendTransaction(tx);
    console.log('Transaction sent:', hash);
  };
  
  return (
    <View style={styles.container}>
      <Text>Balance: {balance} QNC</Text>
      <Button title="Send Payment" onPress={() => sendPayment('...', 100)} />
    </View>
  );
}
```

### Flutter

```dart
import 'package:qnet_sdk/qnet_sdk.dart';

class MyApp extends StatefulWidget {
  @override
  _MyAppState createState() => _MyAppState();
}

class _MyAppState extends State<MyApp> {
  late QNetNode node;
  String balance = '0';
  
  @override
  void initState() {
    super.initState();
    initializeNode();
  }
  
  Future<void> initializeNode() async {
    final config = NodeConfig(
      network: Network.mainnet,
      nodeType: NodeType.light,
      powerMode: PowerMode.balanced,
    );
    
    node = QNetNode(config);
    await node.start();
    
    final bal = await node.getBalance();
    setState(() {
      balance = bal.toString();
    });
  }
  
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      home: Scaffold(
        appBar: AppBar(title: Text('QNet Wallet')),
        body: Center(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Text('Balance: $balance QNC'),
              ElevatedButton(
                onPressed: () => sendPayment(),
                child: Text('Send Payment'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
```

## Performance Guidelines

### Memory Usage
- Light Node: 50-100 MB
- Full Node: 200-500 MB
- Super Node: 1-2 GB

### Battery Impact
- Active Mining: 2-3% per hour
- Passive Sync: 0.5-1% per hour
- Idle: < 0.1% per hour

### Data Usage
- Initial Sync: 100-500 MB
- Daily Usage: 5-50 MB
- Monthly Average: 500 MB - 2 GB

## Security Best Practices

1. **Key Storage**: Always use platform-specific secure storage (Keychain/Keystore)
2. **Biometric Auth**: Enable biometric authentication for transactions
3. **Network Security**: Use certificate pinning for API calls
4. **Code Obfuscation**: Enable ProGuard/R8 (Android) or Swift obfuscation (iOS)
5. **Jailbreak Detection**: Implement runtime application self-protection (RASP)

## Troubleshooting

### Common Issues

1. **High Battery Drain**
   - Check power mode settings
   - Disable mining on battery
   - Reduce sync frequency

2. **Sync Failures**
   - Verify network connectivity
   - Check firewall settings
   - Try different bootstrap nodes

3. **Transaction Errors**
   - Ensure sufficient balance
   - Check network congestion
   - Verify recipient address

---

**QNet Mobile SDK - Bringing blockchain to billions of mobile devices** 