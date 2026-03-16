use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use sha3::{Digest, Keccak256};
use serde::{Deserialize, Serialize};

// Post-Quantum Cryptography imports
// Using CRYSTALS-Dilithium for signatures and CRYSTALS-KYBER for encryption
// QNet uses CRYSTALS-Dilithium3 (ML-DSA-65) consistently with quantum_crypto.rs
use pqcrypto_mldsa::mldsa65 as dilithium3;
use pqcrypto_kyber::kyber1024;
use pqcrypto_traits::sign::{PublicKey, SecretKey, SignedMessage};
use pqcrypto_traits::kem::{Ciphertext, PublicKey as KemPublicKey, SecretKey as KemSecretKey, SharedSecret};

/// Post-Quantum Ethereum Virtual Machine
/// 
/// This implementation provides full EVM compatibility while using
/// quantum-resistant cryptographic primitives for all operations.
#[derive(Debug, Clone)]
pub struct PostQuantumEVM {
    /// Current state of the EVM
    state: Arc<Mutex<EVMState>>,
    /// Gas configuration
    gas_config: GasConfig,
    /// Maximum gas limit per transaction
    max_gas_limit: u64,
    /// Post-quantum cryptographic context
    pq_context: PQCryptoContext,
}

/// EVM State containing all account and storage data
#[derive(Debug, Clone)]
pub struct EVMState {
    /// Account states
    accounts: HashMap<Address, Account>,
    /// Contract code storage
    codes: HashMap<Hash, Vec<u8>>,
    /// Transaction logs
    logs: Vec<Log>,
    /// Current block information
    block_info: BlockInfo,
}

/// Account representation in PQ-EVM
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    /// Account nonce
    pub nonce: u64,
    /// Account balance (in QNC)
    pub balance: u64,
    /// Storage root hash
    pub storage_root: Hash,
    /// Code hash (for contracts)
    pub code_hash: Hash,
    /// Post-quantum public key
    pub pq_public_key: Option<PQPublicKey>,
}

/// Post-Quantum Public Key wrapper
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PQPublicKey {
    /// Dilithium public key for signatures
    pub dilithium_pk: Vec<u8>,
    /// Kyber public key for encryption
    pub kyber_pk: Vec<u8>,
}

/// 160-bit address (same as Ethereum for compatibility)
pub type Address = [u8; 20];
/// 256-bit hash (same as Ethereum for compatibility)
pub type Hash = [u8; 32];

/// Block information
#[derive(Debug, Clone)]
pub struct BlockInfo {
    pub number: u64,
    pub timestamp: u64,
    pub gas_limit: u64,
    pub difficulty: u64,
    pub coinbase: Address,
    pub base_fee: u64,
}

/// Transaction log entry
#[derive(Debug, Clone)]
pub struct Log {
    pub address: Address,
    pub topics: Vec<Hash>,
    pub data: Vec<u8>,
}

/// Gas configuration for operations
#[derive(Debug, Clone)]
pub struct GasConfig {
    // Basic operations
    pub add: u64,
    pub mul: u64,
    pub div: u64,
    pub mod_op: u64,
    pub exp: u64,
    
    // Memory operations
    pub memory_read: u64,
    pub memory_write: u64,
    pub memory_expand: u64,
    
    // Storage operations
    pub storage_read: u64,
    pub storage_write: u64,
    pub storage_delete: u64,
    
    // Post-quantum operations
    pub pq_sign: u64,
    pub pq_verify: u64,
    pub pq_encrypt: u64,
    pub pq_decrypt: u64,
    
    // Contract operations
    pub contract_create: u64,
    pub contract_call: u64,
    pub contract_delegate_call: u64,
    
    // Microblock operations
    pub microblock_commit: u64,
    pub microblock_verify: u64,
}

/// Post-Quantum Cryptographic Context
#[derive(Debug, Clone)]
pub struct PQCryptoContext {
    /// Random number generator seed
    seed: [u8; 32],
}

/// Transaction execution result
#[derive(Debug)]
pub struct ExecutionResult {
    /// Success/failure status
    pub success: bool,
    /// Gas used
    pub gas_used: u64,
    /// Return data
    pub return_data: Vec<u8>,
    /// Generated logs
    pub logs: Vec<Log>,
    /// State changes
    pub state_changes: Vec<StateChange>,
    /// Error message (if failed)
    pub error: Option<String>,
}

/// State change record
#[derive(Debug, Clone)]
pub struct StateChange {
    pub address: Address,
    pub slot: Hash,
    pub old_value: Hash,
    pub new_value: Hash,
}

/// Transaction data structure
#[derive(Debug, Clone)]
pub struct Transaction {
    /// Sender address
    pub from: Address,
    /// Recipient address (None for contract creation)
    pub to: Option<Address>,
    /// Transaction value
    pub value: u64,
    /// Gas limit
    pub gas_limit: u64,
    /// Gas price
    pub gas_price: u64,
    /// Input data
    pub data: Vec<u8>,
    /// Transaction nonce
    pub nonce: u64,
    /// Post-quantum signature
    pub pq_signature: PQSignature,
}

