//! The device block of `/light-node/bind` (spec sections 5.3 and 5.5) and its verification with the shared
//! verifier `qnet-device-attest`, which the device oracle runs too.
//!
//! Eligibility is the evidence's own: a phone or tablet whose secure hardware holds the key, the store app,
//! a verified boot, the main profile. There is no operating-system version minimum (owner decision O1).
//! Android factory-provisioned chains are accepted; they are `prov = factory`, which the oracle leases for
//! one day and limits per key, and they carry no attestation-key index (one is shared by a batch of
//! devices). Every refusal is one of the stable `device_*` reasons.

use qnet_device_attest as qda;

use super::{messages, DeviceReason, Platform, Prov, Trust};

/// Largest parts of a device block the node reads (decoded bytes).
const MAX_ATTESTATION: usize = 16 * 1024;
const MAX_ASSERTION: usize = 1024;
const MAX_CERT: usize = 8 * 1024;
const MAX_CHAIN: usize = 8;
const MAX_REPORT: usize = 512;
const MAX_DEVICE_SIG: usize = 1024;

/// The rules of this network: store builds only on mainnet; builds signed with the developer's own key
/// too on testnet, so a locally built app runs the whole flow.
#[derive(Clone, Debug)]
pub struct Policies {
    pub ios: qda::apple::IosPolicy,
    pub android: qda::android::AndroidPolicy,
    pub play: qda::play::PlayPolicy,
    pub mainnet: bool,
}

impl Policies {
    pub fn for_network(mainnet: bool) -> Self {
        if mainnet {
            Policies {
                ios: qda::apple::IosPolicy::mainnet(),
                android: qda::android::AndroidPolicy::mainnet(),
                play: qda::play::PlayPolicy::mainnet(),
                mainnet,
            }
        } else {
            Policies {
                ios: qda::apple::IosPolicy::testnet(),
                android: qda::android::AndroidPolicy::testnet(),
                play: qda::play::PlayPolicy::testnet(),
                mainnet,
            }
        }
    }
}

/// What a device block carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Evidence {
    /// iOS: a new App Attest key attested over SHA-256 of the preimage.
    IosAttestation { key_id: [u8; 32], attestation: Vec<u8> },
    /// iOS: a key the attestors already hold, asserting over SHA-256 of the preimage.
    IosAssertion { key_id: [u8; 32], assertion: Vec<u8> },
    /// Android: a new Keystore key whose attestation challenge is SHA-256 of the preimage, and its signed
    /// device report.
    Android { chain: Vec<Vec<u8>>, report: String, report_sig: Vec<u8> },
    /// Another wallet's node in the same install (section 5.5): the device key of `from` and the new
    /// wallet's key sign the rebind message.
    Rebind { from: String, sig: Vec<u8>, wallet_sig: String },
}

/// A parsed device block with its challenge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceBlock {
    pub platform: Platform,
    pub evidence: Evidence,
    /// iOS enrolment flags (`mac=0,vision=0,idiom=…`); empty otherwise.
    pub flags: String,
    pub nonce: String,
    pub stamp: String,
}

impl DeviceBlock {
    /// The flags the enrolment preimage carries.
    pub fn preimage_flags(&self) -> String {
        match &self.evidence {
            Evidence::Android { report, .. } => messages::android_flags(report),
            _ => self.flags.clone(),
        }
    }

    pub fn nonce_bytes(&self) -> [u8; 32] {
        messages::nonce32(&self.nonce).unwrap_or([0; 32])
    }

    /// The public evidence, as the oracle seals it for appeals (never logged).
    pub fn evidence_json(&self) -> serde_json::Value {
        match &self.evidence {
            Evidence::IosAttestation { attestation, .. } =>
                serde_json::json!({ "platform": "ios", "attestation": messages::b64url(attestation), "flags": self.flags }),
            Evidence::IosAssertion { .. } => serde_json::json!({ "platform": "ios", "assertion": true, "flags": self.flags }),
            Evidence::Android { chain, report, .. } => serde_json::json!({
                "platform": "android", "chain": chain.iter().map(|c| messages::b64url(c)).collect::<Vec<_>>(), "report": report,
            }),
            Evidence::Rebind { from, .. } => serde_json::json!({ "platform": self.platform.as_str(), "rebind_from": from }),
        }
    }
}

