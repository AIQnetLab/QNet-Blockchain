//! The bytes of the device layer: preimages of the device messages, the tags, the lease statement the
//! oracle signs, the device statement the genesis attestors sign, the state change and the revocation
//! snapshot (`docs/protocols/light-node-messages.md` sections 2, 5 and 6).
//!
//! The device oracle keeps its own Rust copy of these (`development/qnet-device-oracle/src/messages.rs`,
//! a separate workspace that is never linked into the node). Both copies are held to the same shared
//! vectors, byte for byte.

use sha3::{Digest, Sha3_256};

use super::{Effective, Gate, LeaseKind, Op, Platform, Prov, Trust, DeviceState};

/// `chain_id` of every device preimage: the decimal network id.
pub fn chain_id() -> String {
    qnet_state::transaction::QNET_CHAIN_ID.to_string()
}

pub fn sha3_256(data: &[u8]) -> [u8; 32] {
    Sha3_256::digest(data).into()
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    sha2::Sha256::digest(data).into()
}

/// b64url without padding, canonical on decode: no `=`, no other alphabet, no length of 1 mod 4 and no
/// non-zero padding bits (spec section 2).
const B64URL: base64::engine::GeneralPurpose = base64::engine::GeneralPurpose::new(
    &base64::alphabet::URL_SAFE,
    base64::engine::GeneralPurposeConfig::new()
        .with_encode_padding(false)
        .with_decode_padding_mode(base64::engine::DecodePaddingMode::RequireNone),
);

pub fn b64url(data: &[u8]) -> String {
    use base64::Engine as _;
    B64URL.encode(data)
}

pub fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    B64URL.decode(s).ok()
}

/// A 32-byte challenge nonce in its b64url text form (43 characters).
pub fn nonce32(s: &str) -> Option<[u8; 32]> {
    if s.len() != 43 { return None; }
    b64url_decode(s)?.try_into().ok()
}

pub fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `light_mobile_` followed by 16 lowercase hex characters: the only node ids a device message names.
pub fn is_device_node_id(s: &str) -> bool {
    match s.strip_prefix("light_mobile_") {
        Some(h) => h.len() == 16 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        None => false,
    }
}

/// `qnet_dev_enrol:v1|{chain_id}|{N}|{W}|{hex(sha3(pp))}|{seq}|{nonce}|{flags}`
pub fn enrol_preimage(node: &str, wallet: &str, ping_pk_sha3: &str, seq: u64, nonce: &str, flags: &str) -> String {
    format!("qnet_dev_enrol:v1|{}|{}|{}|{}|{}|{}|{}", chain_id(), node, wallet, ping_pk_sha3, seq, nonce, flags)
}

/// `qnet_dev_rotate:v1|{chain_id}|{N}|{hex(sha3(old_hw_pub))}|{hex(sha3(pp))}|{seq}|{nonce}`
pub fn rotate_preimage(node: &str, old_hw_key: &str, ping_pk_sha3: &str, seq: u64, nonce: &str) -> String {
    format!("qnet_dev_rotate:v1|{}|{}|{}|{}|{}|{}", chain_id(), node, old_hw_key, ping_pk_sha3, seq, nonce)
}

/// `qnet_dev_rebind:v1|{chain_id}|{N_old}|{N_new}|{seq}|{nonce}`
pub fn rebind_preimage(node_old: &str, node_new: &str, seq: u64, nonce: &str) -> String {
    format!("qnet_dev_rebind:v1|{}|{}|{}|{}|{}", chain_id(), node_old, node_new, seq, nonce)
}

/// `qnet_dev_refresh:v1|{chain_id}|{N}|{nonce}`
pub fn refresh_preimage(node: &str, nonce: &str) -> String {
    format!("qnet_dev_refresh:v1|{}|{}|{}", chain_id(), node, nonce)
}

/// `qnet_dev_release:v1|{chain_id}|{N}|{seq}|{nonce}`
pub fn release_preimage(node: &str, seq: u64, nonce: &str) -> String {
    format!("qnet_dev_release:v1|{}|{}|{}|{}", chain_id(), node, seq, nonce)
}

/// `qnet_hwping:v2|{chain_id}|{N}|{epoch(h)}|{h}|{hash}|{hex(sha3(σ))}|{hw_seq}`
pub fn hwping_preimage(node: &str, height: u64, hash: &str, sigma: &[u8], hw_seq: u64) -> String {
    format!("qnet_hwping:v2|{}|{}|{}|{}|{}|{}|{}", chain_id(), node, height / super::EPOCH_BLOCKS, height, hash,
            hex::encode(sha3_256(sigma)), hw_seq)
}

/// The Android enrolment flags: `r={hex(sha3(R))}`.
pub fn android_flags(report: &str) -> String {
    format!("r={}", hex::encode(sha3_256(report.as_bytes())))
}