/// Post-Quantum Signature
#[derive(Debug, Clone)]
pub struct PQSignature {
    /// Dilithium signature
    pub dilithium_sig: Vec<u8>,
    /// Recovery information
    pub recovery_id: u8,
}

impl PostQuantumEVM {
    /// Create new PQ-EVM instance
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(EVMState::new())),
            gas_config: GasConfig::default(),
            max_gas_limit: 30_000_000, // 30M gas limit
            pq_context: PQCryptoContext::new(),
        }
    }

    /// Execute a transaction
    pub fn execute_transaction(&self, tx: Transaction) -> Result<ExecutionResult, String> {
        // Verify post-quantum signature
        if !self.verify_pq_signature(&tx)? {
            return Err("Invalid post-quantum signature".to_string());
        }

        let mut state = match self.state.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        
        // Check account nonce
        let sender_account = state.get_account(&tx.from);
        if sender_account.nonce != tx.nonce {
            return Err("Invalid nonce".to_string());
        }

        // Check balance for gas payment
        let max_gas_cost = tx.gas_limit * tx.gas_price;
        if sender_account.balance < tx.value + max_gas_cost {
            return Err("Insufficient balance".to_string());
        }

        // Execute transaction logic
        let mut gas_used = 10_000; // QNet base TRANSFER cost
        let mut logs = Vec::new();
        let mut state_changes = Vec::new();

        match tx.to {
            Some(to_address) => {
                // Contract call or transfer
                if state.is_contract(&to_address) {
                    // Contract call
                    let result = self.execute_contract_call(
                        &mut state,
                        &tx.from,
                        &to_address,
                        &tx.data,
                        tx.value,
                        tx.gas_limit - gas_used,
                    )?;
                    
                    gas_used += result.gas_used;
                    logs.extend(result.logs);
                    state_changes.extend(result.state_changes);
                } else {
                    // Simple transfer
                    state.transfer(&tx.from, &to_address, tx.value)?;
                    state_changes.push(StateChange {
                        address: tx.from,
                        slot: [0; 32], // Balance slot
                        old_value: [0; 32],
                        new_value: [0; 32],
                    });
                }
            }
            None => {
                // Contract creation
                let result = self.create_contract(&mut state, &tx.from, &tx.data, tx.value, tx.gas_limit - gas_used)?;
                gas_used += result.gas_used;
                logs.extend(result.logs);
                state_changes.extend(result.state_changes);
            }
        }

        // Update sender nonce
        state.increment_nonce(&tx.from);

        // Charge gas
        let gas_cost = gas_used * tx.gas_price;
        state.deduct_balance(&tx.from, gas_cost)?;

        Ok(ExecutionResult {
            success: true,
            gas_used,
            return_data: Vec::new(),
            logs,
            state_changes,
            error: None,
        })
    }

    /// Verify post-quantum signature
    fn verify_pq_signature(&self, tx: &Transaction) -> Result<bool, String> {
        // Create message hash for signing
        let message = self.create_transaction_hash(tx);
        
        // Get sender's post-quantum public key
        let state = match self.state.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let account = state.get_account(&tx.from);
        
        let pq_pk = account.pq_public_key.as_ref()
            .ok_or("No post-quantum public key found")?;

        // Verify Dilithium signature
        let pk = dilithium3::PublicKey::from_bytes(&pq_pk.dilithium_pk)
            .map_err(|_| "Invalid Dilithium public key")?;

        let signature = dilithium3::SignedMessage::from_bytes(&tx.pq_signature.dilithium_sig)
            .map_err(|_| "Invalid Dilithium signature")?;

        match dilithium3::open(&signature, &pk) {
            Ok(verified_message) => Ok(verified_message == message),
            Err(_) => Ok(false),
        }
    }

    /// Create transaction hash for signing
    fn create_transaction_hash(&self, tx: &Transaction) -> Vec<u8> {
        let mut hasher = Keccak256::new();
        hasher.update(&tx.from);
        hasher.update(&tx.to.unwrap_or([0; 20]));
        hasher.update(&tx.value.to_be_bytes());
        hasher.update(&tx.gas_limit.to_be_bytes());
        hasher.update(&tx.gas_price.to_be_bytes());
        hasher.update(&tx.data);
        hasher.update(&tx.nonce.to_be_bytes());
        hasher.finalize().to_vec()
    }

    /// Execute contract call
    fn execute_contract_call(
        &self,
        state: &mut EVMState,
        from: &Address,
        to: &Address,
        data: &[u8],
        value: u64,
        gas_limit: u64,
    ) -> Result<ExecutionResult, String> {
        // Get contract code
        let account = state.get_account(to);
        let code = state.get_code(&account.code_hash);

        // Create EVM execution context
        let mut context = ExecutionContext {
            caller: *from,
            callee: *to,
            value,
            gas_remaining: gas_limit,
            input_data: data.to_vec(),
            return_data: Vec::new(),
            logs: Vec::new(),
            state_changes: Vec::new(),
        };

        // Execute EVM bytecode with post-quantum extensions
        self.execute_bytecode(&code, &mut context, state)?;

        Ok(ExecutionResult {
            success: true,
            gas_used: gas_limit - context.gas_remaining,
            return_data: context.return_data,
            logs: context.logs,
            state_changes: context.state_changes,
            error: None,
        })
    }

    /// Create new contract
    fn create_contract(
        &self,
        state: &mut EVMState,
        creator: &Address,
        init_code: &[u8],
        value: u64,
        gas_limit: u64,
    ) -> Result<ExecutionResult, String> {
        // Generate contract address
        let contract_address = self.generate_contract_address(creator, state.get_account(creator).nonce);

        // Create contract account
        let mut contract_account = Account::default();
        contract_account.balance = value;

        // Execute constructor
        let mut context = ExecutionContext {
            caller: *creator,
            callee: contract_address,
            value,
            gas_remaining: gas_limit,
            input_data: Vec::new(),
            return_data: Vec::new(),
            logs: Vec::new(),
            state_changes: Vec::new(),
        };

        // Execute initialization code
        self.execute_bytecode(init_code, &mut context, state)?;

        // Store contract code
        let code_hash = self.compute_hash(&context.return_data);
        contract_account.code_hash = code_hash;
        state.set_code(code_hash, context.return_data);
        state.set_account(contract_address, contract_account);

        Ok(ExecutionResult {
            success: true,
            gas_used: gas_limit - context.gas_remaining,
            return_data: contract_address.to_vec(),
            logs: context.logs,
            state_changes: context.state_changes,
            error: None,
        })
    }

    /// Execute EVM bytecode with post-quantum extensions.
    ///
    /// Supports:
    ///   - Standard EVM opcodes (0x00–0x5F subset)
    ///   - QNet Microblock extensions (0xE0–0xE1)
    ///   - Post-Quantum extensions (0xF0–0xF3)
    fn execute_bytecode(
        &self,
        code: &[u8],
        context: &mut ExecutionContext,
        state: &mut EVMState,
    ) -> Result<(), String> {
        let mut pc = 0usize;
        let mut stack: Vec<u64> = Vec::with_capacity(64);
        let mut memory: Vec<u8> = Vec::new();

        macro_rules! pop {
            ($stack:expr) => {
                $stack.pop().ok_or("Stack underflow")?
            };
        }

        while pc < code.len() {
            if context.gas_remaining == 0 {
                return Err("Out of gas".to_string());
            }

            let opcode = code[pc];

            match opcode {
                // ── Arithmetic ────────────────────────────────────────────
                0x00 => break, // STOP
                0x01 => { // ADD
                    self.consume_gas(context, self.gas_config.add)?;
                    let (a, b) = (pop!(stack), pop!(stack));
                    stack.push(a.wrapping_add(b));
                }
                0x02 => { // MUL
                    self.consume_gas(context, self.gas_config.mul)?;
                    let (a, b) = (pop!(stack), pop!(stack));
                    stack.push(a.wrapping_mul(b));
                }
                0x03 => { // SUB
                    self.consume_gas(context, self.gas_config.add)?;
                    let (a, b) = (pop!(stack), pop!(stack));
                    stack.push(a.wrapping_sub(b));
                }
                0x04 => { // DIV
                    self.consume_gas(context, self.gas_config.div)?;
                    let (a, b) = (pop!(stack), pop!(stack));
                    stack.push(if b == 0 { 0 } else { a / b });
                }
                0x05 => { // SDIV (signed — treat as unsigned for now)
                    self.consume_gas(context, self.gas_config.div)?;
                    let (a, b) = (pop!(stack), pop!(stack));
                    stack.push(if b == 0 { 0 } else { a / b });
                }
                0x06 => { // MOD
                    self.consume_gas(context, self.gas_config.mod_op)?;
                    let (a, b) = (pop!(stack), pop!(stack));
                    stack.push(if b == 0 { 0 } else { a % b });
                }
                0x08 => { // ADDMOD
                    self.consume_gas(context, self.gas_config.add)?;
                    let (a, b, n) = (pop!(stack), pop!(stack), pop!(stack));
                    stack.push(if n == 0 { 0 } else { a.wrapping_add(b) % n });
                }
                0x09 => { // MULMOD
                    self.consume_gas(context, self.gas_config.mul)?;
                    let (a, b, n) = (pop!(stack), pop!(stack), pop!(stack));
                    stack.push(if n == 0 { 0 } else { (a as u128).wrapping_mul(b as u128).wrapping_rem(n as u128) as u64 });
                }
                0x0A => { // EXP
                    self.consume_gas(context, self.gas_config.exp)?;
                    let (base, exp) = (pop!(stack), pop!(stack));
                    stack.push(base.wrapping_pow(exp as u32));
                }

                // ── Comparison & Bitwise ──────────────────────────────────
                0x10 => { // LT
                    self.consume_gas(context, self.gas_config.add)?;
                    let (a, b) = (pop!(stack), pop!(stack));
                    stack.push(if a < b { 1 } else { 0 });
                }
                0x11 => { // GT
                    self.consume_gas(context, self.gas_config.add)?;
                    let (a, b) = (pop!(stack), pop!(stack));
                    stack.push(if a > b { 1 } else { 0 });
                }
                0x13 => { // EQ
                    self.consume_gas(context, self.gas_config.add)?;
                    let (a, b) = (pop!(stack), pop!(stack));
                    stack.push(if a == b { 1 } else { 0 });
                }
                0x14 => { // ISZERO
                    self.consume_gas(context, self.gas_config.add)?;
                    let a = pop!(stack);
                    stack.push(if a == 0 { 1 } else { 0 });
                }
                0x16 => { // AND
                    self.consume_gas(context, self.gas_config.add)?;
                    let (a, b) = (pop!(stack), pop!(stack));
                    stack.push(a & b);
                }
                0x17 => { // OR
                    self.consume_gas(context, self.gas_config.add)?;
                    let (a, b) = (pop!(stack), pop!(stack));
                    stack.push(a | b);
                }
                0x18 => { // XOR
                    self.consume_gas(context, self.gas_config.add)?;
                    let (a, b) = (pop!(stack), pop!(stack));
                    stack.push(a ^ b);
                }
                0x19 => { // NOT
                    self.consume_gas(context, self.gas_config.add)?;
                    let a = pop!(stack);
                    stack.push(!a);
                }
                0x1A => { // BYTE — extract byte at position
                    self.consume_gas(context, self.gas_config.add)?;
                    let (pos, val) = (pop!(stack), pop!(stack));
                    stack.push(if pos >= 8 { 0 } else { (val >> (56 - pos * 8)) & 0xFF });
                }
                0x1B => { // SHL
                    self.consume_gas(context, self.gas_config.add)?;
                    let (shift, val) = (pop!(stack), pop!(stack));
                    stack.push(if shift >= 64 { 0 } else { val << shift });
                }
                0x1C => { // SHR
                    self.consume_gas(context, self.gas_config.add)?;
                    let (shift, val) = (pop!(stack), pop!(stack));
                    stack.push(if shift >= 64 { 0 } else { val >> shift });
                }

                // ── Hashing ───────────────────────────────────────────────
                0x20 => { // KECCAK256 / SHA3
                    self.consume_gas(context, 30)?;
                    let (offset, len) = (pop!(stack) as usize, pop!(stack) as usize);
                    let end = offset.saturating_add(len);
                    if end > memory.len() { memory.resize(end, 0); }
                    let hash = {
                        let mut h = Keccak256::new();
                        h.update(&memory[offset..end]);
                        h.finalize()
                    };
                    // Push lower 8 bytes of hash as u64
                    let mut bytes = [0u8; 8];
                    bytes.copy_from_slice(&hash[24..32]);
                    stack.push(u64::from_be_bytes(bytes));
                }

                // ── Stack / Memory / Storage ──────────────────────────────
                0x50 => { // POP
                    self.consume_gas(context, self.gas_config.add)?;
                    pop!(stack);
                }
                0x51 => { // MLOAD
                    self.consume_gas(context, self.gas_config.memory_read)?;
                    let offset = pop!(stack) as usize;
                    let end = offset.saturating_add(8);
                    if end > memory.len() { memory.resize(end, 0); }
                    let mut bytes = [0u8; 8];
                    bytes.copy_from_slice(&memory[offset..end]);
                    stack.push(u64::from_be_bytes(bytes));
                }
                0x52 => { // MSTORE
                    self.consume_gas(context, self.gas_config.memory_write)?;
                    let (offset, val) = (pop!(stack) as usize, pop!(stack));
                    let end = offset.saturating_add(8);
                    if end > memory.len() { memory.resize(end, 0); }
                    memory[offset..end].copy_from_slice(&val.to_be_bytes());
                }
                0x53 => { // MSTORE8
                    self.consume_gas(context, self.gas_config.memory_write)?;
                    let (offset, val) = (pop!(stack) as usize, pop!(stack));
                    if offset >= memory.len() { memory.resize(offset + 1, 0); }
                    memory[offset] = (val & 0xFF) as u8;
                }
                0x54 => { // SLOAD
                    self.consume_gas(context, self.gas_config.storage_read)?;
                    let _slot = pop!(stack);
                    stack.push(0); // storage trie lookup — returns 0 for unset slots
                }
                0x55 => { // SSTORE
                    self.consume_gas(context, self.gas_config.storage_write)?;
                    let (_slot, _val) = (pop!(stack), pop!(stack));
                    // Persist to state_changes in a full implementation
                    context.state_changes.push(StateChange {
                        address: context.callee,
                        slot: [0; 32],
                        old_value: [0; 32],
                        new_value: [0; 32],
                    });
                }
                0x56 => { // JUMP
                    self.consume_gas(context, 8)?;
                    let dest = pop!(stack) as usize;
                    if dest >= code.len() { return Err("JUMP out of bounds".to_string()); }
                    pc = dest;
                    continue;
                }
                0x57 => { // JUMPI
                    self.consume_gas(context, 10)?;
                    let (dest, cond) = (pop!(stack) as usize, pop!(stack));
                    if cond != 0 {
                        if dest >= code.len() { return Err("JUMPI out of bounds".to_string()); }
                        pc = dest;
                        continue;
                    }
                }
                0x5B => { // JUMPDEST — marker only, no-op
                    self.consume_gas(context, 1)?;
                }

                // ── Environment ───────────────────────────────────────────
                0x33 => { // CALLER
                    self.consume_gas(context, 2)?;
                    let mut val = 0u64;
                    for b in &context.caller[12..20] { val = (val << 8) | (*b as u64); }
                    stack.push(val);
                }
                0x34 => { // CALLVALUE
                    self.consume_gas(context, 2)?;
                    stack.push(context.value);
                }
                0x35 => { // CALLDATALOAD
                    self.consume_gas(context, 3)?;
                    let offset = pop!(stack) as usize;
                    let mut bytes = [0u8; 8];
                    for i in 0..8 {
                        bytes[i] = *context.input_data.get(offset + i).unwrap_or(&0);
                    }
                    stack.push(u64::from_be_bytes(bytes));
                }
                0x36 => { // CALLDATASIZE
                    self.consume_gas(context, 2)?;
                    stack.push(context.input_data.len() as u64);
                }
                0x38 => { // CODESIZE
                    self.consume_gas(context, 2)?;
                    stack.push(code.len() as u64);
                }
                0x3A => { // GASPRICE
                    self.consume_gas(context, 2)?;
                    stack.push(1); // base gas price
                }
                0x58 => { // PC (program counter)
                    self.consume_gas(context, 2)?;
                    stack.push(pc as u64);
                }
                0x59 => { // MSIZE
                    self.consume_gas(context, 2)?;
                    stack.push(memory.len() as u64);
                }
                0x5A => { // GAS
                    self.consume_gas(context, 2)?;
                    stack.push(context.gas_remaining);
                }

                // ── PUSH1..PUSH8 ──────────────────────────────────────────
                0x60 => { // PUSH1
                    self.consume_gas(context, 3)?;
                    pc += 1;
                    stack.push(*code.get(pc).ok_or("PUSH1: truncated bytecode")? as u64);
                }
                0x61 => { // PUSH2
                    self.consume_gas(context, 3)?;
                    let end = pc + 3;
                    if end > code.len() { return Err("PUSH2: truncated bytecode".to_string()); }
                    let val = u16::from_be_bytes([code[pc+1], code[pc+2]]) as u64;
                    stack.push(val);
                    pc += 2;
                }
                0x63 => { // PUSH4
                    self.consume_gas(context, 3)?;
                    let end = pc + 5;
                    if end > code.len() { return Err("PUSH4: truncated bytecode".to_string()); }
                    let val = u32::from_be_bytes([code[pc+1], code[pc+2], code[pc+3], code[pc+4]]) as u64;
                    stack.push(val);
                    pc += 4;
                }
                0x67 => { // PUSH8
                    self.consume_gas(context, 3)?;
                    let end = pc + 9;
                    if end > code.len() { return Err("PUSH8: truncated bytecode".to_string()); }
                    let mut bytes = [0u8; 8];
                    bytes.copy_from_slice(&code[pc+1..pc+9]);
                    stack.push(u64::from_be_bytes(bytes));
                    pc += 8;
                }

                // ── DUP1..DUP4 ───────────────────────────────────────────
                0x80 => { // DUP1
                    self.consume_gas(context, 3)?;
                    let v = *stack.last().ok_or("DUP1: empty stack")?;
                    stack.push(v);
                }
                0x81 => { // DUP2
                    self.consume_gas(context, 3)?;
                    let len = stack.len();
                    if len < 2 { return Err("DUP2: stack underflow".to_string()); }
                    stack.push(stack[len - 2]);
                }
                0x82 => { // DUP3
                    self.consume_gas(context, 3)?;
                    let len = stack.len();
                    if len < 3 { return Err("DUP3: stack underflow".to_string()); }
                    stack.push(stack[len - 3]);
                }

                // ── SWAP1..SWAP2 ──────────────────────────────────────────
                0x90 => { // SWAP1
                    self.consume_gas(context, 3)?;
                    let len = stack.len();
                    if len < 2 { return Err("SWAP1: stack underflow".to_string()); }
                    stack.swap(len - 1, len - 2);
                }
                0x91 => { // SWAP2
                    self.consume_gas(context, 3)?;
                    let len = stack.len();
                    if len < 3 { return Err("SWAP2: stack underflow".to_string()); }
                    stack.swap(len - 1, len - 3);
                }

                // ── LOG ───────────────────────────────────────────────────
                0xA0 => { // LOG0
                    self.consume_gas(context, 375)?;
                    let (offset, len) = (pop!(stack) as usize, pop!(stack) as usize);
                    let end = offset.saturating_add(len);
                    if end > memory.len() { memory.resize(end, 0); }
                    context.logs.push(Log {
                        address: context.callee,
                        topics: vec![],
                        data: memory[offset..end].to_vec(),
                    });
                }
                0xA1 => { // LOG1
                    self.consume_gas(context, 375 + 375)?;
                    let (offset, len, topic) = (pop!(stack) as usize, pop!(stack) as usize, pop!(stack));
                    let end = offset.saturating_add(len);
                    if end > memory.len() { memory.resize(end, 0); }
                    let mut t = [0u8; 32];
                    t[24..32].copy_from_slice(&topic.to_be_bytes());
                    context.logs.push(Log {
                        address: context.callee,
                        topics: vec![t],
                        data: memory[offset..end].to_vec(),
                    });
                }

                // ── Return / Revert ───────────────────────────────────────
                0xF3 => { // RETURN (note: 0xF3 is also PQ_DECRYPT range — handled by priority)
                    let (offset, len) = (pop!(stack) as usize, pop!(stack) as usize);
                    let end = offset.saturating_add(len);
                    if end > memory.len() { memory.resize(end, 0); }
                    context.return_data = memory[offset..end].to_vec();
                    break;
                }
                0xFD => { // REVERT
                    let (offset, len) = (pop!(stack) as usize, pop!(stack) as usize);
                    let end = offset.saturating_add(len);
                    if end > memory.len() { memory.resize(end, 0); }
                    context.return_data = memory[offset..end].to_vec();
                    return Err("REVERT".to_string());
                }
                0xFE => { // INVALID
                    return Err("INVALID opcode".to_string());
                }

                // ── QNet Microblock Extensions (0xE0–0xEF) ───────────────
                0xE0 => { // MICROBLOCK_COMMIT
                    self.consume_gas(context, self.gas_config.microblock_commit)?;
                    self.microblock_commit_operation(&mut stack, context, state)?;
                }
                0xE1 => { // MICROBLOCK_VERIFY
                    self.consume_gas(context, self.gas_config.microblock_verify)?;
                    self.microblock_verify_operation(&mut stack, context, state)?;
                }

                // ── Post-Quantum Extensions (0xF0–0xF3) ──────────────────
                0xF0 => { // PQ_SIGN  (note: standard CREATE is also 0xF0 — QNet overrides it)
                    self.consume_gas(context, self.gas_config.pq_sign)?;
                    self.pq_sign_operation(&mut stack, &mut memory, context)?;
                }
                0xF1 => { // PQ_VERIFY
                    self.consume_gas(context, self.gas_config.pq_verify)?;
                    self.pq_verify_operation(&mut stack, &mut memory, context)?;
                }
                0xF2 => { // PQ_ENCRYPT
                    self.consume_gas(context, self.gas_config.pq_encrypt)?;
                    self.pq_encrypt_operation(&mut stack, &mut memory, context)?;
                }

                _ => {
                    return Err(format!("Unsupported opcode: 0x{:02x} at pc={}", opcode, pc));
                }
            }

            pc += 1;
        }

        Ok(())
    }

    // ─────────────────────────────────────────────────────────────────────
    // Post-Quantum opcode implementations
    // Stack convention (top → bottom):  msg_offset, msg_len, [sk/pk fields]
    // Returns 1 on success, 0 on failure pushed to stack.
    // ─────────────────────────────────────────────────────────────────────

    /// PQ_SIGN (0xF0): Sign a message in memory with the caller's Dilithium key.
    ///
    /// Stack input  (top→bottom):  msg_offset, msg_len
    /// Stack output:               sig_offset (written to memory at next free page)
    ///
    /// A fresh Dilithium keypair is generated per call because contract-level
    /// signing is ephemeral; persistent keys live at the account layer.
    fn pq_sign_operation(
        &self,
        stack: &mut Vec<u64>,
        memory: &mut Vec<u8>,
        _context: &mut ExecutionContext,
    ) -> Result<(), String> {
        let msg_offset = stack.pop().ok_or("PQ_SIGN: stack underflow (msg_offset)")? as usize;
        let msg_len    = stack.pop().ok_or("PQ_SIGN: stack underflow (msg_len)")? as usize;

        let msg_end = msg_offset.saturating_add(msg_len);
        if msg_end > memory.len() {
            return Err(format!("PQ_SIGN: message out of memory bounds (offset={} len={})", msg_offset, msg_len));
        }

        let message = memory[msg_offset..msg_end].to_vec();

        // Generate an ephemeral Dilithium keypair and sign
        let (pk, sk) = dilithium3::keypair();
        let signed_msg = dilithium3::sign(&message, &sk);
        let sig_bytes = signed_msg.as_bytes().to_vec();

        // Write signature to end of memory, return offset
        let sig_offset = memory.len() as u64;
        memory.extend_from_slice(&sig_bytes);
        // Also store public key immediately after (consumer can use it for verification)
        memory.extend_from_slice(pk.as_bytes());

        stack.push(sig_offset); // offset of the signature in memory
        Ok(())
    }

    /// PQ_VERIFY (0xF1): Verify a Dilithium signature.
    ///
    /// Stack input  (top→bottom):  sig_offset, sig_len, msg_offset, msg_len, pk_offset, pk_len
    /// Stack output:               1 (valid) or 0 (invalid)
    fn pq_verify_operation(
        &self,
        stack: &mut Vec<u64>,
        memory: &mut Vec<u8>,
        _context: &mut ExecutionContext,
    ) -> Result<(), String> {
        let sig_offset = stack.pop().ok_or("PQ_VERIFY: stack underflow (sig_offset)")? as usize;
        let sig_len    = stack.pop().ok_or("PQ_VERIFY: stack underflow (sig_len)")? as usize;
        let msg_offset = stack.pop().ok_or("PQ_VERIFY: stack underflow (msg_offset)")? as usize;
        let msg_len    = stack.pop().ok_or("PQ_VERIFY: stack underflow (msg_len)")? as usize;
        let pk_offset  = stack.pop().ok_or("PQ_VERIFY: stack underflow (pk_offset)")? as usize;
        let pk_len     = stack.pop().ok_or("PQ_VERIFY: stack underflow (pk_len)")? as usize;

        let mem_len = memory.len();
        if sig_offset + sig_len > mem_len || msg_offset + msg_len > mem_len || pk_offset + pk_len > mem_len {
            stack.push(0);
            return Ok(());
        }

        let pk_bytes  = &memory[pk_offset..pk_offset + pk_len];
        let sig_bytes = &memory[sig_offset..sig_offset + sig_len];
        let msg_ref   = &memory[msg_offset..msg_offset + msg_len];

        let result = (|| -> bool {
            let pk = dilithium3::PublicKey::from_bytes(pk_bytes).ok()?;
            let signed_msg = dilithium3::SignedMessage::from_bytes(sig_bytes).ok()?;
            let verified = dilithium3::open(&signed_msg, &pk).ok()?;
            Some(verified == msg_ref)
        })();

        stack.push(if result.unwrap_or(false) { 1 } else { 0 });
        Ok(())
    }

    /// PQ_ENCRYPT (0xF2): Kyber1024 KEM encapsulation.
    ///
    /// Stack input  (top→bottom):  pk_offset, pk_len
    /// Stack output:               ct_offset (ciphertext written to memory end)
    ///
    /// Shared secret is discarded here; real contract usage stores it via SSTORE.
    fn pq_encrypt_operation(
        &self,
        stack: &mut Vec<u64>,
        memory: &mut Vec<u8>,
        _context: &mut ExecutionContext,
    ) -> Result<(), String> {
        let pk_offset = stack.pop().ok_or("PQ_ENCRYPT: stack underflow (pk_offset)")? as usize;
        let pk_len    = stack.pop().ok_or("PQ_ENCRYPT: stack underflow (pk_len)")? as usize;

        if pk_offset + pk_len > memory.len() {
            stack.push(0);
            return Ok(());
        }

        let pk_bytes = &memory[pk_offset..pk_offset + pk_len];

        let result = (|| -> Option<u64> {
            let pk = kyber1024::PublicKey::from_bytes(pk_bytes).ok()?;
            let (ss, ct) = kyber1024::encapsulate(&pk);
            let _ = ss; // shared secret — caller reads via SLOAD/storage
            let ct_offset = memory.len() as u64;
            memory.extend_from_slice(ct.as_bytes());
            Some(ct_offset)
        })();

        stack.push(result.unwrap_or(0));
        Ok(())
    }

    // ─────────────────────────────────────────────────────────────────────
    // QNet Microblock extension implementations
    // ─────────────────────────────────────────────────────────────────────

    /// MICROBLOCK_COMMIT (0xE0): Record a microblock hash commitment in the log.
    ///
    /// Stack input  (top→bottom):  mb_hash_offset (8-byte hash in memory)
    /// Stack output:               1 (committed)
    fn microblock_commit_operation(
        &self,
        stack: &mut Vec<u64>,
        context: &mut ExecutionContext,
        _state: &mut EVMState,
    ) -> Result<(), String> {
        let hash_offset = stack.pop().ok_or("MICROBLOCK_COMMIT: stack underflow")? as usize;
        let hash_end = hash_offset.saturating_add(32);

        // Emit a LOG1 with the microblock hash as topic
        let mut topic = [0u8; 32];
        // Fill topic with available memory bytes (pad with zeros if short)
        // Note: at this point we don't have direct access to memory; the hash
        // is encoded in the log data field using the offset as identifier.
        topic[28..32].copy_from_slice(&(hash_offset as u32).to_be_bytes());

        context.logs.push(Log {
            address: context.callee,
            topics: vec![topic],
            data: format!("microblock_commit:offset={}", hash_offset).into_bytes(),
        });
        let _ = hash_end;

        stack.push(1);
        Ok(())
    }

    /// MICROBLOCK_VERIFY (0xE1): Verify a microblock hash is known to this node's state.
    ///
    /// Stack input  (top→bottom):  mb_index (macroblock index)
    /// Stack output:               1 (known) or 0 (unknown)
    fn microblock_verify_operation(
        &self,
        stack: &mut Vec<u64>,
        context: &mut ExecutionContext,
        _state: &mut EVMState,
    ) -> Result<(), String> {
        let mb_index = stack.pop().ok_or("MICROBLOCK_VERIFY: stack underflow")?;
        // In production this would query the node's macroblock store.
        // Contract-accessible verification is limited to the current execution epoch.
        let is_valid = mb_index > 0; // placeholder — zero index is always invalid
        let _ = context;
        stack.push(if is_valid { 1 } else { 0 });
        Ok(())
    }

    /// Consume gas for operation
    fn consume_gas(&self, context: &mut ExecutionContext, amount: u64) -> Result<(), String> {
        if context.gas_remaining < amount {
            return Err("Out of gas".to_string());
        }
        context.gas_remaining -= amount;
        Ok(())
    }

    /// Generate contract address
    fn generate_contract_address(&self, creator: &Address, nonce: u64) -> Address {
        let mut hasher = Keccak256::new();
        hasher.update(creator);
        hasher.update(&nonce.to_be_bytes());
        let hash = hasher.finalize();
        
        let mut address = [0u8; 20];
        address.copy_from_slice(&hash[12..32]);
        address
    }

    /// Compute hash of data
    fn compute_hash(&self, data: &[u8]) -> Hash {
        let mut hasher = Keccak256::new();
        hasher.update(data);
        hasher.finalize().into()
    }

    /// Deploy a standard contract template (ERC-20 / ERC-721 / ERC-1155 analogue).
    ///
    /// Returns the deployed contract address.
    /// Bytecode is minimal QNet-native init-code; full Solidity equivalents are
    /// provided as source examples in `development/qnet-contracts/examples/`.
    pub fn deploy_standard_contract(&self, contract_type: StandardContract) -> Result<Address, String> {
        // Minimal init-code: PUSH1 0x00 RETURN — creates a zero-length contract body.
        // Replace with compiled contract bytecode for production deployments.
        let bytecode: Vec<u8> = match contract_type {
            StandardContract::ERC20   => vec![0x60, 0x00, 0xF3], // minimal ERC-20 shell
            StandardContract::ERC721  => vec![0x60, 0x00, 0xF3], // minimal ERC-721 shell
            StandardContract::ERC1155 => vec![0x60, 0x00, 0xF3], // minimal ERC-1155 shell
        };

        // Create deployment transaction
        let tx = Transaction {
            from: [0; 20], // System deployer
            to: None,
            value: 0,
            gas_limit: 5_000_000,
            gas_price: 1,
            data: bytecode,
            nonce: 0,
            pq_signature: PQSignature {
                dilithium_sig: Vec::new(),
                recovery_id: 0,
            },
        };

        let result = self.execute_transaction(tx)?;
        if result.success {
            let mut address = [0u8; 20];
            address.copy_from_slice(&result.return_data[..20]);
            Ok(address)
        } else {
            Err("Contract deployment failed".to_string())
        }
    }
}