fn b64_field(v: &serde_json::Value, key: &str, max: usize) -> Result<Vec<u8>, DeviceReason> {
    let s = v.get(key).and_then(|x| x.as_str()).ok_or(DeviceReason::NotGenuine)?;
    if s.is_empty() || s.len() > max * 4 / 3 + 4 { return Err(DeviceReason::NotGenuine); }
    let b = messages::b64url_decode(s).ok_or(DeviceReason::NotGenuine)?;
    if b.is_empty() || b.len() > max { return Err(DeviceReason::NotGenuine); }
    Ok(b)
}

/// Parse the `device` field of `/bind`. A block that is not one of the spec's forms is `device_not_genuine`,
/// the verifier's answer for malformed evidence; iOS flags that name a Mac or a headset are `device_desktop`.
pub fn parse_block(v: &serde_json::Value) -> Result<DeviceBlock, DeviceReason> {
    parse_block_as(v, false)
}

/// Parse the new key's block of a rotation (section 5.4): a newly attested key only, the iOS flags optional.
pub fn parse_rotation_block(v: &serde_json::Value) -> Result<DeviceBlock, DeviceReason> {
    parse_block_as(v, true)
}

fn parse_block_as(v: &serde_json::Value, rotation: bool) -> Result<DeviceBlock, DeviceReason> {
    let str_field = |k: &str| v.get(k).and_then(|x| x.as_str());
    let platform = str_field("platform").and_then(Platform::parse).ok_or(DeviceReason::NotGenuine)?;
    let nonce = str_field("nonce").filter(|n| messages::nonce32(n).is_some()).ok_or(DeviceReason::Stale)?.to_string();
    let stamp = str_field("stamp").filter(|s| !s.is_empty() && s.len() <= 512).ok_or(DeviceReason::Stale)?.to_string();
    let mut flags = String::new();
    if rotation && (v.get("rebind_from").is_some() || v.get("assertion").is_some()) {
        return Err(DeviceReason::NotGenuine);
    }
    let evidence = if let Some(from) = str_field("rebind_from") {
        if !messages::is_device_node_id(from) { return Err(DeviceReason::NotGenuine); }
        let wallet_sig = str_field("wallet_sig").unwrap_or("");
        let hex_ok = wallet_sig.len() == crate::light_binding::MLDSA65_SIG_HEX
            && wallet_sig.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if !hex_ok { return Err(DeviceReason::NotGenuine); }
        Evidence::Rebind { from: from.to_string(), sig: b64_field(v, "sig", MAX_DEVICE_SIG)?, wallet_sig: wallet_sig.to_string() }
    } else {
        match platform {
            Platform::Ios => {
                flags = match str_field("flags") {
                    None if rotation => String::new(),
                    f => f.filter(|f| f.len() <= 64).ok_or(DeviceReason::NotGenuine)?.to_string(),
                };
                if !(rotation && flags.is_empty()) {
                    qda::apple::parse_flags(&flags).map_err(|r| DeviceReason::from_evidence(r.reason()))?;
                }
                let key_id: [u8; 32] = b64_field(v, "key_id", 32)?.try_into().map_err(|_| DeviceReason::NotGenuine)?;
                match (v.get("attestation"), v.get("assertion")) {
                    (Some(_), None) => Evidence::IosAttestation { key_id, attestation: b64_field(v, "attestation", MAX_ATTESTATION)? },
                    (None, Some(_)) => Evidence::IosAssertion { key_id, assertion: b64_field(v, "assertion", MAX_ASSERTION)? },
                    _ => return Err(DeviceReason::NotGenuine),
                }
            }
            Platform::Android => {
                let chain = v.get("chain").and_then(|c| c.as_array()).ok_or(DeviceReason::NotGenuine)?;
                if chain.len() < 3 || chain.len() > MAX_CHAIN { return Err(DeviceReason::NotGenuine); }
                let chain = chain.iter().map(|c| {
                    let s = c.as_str().ok_or(DeviceReason::NotGenuine)?;
                    let b = messages::b64url_decode(s).ok_or(DeviceReason::NotGenuine)?;
                    if b.is_empty() || b.len() > MAX_CERT { Err(DeviceReason::NotGenuine) } else { Ok(b) }
                }).collect::<Result<Vec<_>, _>>()?;
                let report = str_field("report").filter(|r| r.len() <= MAX_REPORT).ok_or(DeviceReason::NotGenuine)?.to_string();
                Evidence::Android { chain, report, report_sig: b64_field(v, "report_sig", MAX_DEVICE_SIG)? }
            }
        }
    };
    Ok(DeviceBlock { platform, evidence, flags, nonce, stamp })
}

