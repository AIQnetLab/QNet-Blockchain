//! Preimages, tags and encodings of docs/protocols/light-node-messages.md sections 2, 5 and 6.

use base64::alphabet;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig, STANDARD};
use base64::engine::DecodePaddingMode;
use base64::Engine;
use sha3::{Digest, Sha3_256};

use crate::types::{Effective, Gate, LeaseKind, Platform};

/// b64url without padding; decoding refuses `=`, foreign characters and non-zero padding bits.
const B64URL: GeneralPurpose = GeneralPurpose::new(
    &alphabet::URL_SAFE,
    GeneralPurposeConfig::new()
        .with_encode_padding(false)
        .with_decode_padding_mode(DecodePaddingMode::RequireNone),
);

pub fn b64url(data: &[u8]) -> String {
    B64URL.encode(data)
}

pub fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    B64URL.decode(s).ok()
}

/// b64url as vendors send it: padding optional.
pub fn b64url_decode_lenient(s: &str) -> Option<Vec<u8>> {
    const LENIENT: GeneralPurpose = GeneralPurpose::new(
        &alphabet::URL_SAFE,
        GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
    );
    LENIENT.decode(s).ok()
}

/// Standard base64; line breaks and other whitespace are ignored.
pub fn b64_decode(s: &str) -> Option<Vec<u8>> {
    let compact: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    STANDARD.decode(compact).ok()
}

pub fn b64_encode(data: &[u8]) -> String {
    STANDARD.encode(data)
}

pub fn sha3_256(data: &[u8]) -> [u8; 32] {
    Sha3_256::digest(data).into()
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    let d = aws_lc_rs::digest::digest(&aws_lc_rs::digest::SHA256, data);
    let mut out = [0u8; 32];
    out.copy_from_slice(d.as_ref());
    out
}

pub fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `light_mobile_` followed by 16 lowercase hex characters.
pub fn is_node_id(s: &str) -> bool {
    match s.strip_prefix("light_mobile_") {
        Some(h) => h.len() == 16 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        None => false,
    }
}

/// A 65-byte uncompressed SEC1 P-256 point.
pub fn parse_hw_pub(hex_str: &str) -> Option<Vec<u8>> {
    let b = hex::decode(hex_str).ok()?;
    (b.len() == 65 && b[0] == 0x04).then_some(b)
}

/// `device_tag` = SHA3-256("qnet_device_tag:v1|" ‖ chain_id ‖ "|" ‖ platform byte ‖ hw_pub).
pub fn device_tag(chain_id: &str, platform: Platform, hw_pub: &[u8]) -> [u8; 32] {
    let mut h = Sha3_256::new();
    h.update(b"qnet_device_tag:v1|");
    h.update(chain_id.as_bytes());
    h.update(b"|");
    h.update([platform.byte()]);
    h.update(hw_pub);
    h.finalize().into()
}

/// `ref` = first 8 hex of SHA3-256("qnet_dev_ref:v1|" ‖ nonce ‖ device_tag), `nonce` the 32 challenge bytes.
pub fn reference(nonce: &[u8; 32], device_tag: &[u8; 32]) -> String {
    let mut h = Sha3_256::new();
    h.update(b"qnet_dev_ref:v1|");
    h.update(nonce);
    h.update(device_tag);
    hex::encode(h.finalize())[..8].to_string()
}