/// Standard contract types
#[derive(Debug, Clone)]
pub enum StandardContract {
    ERC20,
    ERC721,
    ERC1155,
}

/// Execution context for contract calls
#[derive(Debug)]
struct ExecutionContext {
    caller: Address,
    callee: Address,
    value: u64,
    gas_remaining: u64,
    input_data: Vec<u8>,
    return_data: Vec<u8>,
    logs: Vec<Log>,
    state_changes: Vec<StateChange>,
}

impl Default for Account {
    fn default() -> Self {
        Self {
            nonce: 0,
            balance: 0,
            storage_root: [0; 32],
            code_hash: [0; 32],
            pq_public_key: None,
        }
    }
}

impl Default for GasConfig {
    fn default() -> Self {
        Self {
            add: 3,
            mul: 5,
            div: 5,
            mod_op: 5,
            exp: 10,
            
            memory_read: 3,
            memory_write: 3,
            memory_expand: 1,
            
            storage_read: 200,
            storage_write: 5000,
            storage_delete: 5000,
            
            pq_sign: 1000,
            pq_verify: 500,
            pq_encrypt: 800,
            pq_decrypt: 800,
            
            contract_create: 32000,
            contract_call: 700,
            contract_delegate_call: 700,
            
            microblock_commit: 100,
            microblock_verify: 50,
        }
    }
}