/// What verified evidence proves about a device key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedDevice {
    pub platform: Platform,
    pub hw_pub: [u8; 65],
    pub prov: Prov,
    pub trust: Trust,
    /// hex(sha3(attestation key)) of a remotely provisioned Android chain: one live node per such key.
    pub att_key: Option<String>,
    pub certs_issued: Option<u64>,
    /// Serials of the Android chain below the root, for the revocation check of every epoch.
    pub serials: Vec<String>,
    /// iOS: the ATTEST receipt of a new key, for the oracle's risk-metric exchange.
    pub receipt: Option<Vec<u8>>,
    /// iOS: the assertion counter (0 right after the attestation).
    pub counter: u32,
    /// A newly attested key (not one the records already hold).
    pub fresh: bool,
}

impl VerifiedDevice {
    pub fn hw_key(&self) -> String {
        hex::encode(messages::sha3_256(&self.hw_pub))
    }

    pub fn key_id(&self) -> [u8; 32] {
        messages::sha256(&self.hw_pub)
    }

    pub fn device_tag(&self) -> [u8; 32] {
        messages::device_tag(self.platform, &self.hw_pub)
    }
}

/// Why evidence was refused: the wire reason and the verifier's precise code (for logs; no evidence bytes).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvidenceRefusal {
    pub reason: DeviceReason,
    pub code: &'static str,
}

impl From<qda::Refusal> for EvidenceRefusal {
    fn from(r: qda::Refusal) -> Self {
        EvidenceRefusal { reason: DeviceReason::from_evidence(r.reason()), code: r.code() }
    }
}

/// Verification of a newly attested key over `preimage` at Unix time `now`.
pub type AttestFn = fn(&Policies, &DeviceBlock, &str, u64, &qda::revocation::RevocationList)
    -> Result<VerifiedDevice, EvidenceRefusal>;

/// The node's evidence verifier: the network's policies and the vendor-rooted check of a new key.
pub struct Verifier {
    pub policies: Policies,
    pub attest: AttestFn,
}

impl Verifier {
    pub fn production() -> &'static Verifier {
        static V: std::sync::OnceLock<Verifier> = std::sync::OnceLock::new();
        V.get_or_init(|| Verifier { policies: Policies::for_network(super::is_mainnet()), attest: attest_with_vendor_roots })
    }

    /// A new key's evidence (iOS attestation, Android chain and report) over `preimage`.
    pub fn verify_new_key(&self, block: &DeviceBlock, preimage: &str, now: u64) -> Result<VerifiedDevice, EvidenceRefusal> {
        (self.attest)(&self.policies, block, preimage, now, &revocation_list())
    }

    /// A key the records hold signs `preimage`: an iOS assertion whose counter exceeds `last_counter`, or an
    /// Android DER signature. Returns the iOS counter (0 on Android).
    pub fn verify_known_key(&self, platform: Platform, hw_pub: &[u8], device_sig: &[u8], preimage: &str, last_counter: u64)
        -> Result<u32, EvidenceRefusal>
    {
        let key = qda::DevicePublicKey::from_sec1(hw_pub)?;
        match platform {
            Platform::Ios => {
                let last = u32::try_from(last_counter).unwrap_or(u32::MAX);
                let a = qda::apple::verify_assertion(device_sig, &key, &self.policies.ios.app_id,
                                                      &messages::sha256(preimage.as_bytes()), last)?;
                Ok(a.counter)
            }
            Platform::Android => {
                key.verify_der(preimage.as_bytes(), device_sig)?;
                Ok(0)
            }
        }
    }
}