/// The digest a Play Integrity nonce of an enrolment encodes: SHA-256(UTF-8(E) ‖ sha3(hw_pub) ‖ sha3(R)).
pub fn play_nonce_enrol_digest(preimage: &str, hw_pub: &[u8], report: &str) -> [u8; 32] {
    let mut h = sha2::Sha256::new();
    h.update(preimage.as_bytes());
    h.update(sha3_256(hw_pub));
    h.update(sha3_256(report.as_bytes()));
    h.finalize().into()
}

/// The digest the Play Integrity nonce of every other device message encodes: SHA-256(preimage).
pub fn play_nonce_digest(preimage: &str) -> [u8; 32] {
    sha256(preimage.as_bytes())
}

/// `device_tag` = SHA3-256(`qnet_device_tag:v1|` ‖ chain_id ‖ `|` ‖ platform byte ‖ hw_pub): per network,
/// never public.
pub fn device_tag(platform: Platform, hw_pub: &[u8]) -> [u8; 32] {
    let mut h = Sha3_256::new();
    h.update(b"qnet_device_tag:v1|");
    h.update(chain_id().as_bytes());
    h.update(b"|");
    h.update([platform.byte()]);
    h.update(hw_pub);
    h.finalize().into()
}

/// `ref` = first 8 hex of SHA3-256(`qnet_dev_ref:v1|` ‖ nonce ‖ device_tag), `nonce` the 32 challenge bytes
/// of the device message whose outcome a screen shows.
pub fn reference(nonce: &[u8; 32], device_tag: &[u8; 32]) -> String {
    let mut h = Sha3_256::new();
    h.update(b"qnet_dev_ref:v1|");
    h.update(nonce);
    h.update(device_tag);
    hex::encode(h.finalize())[..8].to_string()
}

/// The lease statement the oracle signs (section 6.1).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct LeaseStatement {
    pub node: String,
    pub device_tag: [u8; 32],
    pub lease: LeaseKind,
    pub effective: Effective,
    pub gate: Gate,
    /// hex SHA-256 of the decoded Play verdict payload; empty on iOS.
    pub pi_digest: String,
    pub issued_at: u64,
}

impl LeaseStatement {
    pub fn preimage(&self) -> String {
        format!("qnet_device_lease:v1|{}|{}|{}|{}|{}|{}|{}|{}", chain_id(), self.node, hex::encode(self.device_tag),
                self.lease.as_str(), self.effective.as_str(), self.gate.as_str(), self.pi_digest, self.issued_at)
    }

    /// The exact canonical text only: this chain, a device node id, known values, a decimal time.
    pub fn parse(text: &str) -> Option<LeaseStatement> {
        let f: Vec<&str> = text.split('|').collect();
        if f.len() != 9 || f[0] != "qnet_device_lease:v1" || f[1] != chain_id() || !is_device_node_id(f[2]) {
            return None;
        }
        if !is_hex64(f[3]) || !(f[7].is_empty() || is_hex64(f[7])) || !is_decimal(f[8]) { return None; }
        let l = LeaseStatement {
            node: f[2].to_string(),
            device_tag: hex::decode(f[3]).ok()?.try_into().ok()?,
            lease: LeaseKind::parse(f[4])?,
            effective: Effective::parse(f[5])?,
            gate: Gate::parse(f[6])?,
            pi_digest: f[7].to_string(),
            issued_at: f[8].parse().ok()?,
        };
        (l.preimage() == text).then_some(l)
    }
}

/// SHA3-256 of the UTF-8 lease statement followed by the oracle's raw signature: the last field of a
/// device statement. With no lease both are empty, which gives the hash of the empty string.
pub fn lease_hash(lease: &str, oracle_sig: &[u8]) -> String {
    let mut h = Sha3_256::new();
    h.update(lease.as_bytes());
    h.update(oracle_sig);
    hex::encode(h.finalize())
}

/// The last field of a statement made without a lease (no vendor token, or no slot read).
pub fn no_lease_hash() -> String {
    lease_hash("", &[])
}

/// The device statement the five genesis sign, four of them making it final (section 6.2).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct StatementFields {
    pub node: String,
    pub device_tag: [u8; 32],
    /// hex(sha3(hw_pub))
    pub hw_key: String,
    pub platform: Platform,
    pub prov: Prov,
    pub trust: Trust,
    pub op: Op,
    pub issued_epoch: u64,
    pub effective_epoch: u64,
    pub state: DeviceState,
    pub lease_hash: String,
}