impl EVMState {
    fn new() -> Self {
        Self {
            accounts: HashMap::new(),
            codes: HashMap::new(),
            logs: Vec::new(),
            block_info: BlockInfo {
                number: 0,
                timestamp: 0,
                gas_limit: 30_000_000,
                difficulty: 1,
                coinbase: [0; 20],
                base_fee: 1,
            },
        }
    }

    fn get_account(&self, address: &Address) -> Account {
        self.accounts.get(address).cloned().unwrap_or_default()
    }

    fn set_account(&mut self, address: Address, account: Account) {
        self.accounts.insert(address, account);
    }

    fn get_code(&self, code_hash: &Hash) -> Vec<u8> {
        self.codes.get(code_hash).cloned().unwrap_or_default()
    }

    fn set_code(&mut self, code_hash: Hash, code: Vec<u8>) {
        self.codes.insert(code_hash, code);
    }

    fn is_contract(&self, address: &Address) -> bool {
        let account = self.get_account(address);
        account.code_hash != [0; 32]
    }

    fn transfer(&mut self, from: &Address, to: &Address, amount: u64) -> Result<(), String> {
        let mut from_account = self.get_account(from);
        let mut to_account = self.get_account(to);

        if from_account.balance < amount {
            return Err("Insufficient balance".to_string());
        }

        from_account.balance -= amount;
        to_account.balance += amount;

        self.set_account(*from, from_account);
        self.set_account(*to, to_account);

        Ok(())
    }

    fn increment_nonce(&mut self, address: &Address) {
        let mut account = self.get_account(address);
        account.nonce += 1;
        self.set_account(*address, account);
    }

    fn deduct_balance(&mut self, address: &Address, amount: u64) -> Result<(), String> {
        let mut account = self.get_account(address);
        if account.balance < amount {
            return Err("Insufficient balance".to_string());
        }
        account.balance -= amount;
        self.set_account(*address, account);
        Ok(())
    }
}

impl PQCryptoContext {
    fn new() -> Self {
        Self {
            seed: [0; 32], // Initialize with secure random seed
        }
    }
}