/// The production check of a new key against the pinned Apple and Google roots.
fn attest_with_vendor_roots(p: &Policies, block: &DeviceBlock, preimage: &str, now: u64,
                            revoked: &qda::revocation::RevocationList) -> Result<VerifiedDevice, EvidenceRefusal> {
    let challenge = messages::sha256(preimage.as_bytes());
    match &block.evidence {
        Evidence::IosAttestation { key_id, attestation } => {
            let v = qda::apple::verify_attestation(attestation, key_id, &challenge, &p.ios, now as i64)?;
            if crate::node::is_info() {
                // Signals only (undocumented leaf fields); no key, no evidence.
                println!("[INFO][DEVICE] ios_attestation category={:?} platform={:?}", v.validation_category, v.platform);
            }
            let hw_pub: [u8; 65] = *v.public_key.as_bytes();
            Ok(VerifiedDevice {
                platform: Platform::Ios, hw_pub, prov: Prov::Na, trust: v.trust.into(), att_key: None, certs_issued: None,
                serials: Vec::new(), receipt: Some(v.receipt), counter: 0, fresh: true,
            })
        }
        Evidence::Android { chain, report, report_sig } => {
            let certs: Vec<&[u8]> = chain.iter().map(|c| c.as_slice()).collect();
            let v = qda::android::verify_key_attestation(&certs, &challenge, &p.android, revoked, now as i64)?;
            qda::report::verify_device_report(report, report_sig, &v.public_key)?;
            let prov: Prov = v.provisioning.into();
            Ok(VerifiedDevice {
                platform: Platform::Android,
                hw_pub: *v.public_key.as_bytes(),
                prov,
                trust: v.trust.into(),
                att_key: (prov == Prov::Rkp).then(|| hex::encode(messages::sha3_256(&v.attestation_key))),
                certs_issued: v.provisioning_info.as_ref().and_then(|i| i.certs_issued),
                serials: v.serials,
                receipt: None,
                counter: 0,
                fresh: true,
            })
        }
        Evidence::IosAssertion { .. } | Evidence::Rebind { .. } =>
            Err(EvidenceRefusal { reason: DeviceReason::NotGenuine, code: "not_a_new_key" }),
    }
}

/// The attestation status list the chains are checked against: the oracle's signed snapshot once the
/// revocation task holds one (`crl`), empty before.
pub fn revocation_list() -> qda::revocation::RevocationList {
    REVOCATIONS.read().clone()
}

pub fn set_revocation_list(list: qda::revocation::RevocationList) {
    *REVOCATIONS.write() = list;
}

/// The list this genesis holds names one of `serials` (a stored chain's): read under the lock, no copy.
pub fn revoked_any(serials: &[String]) -> bool {
    if serials.is_empty() { return false; }
    let list = REVOCATIONS.read();
    !list.is_empty() && serials.iter().any(|s| list.contains(s))
}

static REVOCATIONS: once_cell::sync::Lazy<parking_lot::RwLock<qda::revocation::RevocationList>> =
    once_cell::sync::Lazy::new(|| parking_lot::RwLock::new(qda::revocation::RevocationList::default()));

#[cfg(test)]
mod tests {
    use super::*;

    fn ios_block(extra: serde_json::Value) -> serde_json::Value {
        let mut v = serde_json::json!({
            "platform": "ios", "key_id": messages::b64url(&[1u8; 32]), "attestation": messages::b64url(&[2u8; 64]),
            "flags": "mac=0,vision=0,idiom=phone", "nonce": messages::b64url(&[3u8; 32]), "stamp": "v1.1.x",
        });
        for (k, x) in extra.as_object().unwrap() { v[k] = x.clone(); }
        v
    }

