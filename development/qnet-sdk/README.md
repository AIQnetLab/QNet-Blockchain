# @qnet/sdk

TypeScript/JavaScript SDK for the **QNet Post-Quantum Blockchain**.

---

## Installation

```bash
npm install @qnet/sdk
# or
yarn add @qnet/sdk
```

---

## Quick start

```typescript
import { QNetClient, formatQNC, isValidQNetAddress } from '@qnet/sdk';

const client = new QNetClient({
  endpoint:  'http://154.38.160.39:9876',  // any genesis node
  timeoutMs: 15_000,
});

// Latest block
const block = await client.getLatestBlock();
console.log(`Height: ${block.height}, producer: ${block.producer}`);

// Balance
const account = await client.getBalance('YOUR_QNET_ADDRESS');
console.log(formatQNC(account.balance)); // e.g. "42.5 QNC"

// Send QNC
import { buildUnsignedTransfer } from '@qnet/sdk';

const tx = buildUnsignedTransfer({
  from:  'SENDER_ADDRESS',
  to:    'RECIPIENT_ADDRESS',
  value: '1000000000',  // 1 QNC
  nonce: 5,
});

const mySignature = myDilithiumKey.sign(Buffer.from(tx.signingPayload, 'hex'));
await client.sendTransaction({ ...tx, signature: mySignature.toString('hex') });
```

---

## API reference

### `QNetClient`

| Method | Description |
|--------|-------------|
| `getLatestBlock()` | Latest finalized microblock |
| `getBlock(height)` | Block by height (micro or macro) |
| `getBlocks(from, to)` | Range of blocks (max 100) |
| `getTransaction(hash)` | Transaction by hash |
| `sendTransaction(params)` | Broadcast a signed transaction |
| `getAddressTransactions(addr, limit, offset)` | Recent txs for an address |
| `getBalance(address)` | QNC balance + metadata |
| `getBalanceFormatted(address)` | Human-readable balance string |
| `getPendingRewards(address)` | Unclaimed rewards |
| `claimRewards(address, signature)` | Claim pending rewards |
| `requestFaucetTokens(walletAddress)` | Get 1500 1DEV + 0.001 SOL (testnet) |
| `deployContract(params)` | Deploy a PQ-EVM contract |
| `callContract(params)` | Read-only contract call |
| `sendContractCall(params)` | State-mutating contract call |
| `getContractLogs(addr, from, to)` | Contract event logs |
| `getNodeStatus()` | Node version, height, peer count |
| `getNetworkStats()` | TPS, active nodes, epoch |

---

### Address utilities

```typescript
import { isValidQNetAddress, publicKeyHashToAddress, formatQNC, parseQNC } from '@qnet/sdk';

// Derive address from public key hash (first 20 bytes of SHA3-256(pubkey))
const address = publicKeyHashToAddress(pubKeyHash);

// Validate
isValidQNetAddress(address); // → true

// Format amounts
formatQNC('1500000000');  // → "1.5 QNC"
parseQNC('1.5 QNC');      // → 1_500_000_000n
```

---

### Contract interaction

```typescript
import { QNetClient, ContractHandle, encodeCalldata, decodeUint64 } from '@qnet/sdk';

const client   = new QNetClient({ endpoint: 'http://154.38.160.39:9876' });
const token    = new ContractHandle(client, 'CONTRACT_ADDRESS');

// Read balance (selector 4 = balance_of)
const result   = await token.call({
  calldata: encodeCalldata(4, [{ type: 'address', value: myAddress }]),
  from:     myAddress,
});
const balance  = decodeUint64(result.returnData);

// Transfer (selector 1 = transfer)
await token.send({
  calldata:  encodeCalldata(1, [
    { type: 'address', value: recipientAddress },
    { type: 'uint64',  value: 500_000_000n },
  ]),
  from:      myAddress,
  signature: myDilithiumSig,
});
```

---

### Real-time subscriptions

```typescript
import { QNetSubscription } from '@qnet/sdk';

const sub = new QNetSubscription(client, { pollIntervalMs: 1000 });

sub
  .onBlock(b  => console.log('Block:', b.height))
  .onMacroBlock(mb => console.log('Epoch:', mb.epoch))
  .onAddressTransaction(myAddress, tx => console.log('Tx:', tx.hash))
  .onError(err => console.error(err))
  .start();

// Stop when done
sub.stop();
```

---

### Polling helpers

```typescript
import { pollBlocks, waitForHeight, waitForTransaction } from '@qnet/sdk';

// Functional poll
const stop = pollBlocks(client, block => {
  console.log('New block:', block.height);
}, { macroBlockOnly: true });

// Await a specific height
const macroBlock = await waitForHeight(client, 28800);

// Await transaction confirmation
const tx = await waitForTransaction(client, txHash, { confirmations: 3 });
```

---

## Error handling

All errors extend `QNetError` for structured handling:

```typescript
import { QNetApiError, QNetTransactionError, QNetAddressError } from '@qnet/sdk';

try {
  await client.sendTransaction(params);
} catch (err) {
  if (err instanceof QNetTransactionError) {
    console.error('Rejected:', err.message, 'txHash:', err.txHash);
  } else if (err instanceof QNetApiError) {
    console.error('HTTP', err.httpStatus, err.message);
  }
}
```

---

## Building & testing

```bash
# Install dependencies
npm install

# Run tests
npm test

# Build (CommonJS + ESM + .d.ts)
npm run build
```

---

## Key differences from Ethereum / web3.js

| Feature | Ethereum / web3.js | @qnet/sdk |
|---------|--------------------|-----------|
| Signature | ECDSA secp256k1 | Dilithium3 / ML-DSA-65 (NIST FIPS 204 L3) |
| Address | `0x` 20-byte hex | EON format (25 bytes + checksum) |
| Block time | ~12 s | ~1 s (microblock) |
| Finality | ~2 min | MacroBlock ~90 s |
| Custom opcodes | — | `PQ_SIGN`, `PQ_VERIFY`, `PQ_ENCRYPT` |
| Polling | WebSocket + HTTP | HTTP polling (WebSocket: v2 roadmap) |
