//! The account leaf preimage: every field `StateMerkleTree::hash_account` reads except the address,
//! in a fixed byte form. A proof server stores it next to the leaf so a certified proof can carry
//! the fields without reading live state; the request supplies the address and the hash binds it.

use crate::Account;

/// Wire version of the encoding below. Decoding refuses anything else.
pub const LEAF_PREIMAGE_VERSION: u8 = 0x01;
/// Longest code hash the encoding carries; a longer one is not a code hash.
pub const CODE_HASH_MAX_BYTES: usize = 1024;
const NO_CODE_HASH: u16 = 0xFFFF;
const FLAG_CONTRACT: u8 = 0b01;
const FLAG_NODE: u8 = 0b10;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountLeafPreimage {
    pub balance: u64,
    pub nonce: u64,
    pub is_contract: bool,
    pub is_node: bool,
    pub contract_code_hash: Option<String>,
    /// Hashed into the leaf only for a contract; carried only for a contract.
    pub storage_root: [u8; 32],
    pub heartbeat_epoch: u64,
    pub heartbeat_slots: u16,
    pub heartbeat_final_epoch: u64,
    pub heartbeat_final_slots: u16,
    pub last_claimed_epoch: u64,
    pub banned_at_height: u64,
}

impl AccountLeafPreimage {
    pub fn of(a: &Account) -> Self {
        Self {
            balance: a.balance,
            nonce: a.nonce,
            is_contract: a.is_contract,
            is_node: a.is_node,
            contract_code_hash: a.contract_code_hash.clone(),
            storage_root: if a.is_contract { a.storage_root } else { [0u8; 32] },
            heartbeat_epoch: a.heartbeat_epoch,
            heartbeat_slots: a.heartbeat_slots,
            heartbeat_final_epoch: a.heartbeat_final_epoch,
            heartbeat_final_slots: a.heartbeat_final_slots,
            last_claimed_epoch: a.last_claimed_epoch,
            banned_at_height: a.banned_at_height,
        }
    }

    /// Fixed little-endian form: 56 bytes for a plain account, about 152 for a contract. None when
    /// the code hash is longer than the form carries; the caller then records the preimage unknown.
    pub fn encode(&self) -> Option<Vec<u8>> {
        let code = self.contract_code_hash.as_deref().map(str::as_bytes);
        if code.map_or(false, |c| c.len() > CODE_HASH_MAX_BYTES) {
            return None;
        }
        let mut out = Vec::with_capacity(56 + code.map_or(0, |c| c.len()) + if self.is_contract { 32 } else { 0 });
        out.push(LEAF_PREIMAGE_VERSION);
        out.extend_from_slice(&self.balance.to_le_bytes());
        out.extend_from_slice(&self.nonce.to_le_bytes());
        let mut flags = 0u8;
        if self.is_contract { flags |= FLAG_CONTRACT; }
        if self.is_node { flags |= FLAG_NODE; }
        out.push(flags);
        match code {
            Some(c) => {
                out.extend_from_slice(&(c.len() as u16).to_le_bytes());
                out.extend_from_slice(c);
            }
            None => out.extend_from_slice(&NO_CODE_HASH.to_le_bytes()),
        }
        if self.is_contract {
            out.extend_from_slice(&self.storage_root);
        }
        out.extend_from_slice(&self.heartbeat_epoch.to_le_bytes());
        out.extend_from_slice(&self.heartbeat_slots.to_le_bytes());
        out.extend_from_slice(&self.heartbeat_final_epoch.to_le_bytes());
        out.extend_from_slice(&self.heartbeat_final_slots.to_le_bytes());
        out.extend_from_slice(&self.last_claimed_epoch.to_le_bytes());
        out.extend_from_slice(&self.banned_at_height.to_le_bytes());
        Some(out)
    }

    /// Strict inverse of `encode`: known version, no unknown flag bits, a code hash of at most
    /// `CODE_HASH_MAX_BYTES` valid UTF-8, and exactly the bytes the fields need.
    pub fn decode(b: &[u8]) -> Option<Self> {
        let mut r = Reader { b, at: 0 };
        if r.u8()? != LEAF_PREIMAGE_VERSION {
            return None;
        }
        let balance = r.u64()?;
        let nonce = r.u64()?;
        let flags = r.u8()?;
        if flags & !(FLAG_CONTRACT | FLAG_NODE) != 0 {
            return None;
        }
        let code_len = r.u16()?;
        let contract_code_hash = if code_len == NO_CODE_HASH {
            None
        } else {
            let n = code_len as usize;
            if n > CODE_HASH_MAX_BYTES {
                return None;
            }
            Some(String::from_utf8(r.take(n)?.to_vec()).ok()?)
        };
        let is_contract = flags & FLAG_CONTRACT != 0;
        let mut storage_root = [0u8; 32];
        if is_contract {
            storage_root.copy_from_slice(r.take(32)?);
        }
        let p = Self {
            balance,
            nonce,
            is_contract,
            is_node: flags & FLAG_NODE != 0,
            contract_code_hash,
            storage_root,
            heartbeat_epoch: r.u64()?,
            heartbeat_slots: r.u16()?,
            heartbeat_final_epoch: r.u64()?,
            heartbeat_final_slots: r.u16()?,
            last_claimed_epoch: r.u64()?,
            banned_at_height: r.u64()?,
        };
        if r.at != b.len() {
            return None;
        }
        Some(p)
    }