pub fn is_reference(s: &str) -> bool {
    s.len() == 8 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[allow(clippy::too_many_arguments)]
pub fn lease_preimage(
    chain_id: &str,
    node: &str,
    device_tag: &[u8; 32],
    lease: LeaseKind,
    effective: Effective,
    gate: Gate,
    pi_digest: &str,
    issued_at: u64,
) -> String {
    format!(
        "qnet_device_lease:v1|{}|{}|{}|{}|{}|{}|{}|{}",
        chain_id,
        node,
        hex::encode(device_tag),
        lease.as_str(),
        effective.as_str(),
        gate.as_str(),
        pi_digest,
        issued_at
    )
}

/// `list_text` is the canonical text of the revocation list (`RevocationList::canonical_text`).
pub fn crl_preimage(fetched_at: u64, list_text: &str) -> String {
    format!("qnet_crl:v1|{}|{}", fetched_at, hex::encode(sha3_256(list_text.as_bytes())))
}

/// The digest a Play Integrity nonce of an enrolment encodes: SHA-256(UTF-8(E) ‖ sha3(hw_pub) ‖ sha3(R)).
/// The app sends it as b64url.
pub fn play_nonce_enrol_digest(preimage: &str, hw_pub: &[u8], report_sha3: &[u8; 32]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(preimage.len() + 64);
    buf.extend_from_slice(preimage.as_bytes());
    buf.extend_from_slice(&sha3_256(hw_pub));
    buf.extend_from_slice(report_sha3);
    sha256(&buf)
}

/// The digest the Play Integrity nonce of every other device message encodes: SHA-256(preimage).
pub fn play_nonce_digest(preimage: &str) -> [u8; 32] {
    sha256(preimage.as_bytes())
}

pub fn play_nonce_enrol(preimage: &str, hw_pub: &[u8], report_sha3: &[u8; 32]) -> String {
    b64url(&play_nonce_enrol_digest(preimage, hw_pub, report_sha3))
}

pub fn play_nonce(preimage: &str) -> String {
    b64url(&play_nonce_digest(preimage))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MsgKind {
    Enrol,
    Rotate,
    Rebind,
    Refresh,
    Release,
}

/// The fields of a device message the oracle needs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceMsg {
    pub kind: MsgKind,
    /// The node the message is for (`N_new` of a rebind).
    pub node: String,
    pub nonce: [u8; 32],
    pub rebind_from: Option<String>,
    /// `hex(sha3(old_hw_pub))` of a rotation.
    pub old_key: Option<String>,
    /// `sha3(R)` from the Android enrolment flags.
    pub report_sha3: Option<[u8; 32]>,
}

/// The iOS enrolment flags of a phone or tablet (spec 5.3); a Mac or Vision flag never reaches a slot.
const IOS_FLAGS: [&str; 2] = ["mac=0,vision=0,idiom=phone", "mac=0,vision=0,idiom=pad"];

fn is_seq(s: &str) -> bool {
    !s.is_empty() && s.len() <= 20 && s.bytes().all(|b| b.is_ascii_digit()) && (s == "0" || !s.starts_with('0'))
}

fn nonce32(s: &str) -> Option<[u8; 32]> {
    let b = b64url_decode(s)?;
    b.try_into().ok()
}

/// Parses and checks a device message of section 5; `None` for anything malformed.
pub fn parse_device_message(p: &str, chain_id: &str) -> Option<DeviceMsg> {
    if p.len() > 2048 || p.bytes().any(|b| b <= b' ' || b >= 0x7f) {
        return None;
    }
    let f: Vec<&str> = p.split('|').collect();
    if f.len() < 2 || f[1] != chain_id {
        return None;
    }
    let msg = match (f[0], f.len()) {
        ("qnet_dev_enrol:v1", 8) => {
            // f: tag|chain|N|W|pp|seq|nonce|flags
            if !is_node_id(f[2]) || !is_hex64(f[4]) || !is_seq(f[5]) || f[3].is_empty() || f[3].len() > 64 {
                return None;
            }
            let report_sha3 = match f[7].strip_prefix("r=") {
                Some(h) if is_hex64(h) => Some(hex::decode(h).ok()?.try_into().ok()?),
                Some(_) => return None,
                None if IOS_FLAGS.contains(&f[7]) => None,
                None => return None,
            };
            DeviceMsg {
                kind: MsgKind::Enrol,
                node: f[2].to_string(),
                nonce: nonce32(f[6])?,
                rebind_from: None,
                old_key: None,
                report_sha3,
            }
        }
        ("qnet_dev_rotate:v1", 7) => {
            if !is_node_id(f[2]) || !is_hex64(f[3]) || !is_hex64(f[4]) || !is_seq(f[5]) {
                return None;
            }
            DeviceMsg {
                kind: MsgKind::Rotate,
                node: f[2].to_string(),
                nonce: nonce32(f[6])?,
                rebind_from: None,
                old_key: Some(f[3].to_string()),
                report_sha3: None,
            }
        }
        ("qnet_dev_rebind:v1", 6) => {
            if !is_node_id(f[2]) || !is_node_id(f[3]) || f[2] == f[3] || !is_seq(f[4]) {
                return None;
            }
            DeviceMsg {
                kind: MsgKind::Rebind,
                node: f[3].to_string(),
                nonce: nonce32(f[5])?,
                rebind_from: Some(f[2].to_string()),
                old_key: None,
                report_sha3: None,
            }
        }
        ("qnet_dev_refresh:v1", 4) => {
            if !is_node_id(f[2]) {
                return None;
            }
            DeviceMsg {
                kind: MsgKind::Refresh,
                node: f[2].to_string(),
                nonce: nonce32(f[3])?,
                rebind_from: None,
                old_key: None,
                report_sha3: None,
            }
        }
        ("qnet_dev_release:v1", 5) => {
            if !is_node_id(f[2]) || !is_seq(f[3]) {
                return None;
            }
            DeviceMsg {
                kind: MsgKind::Release,
                node: f[2].to_string(),
                nonce: nonce32(f[4])?,
                rebind_from: None,
                old_key: None,
                report_sha3: None,
            }
        }
        _ => return None,
    };
    Some(msg)
}

/// Minimal PEM body decoder for one block with the given label.
pub fn pem_decode(text: &str, label: &str) -> Option<Vec<u8>> {
    let begin = format!("-----BEGIN {}-----", label);
    let end = format!("-----END {}-----", label);
    let start = text.find(&begin)? + begin.len();
    let stop = text[start..].find(&end)? + start;
    let body: String = text[start..stop].chars().filter(|c| !c.is_whitespace()).collect();
    STANDARD.decode(body).ok()
}