    #[test]
    fn the_spec_forms_parse_and_nothing_else() {
        let b = parse_block(&ios_block(serde_json::json!({}))).unwrap();
        assert!(matches!(b.evidence, Evidence::IosAttestation { .. }));
        assert_eq!(b.preimage_flags(), "mac=0,vision=0,idiom=phone");
        // A Mac or a headset names itself in the flags.
        assert_eq!(parse_block(&ios_block(serde_json::json!({"flags": "mac=1,vision=0,idiom=pad"}))), Err(DeviceReason::Desktop));
        assert_eq!(parse_block(&ios_block(serde_json::json!({"flags": "mac=0,vision=1,idiom=pad"}))), Err(DeviceReason::Desktop));
        assert_eq!(parse_block(&ios_block(serde_json::json!({"flags": "idiom=tv"}))), Err(DeviceReason::NotGenuine));
        // Both an attestation and an assertion, or neither.
        assert_eq!(parse_block(&ios_block(serde_json::json!({"assertion": "AAAA"}))), Err(DeviceReason::NotGenuine));
        // A nonce that is not 32 b64url bytes, or no stamp: out of date, ask again.
        assert_eq!(parse_block(&ios_block(serde_json::json!({"nonce": "short"}))), Err(DeviceReason::Stale));
        assert_eq!(parse_block(&ios_block(serde_json::json!({"stamp": ""}))), Err(DeviceReason::Stale));
        assert_eq!(parse_block(&ios_block(serde_json::json!({"platform": "windows"}))), Err(DeviceReason::NotGenuine));
        assert_eq!(parse_block(&ios_block(serde_json::json!({"key_id": "AAAA"}))), Err(DeviceReason::NotGenuine));

        let report = "{\"arc\":false,\"automotive\":false,\"embedded\":false,\"feature_pc\":false,\"hsum\":false,\"leanback\":false,\"system_user\":true,\"touchscreen\":true,\"watch\":false}";
        let android = serde_json::json!({
            "platform": "android", "chain": [messages::b64url(&[1]), messages::b64url(&[2]), messages::b64url(&[3])],
            "report": report, "report_sig": messages::b64url(&[4u8; 70]),
            "nonce": messages::b64url(&[3u8; 32]), "stamp": "v1.1.x",
        });
        let b = parse_block(&android).unwrap();
        assert_eq!(b.preimage_flags(), messages::android_flags(report));
        let mut short = android.clone();
        short["chain"] = serde_json::json!([messages::b64url(&[1])]);
        assert_eq!(parse_block(&short), Err(DeviceReason::NotGenuine));

        let rebind = serde_json::json!({
            "platform": "ios", "rebind_from": "light_mobile_6526ab8fd00ff8ca", "sig": messages::b64url(&[5u8; 70]),
            "wallet_sig": "ab".repeat(3309), "nonce": messages::b64url(&[3u8; 32]), "stamp": "v1.1.x",
        });
        assert!(matches!(parse_block(&rebind).unwrap().evidence, Evidence::Rebind { .. }));
        let mut bad = rebind.clone();
        bad["wallet_sig"] = serde_json::json!("ab");
        assert_eq!(parse_block(&bad), Err(DeviceReason::NotGenuine));

        // A rotation's new key: the iOS flags are optional, and it is never an assertion or a rebind.
        let mut rot = ios_block(serde_json::json!({}));
        rot.as_object_mut().unwrap().remove("flags");
        assert!(matches!(parse_rotation_block(&rot).unwrap().evidence, Evidence::IosAttestation { .. }));
        assert_eq!(parse_block(&rot), Err(DeviceReason::NotGenuine), "an enrolment names its flags");
        assert_eq!(parse_rotation_block(&ios_block(serde_json::json!({"flags": "mac=1,vision=0,idiom=pad"}))), Err(DeviceReason::Desktop));
        let mut asserted = rot.clone();
        asserted.as_object_mut().unwrap().remove("attestation");
        asserted["assertion"] = serde_json::json!(messages::b64url(&[1u8; 40]));
        assert_eq!(parse_rotation_block(&asserted), Err(DeviceReason::NotGenuine));
        assert_eq!(parse_rotation_block(&rebind), Err(DeviceReason::NotGenuine));
        assert!(parse_rotation_block(&android).is_ok());
    }

    #[test]
    fn a_new_key_is_checked_against_the_vendor_roots() {
        // Junk evidence never passes the production verifier, and its refusal is a stable reason.
        let v = Verifier { policies: Policies::for_network(true), attest: attest_with_vendor_roots };
        let b = parse_block(&ios_block(serde_json::json!({}))).unwrap();
        let r = v.verify_new_key(&b, "qnet_dev_enrol:v1|1337|x", 1_800_000_000).unwrap_err();
        assert_eq!(r.reason, DeviceReason::NotGenuine);
        // Mainnet takes store builds only; testnet also the developer's own.
        assert!(!Policies::for_network(true).ios.allow_development && Policies::for_network(false).ios.allow_development);
        assert!(!Policies::for_network(true).android.allow_test && Policies::for_network(false).android.allow_test);
        // O1: factory-provisioned Android chains are accepted on both networks.
        assert!(Policies::for_network(true).android.allow_factory && Policies::for_network(false).android.allow_factory);
    }
}
