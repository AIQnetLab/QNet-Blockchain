# QNet CLI

Command line interface for QNet blockchain network.

## Installation

```bash
pip install -e .
```

## Usage

### Node Management

Start a node:
```bash
qnet-cli node start --type=light --region=auto
```

Check node status:
```bash
qnet-cli node status
```

Stop node:
```bash
qnet-cli node stop
```

### Wallet Operations

Create a new wallet:
```bash
qnet-cli wallet create
```

Check balance:
```bash
qnet-cli wallet balance
```

Send transaction:
```bash
qnet-cli wallet send <recipient_address> <amount>
```

### Rewards Management

Check unclaimed rewards:
```bash
qnet-cli rewards check
```

Claim rewards:
```bash
qnet-cli rewards claim
```

### Network Information

List connected peers:
```bash
qnet-cli network peers
```

Show network statistics:
```bash
qnet-cli network stats
```

## Configuration

The CLI stores configuration in `~/.qnet/cli_config.json`.

You can specify a custom node URL:
```bash
qnet-cli --node-url http://localhost:5000 node status
```

## Examples

### Complete Node Setup

1. Create wallet:
```bash
qnet-cli wallet create
```

2. Start node:
```bash
qnet-cli node start --type=full --region=europe
```

3. Check status:
```bash
qnet-cli node status
```

4. Monitor rewards:
```bash
qnet-cli rewards check
```

5. Claim rewards when available:
```bash
qnet-cli rewards claim
```

## Development

This CLI is currently in alpha. Many features are placeholders and will be implemented as the node API develops.

### TODO

- [ ] Actual node process management
- [ ] Real wallet key generation
- [ ] Transaction signing
- [ ] Reward claiming implementation
- [ ] Better error handling
- [ ] Progress indicators for long operations
- [ ] Configuration file validation
- [ ] Bash/Zsh completion scripts 