impl StatementFields {
    pub fn preimage(&self) -> String {
        format!("qnet_device_stmt:v1|{}|{}|{}|p256|{}|{}|{}|{}|{}|{}|{}|{}|{}", chain_id(), self.node,
                hex::encode(self.device_tag), self.hw_key, self.platform.as_str(), self.prov.as_str(),
                self.trust.as_str(), self.op.as_str(), self.issued_epoch, self.effective_epoch, self.state.as_str(),
                self.lease_hash)
    }

    pub fn parse(text: &str) -> Option<StatementFields> {
        // tag|chain|N|device_tag|p256|hw_key|platform|prov|trust|op|issued|effective|state|lease_hash
        let f: Vec<&str> = text.split('|').collect();
        if f.len() != 14 || f[0] != "qnet_device_stmt:v1" || f[1] != chain_id() || !is_device_node_id(f[2])
            || f[4] != "p256" {
            return None;
        }
        if !is_hex64(f[3]) || !is_hex64(f[5]) || !is_hex64(f[13]) || !is_decimal(f[10]) || !is_decimal(f[11]) {
            return None;
        }
        let s = StatementFields {
            node: f[2].to_string(),
            device_tag: hex::decode(f[3]).ok()?.try_into().ok()?,
            hw_key: f[5].to_string(),
            platform: Platform::parse(f[6])?,
            prov: Prov::parse(f[7])?,
            trust: Trust::parse(f[8])?,
            op: Op::parse(f[9])?,
            issued_epoch: f[10].parse().ok()?,
            effective_epoch: f[11].parse().ok()?,
            state: DeviceState::parse(f[12])?,
            lease_hash: f[13].to_string(),
        };
        (s.preimage() == text).then_some(s)
    }

    /// hex SHA3-256 of the preimage: the statement's identity in records and votes.
    pub fn hash(&self) -> String {
        hex::encode(sha3_256(self.preimage().as_bytes()))
    }
}

/// `qnet_device_state:v1|{chain_id}|{N}|{state}|{state_seq}|{until_epoch}|{reason}`
pub fn state_preimage(node: &str, state: DeviceState, state_seq: u64, until_epoch: u64, reason: &str) -> String {
    format!("qnet_device_state:v1|{}|{}|{}|{}|{}|{}", chain_id(), node, state.as_str(), state_seq, until_epoch, reason)
}

/// `qnet_crl:v1|{fetched_at}|{hex(sha3(list))}`, `list_text` the canonical list text.
pub fn crl_preimage(fetched_at: u64, list_text: &str) -> String {
    format!("qnet_crl:v1|{}|{}", fetched_at, hex::encode(sha3_256(list_text.as_bytes())))
}

/// The parts of a `ping_hw2:{hex(σ)}.{b64url(device signature)}.{hw_seq}` reply signature.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HwPingWire {
    pub sigma: Vec<u8>,
    pub device_sig: Vec<u8>,
    pub hw_seq: u64,
}

pub fn parse_hwping_wire(signature: &str) -> Option<HwPingWire> {
    let rest = signature.strip_prefix("ping_hw2:")?;
    let mut parts = rest.split('.');
    let (sigma, dev, seq) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || sigma.len() != 3309 * 2 || !is_decimal(seq) || dev.is_empty() || dev.len() > 1024 {
        return None;
    }
    Some(HwPingWire {
        sigma: hex::decode(sigma).ok()?,
        device_sig: b64url_decode(dev)?,
        hw_seq: seq.parse().ok()?,
    })
}

/// A decimal u64 without sign or leading zero.
pub fn is_decimal(s: &str) -> bool {
    !s.is_empty() && s.len() <= 20 && s.bytes().all(|b| b.is_ascii_digit()) && (s == "0" || !s.starts_with('0'))
        && s.parse::<u64>().is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn b64url_is_canonical() {
        let n = [7u8; 32];
        let t = b64url(&n);
        assert_eq!(t.len(), 43);
        assert_eq!(nonce32(&t), Some(n));
        assert!(nonce32(&format!("{}=", t)).is_none());
        assert!(b64url_decode("ab+c").is_none());
        // Non-zero padding bits in the last character are refused.
        let zero = b64url(&[0u8; 32]);
        assert!(zero.ends_with('A'));
        let bad = format!("{}B", &zero[..42]);
        assert!(b64url_decode(&bad).is_none());
        assert!(b64url_decode("A").is_none(), "a length of 1 mod 4");
    }

    #[test]
    fn decimals_and_ids() {
        assert!(is_decimal("0") && is_decimal("1790000000"));
        assert!(!is_decimal("01") && !is_decimal("-1") && !is_decimal("") && !is_decimal("99999999999999999999"));
        assert!(is_device_node_id("light_mobile_6526ab8fd00ff8ca"));
        assert!(!is_device_node_id("light_mobile_6526AB8FD00FF8CA") && !is_device_node_id("light_6526ab8fd00ff8ca"));
    }
}