    /// The account leaf these fields hash to under `address`, through the consensus leaf function
    /// itself: there is one leaf schema, never a second copy of it.
    pub fn leaf_hash(&self, address: &str) -> [u8; 32] {
        crate::state::StateMerkleTree::hash_account(&self.account_shell(address))
    }

    fn account_shell(&self, address: &str) -> Account {
        let mut a = Account::default();
        a.address = address.to_string();
        a.balance = self.balance;
        a.nonce = self.nonce;
        a.is_node = self.is_node;
        a.is_contract = self.is_contract;
        a.contract_code_hash = self.contract_code_hash.clone();
        a.storage_root = self.storage_root;
        a.heartbeat_epoch = self.heartbeat_epoch;
        a.heartbeat_slots = self.heartbeat_slots;
        a.heartbeat_final_epoch = self.heartbeat_final_epoch;
        a.heartbeat_final_slots = self.heartbeat_final_slots;
        a.last_claimed_epoch = self.last_claimed_epoch;
        a.banned_at_height = self.banned_at_height;
        a
    }
}

struct Reader<'a> {
    b: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let end = self.at.checked_add(n)?;
        let s = self.b.get(self.at..end)?;
        self.at = end;
        Some(s)
    }
    fn u8(&mut self) -> Option<u8> { self.take(1).map(|s| s[0]) }
    fn u16(&mut self) -> Option<u16> { self.take(2).map(|s| u16::from_le_bytes([s[0], s[1]])) }
    fn u64(&mut self) -> Option<u64> {
        self.take(8).map(|s| { let mut x = [0u8; 8]; x.copy_from_slice(s); u64::from_le_bytes(x) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::StateMerkleTree;

    fn base(addr: &str) -> Account {
        let mut a = Account::new(addr.to_string());
        a.balance = 1_234_567_890;
        a.nonce = 42;
        a
    }

    fn shapes() -> Vec<Account> {
        let plain = base("eon_plain");
        let mut node = base("eon_node");
        node.is_node = true;
        let mut banned = base("eon_banned");
        banned.banned_at_height = 777_000;
        let mut hb = base("eon_hb");
        hb.heartbeat_epoch = 91;
        hb.heartbeat_slots = 0b10_1101_0110;
        hb.heartbeat_final_epoch = 90;
        hb.heartbeat_final_slots = 0x3FF;
        hb.last_claimed_epoch = 88;
        let mut contract = base("eon_contract");
        contract.is_contract = true;
        contract.contract_code_hash = Some("ab".repeat(32));
        contract.contract_storage.insert("balance:x".to_string(), "5".to_string());
        contract.storage_root = StateMerkleTree::compute_storage_root(&contract.contract_storage);
        let mut empty_code = base("eon_empty_code");
        empty_code.is_contract = true;
        empty_code.contract_code_hash = Some(String::new());
        empty_code.storage_root = [9u8; 32];
        vec![plain, node, banned, hb, contract, empty_code]
    }

    #[test]
    fn leaf_preimage_hashes_like_hash_account() {
        for a in shapes() {
            let p = AccountLeafPreimage::of(&a);
            assert_eq!(p.leaf_hash(&a.address), StateMerkleTree::hash_account(&a), "leaf for {}", a.address);
            let bytes = p.encode().expect("encodes");
            let back = AccountLeafPreimage::decode(&bytes).expect("round-trips");
            assert_eq!(back, p);
            assert_eq!(back.leaf_hash(&a.address), StateMerkleTree::hash_account(&a));
            if !a.is_contract {
                assert_eq!(bytes.len(), 56, "a plain account is 56 bytes");
            }
        }
        // A different address never yields the same leaf from the same fields.
        let a = base("eon_a");
        assert_ne!(AccountLeafPreimage::of(&a).leaf_hash("eon_b"), StateMerkleTree::hash_account(&a));
    }

    #[test]
    fn leaf_preimage_decode_is_strict() {
        let shapes = shapes();
        let plain = AccountLeafPreimage::of(&shapes[0]).encode().unwrap();
        let contract = AccountLeafPreimage::of(&shapes[4]).encode().unwrap();
        for good in [&plain, &contract] {
            assert!(AccountLeafPreimage::decode(&good[..good.len() - 1]).is_none(), "truncated");
            let mut extra = good.clone();
            extra.push(0);
            assert!(AccountLeafPreimage::decode(&extra).is_none(), "extra byte");
            let mut ver = good.clone();
            ver[0] = 0x02;
            assert!(AccountLeafPreimage::decode(&ver).is_none(), "unknown version");
            let mut flag = good.clone();
            flag[17] |= 0b100;
            assert!(AccountLeafPreimage::decode(&flag).is_none(), "unknown flag bit");
        }
        // Over-long code hash: refused at encode and at decode.
        let mut long = shapes[4].clone();
        long.contract_code_hash = Some("x".repeat(CODE_HASH_MAX_BYTES + 1));
        assert!(AccountLeafPreimage::of(&long).encode().is_none());
        let mut forged = contract.clone();
        let n = (CODE_HASH_MAX_BYTES + 1) as u16;
        forged[18..20].copy_from_slice(&n.to_le_bytes());
        assert!(AccountLeafPreimage::decode(&forged).is_none(), "over-long code hash length");
        // Non-UTF-8 code hash bytes.
        let mut bad_utf8 = contract.clone();
        bad_utf8[20] = 0xFF;
        bad_utf8[21] = 0xFE;
        assert!(AccountLeafPreimage::decode(&bad_utf8).is_none(), "non-UTF-8 code hash");
    }
}
