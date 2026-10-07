//! Test builders: a DER and CBOR writer, throwaway keys, and synthetic evidence chained to a test
//! root, for the rules the vendor samples cannot reach.

use ring::rand::SystemRandom;
use ring::signature::{self, EcdsaKeyPair, KeyPair};

pub mod der {
    fn len(n: usize) -> Vec<u8> {
        if n < 0x80 {
            vec![n as u8]
        } else {
            let bytes: Vec<u8> = n.to_be_bytes().iter().copied().skip_while(|&b| b == 0).collect();
            let mut out = vec![0x80 | bytes.len() as u8];
            out.extend(bytes);
            out
        }
    }

    pub fn tlv(tag: &[u8], content: &[u8]) -> Vec<u8> {
        let mut out = tag.to_vec();
        out.extend(len(content.len()));
        out.extend_from_slice(content);
        out
    }

    fn cat(parts: &[&[u8]]) -> Vec<u8> {
        parts.iter().flat_map(|p| p.iter().copied()).collect()
    }

    pub fn seq(parts: &[&[u8]]) -> Vec<u8> {
        tlv(&[0x30], &cat(parts))
    }

    pub fn set(parts: &[&[u8]]) -> Vec<u8> {
        tlv(&[0x31], &cat(parts))
    }

    pub fn uint(n: u64) -> Vec<u8> {
        let mut bytes: Vec<u8> = n.to_be_bytes().iter().copied().skip_while(|&b| b == 0).collect();
        if bytes.first().is_none_or(|b| b & 0x80 != 0) {
            bytes.insert(0, 0);
        }
        tlv(&[0x02], &bytes)
    }

    pub fn enumerated(n: u64) -> Vec<u8> {
        let mut v = uint(n);
        v[0] = 0x0a;
        v
    }

    pub fn oid(content: &[u8]) -> Vec<u8> {
        tlv(&[0x06], content)
    }

    pub fn octets(b: &[u8]) -> Vec<u8> {
        tlv(&[0x04], b)
    }

    pub fn bits(b: &[u8]) -> Vec<u8> {
        let mut c = vec![0];
        c.extend_from_slice(b);
        tlv(&[0x03], &c)
    }

    pub fn null() -> Vec<u8> {
        vec![0x05, 0x00]
    }

    pub fn boolean(byte: u8) -> Vec<u8> {
        vec![0x01, 0x01, byte]
    }

    pub fn utf8(s: &str) -> Vec<u8> {
        tlv(&[0x0c], s.as_bytes())
    }

    /// `[n]` with the constructed bit, in the high-tag form when `n >= 31`.
    pub fn ctx(n: u32, content: &[u8]) -> Vec<u8> {
        let tag = if n < 31 {
            vec![0xa0 | n as u8]
        } else {
            let mut groups = vec![(n & 0x7f) as u8];
            let mut rest = n >> 7;
            while rest > 0 {
                groups.push(0x80 | (rest & 0x7f) as u8);
                rest >>= 7;
            }
            groups.push(0xbf);
            groups.reverse();
            groups
        };
        tlv(&tag, content)
    }

    pub fn civil(days: i64) -> (i64, u32, u32) {
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
        let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
        (yoe + era * 400 + if m <= 2 { 1 } else { 0 }, m, d)
    }

    pub fn time(unix: i64) -> Vec<u8> {
        let (y, m, d) = civil(unix.div_euclid(86_400));
        let s = unix.rem_euclid(86_400);
        let text = format!("{:04}{:02}{:02}{:02}{:02}{:02}Z", y, m, d, s / 3600, s % 3600 / 60, s % 60);
        tlv(&[0x18], text.as_bytes())
    }

    /// A Name of UTF8String attributes.
    pub fn name(attrs: &[(&[u8], &str)]) -> Vec<u8> {
        let rdns: Vec<Vec<u8>> = attrs.iter().map(|(o, v)| set(&[&seq(&[&oid(o), &utf8(v)])])).collect();
        let refs: Vec<&[u8]> = rdns.iter().map(Vec::as_slice).collect();
        seq(&refs)
    }
}

pub mod cbor {
    #[derive(Clone, Debug)]
    pub enum C {
        U(u64),
        N(i64),
        B(Vec<u8>),
        T(String),
        A(Vec<C>),
        M(Vec<(C, C)>),
    }

    fn head(major: u8, n: u64, out: &mut Vec<u8>) {
        let m = major << 5;
        if n < 24 {
            out.push(m | n as u8);
        } else if n < 0x100 {
            out.extend([m | 24, n as u8]);
        } else if n < 0x10000 {
            out.push(m | 25);
            out.extend((n as u16).to_be_bytes());
        } else {
            out.push(m | 26);
            out.extend((n as u32).to_be_bytes());
        }
    }

    pub fn enc(c: &C) -> Vec<u8> {
        let mut out = Vec::new();
        match c {
            C::U(n) => head(0, *n, &mut out),
            C::N(n) => head(1, (-1 - n) as u64, &mut out),
            C::B(b) => {
                head(2, b.len() as u64, &mut out);
                out.extend(b);
            }
            C::T(t) => {
                head(3, t.len() as u64, &mut out);
                out.extend(t.as_bytes());
            }
            C::A(items) => {
                head(4, items.len() as u64, &mut out);
                for i in items {
                    out.extend(enc(i));
                }
            }
            C::M(entries) => {
                head(5, entries.len() as u64, &mut out);
                for (k, v) in entries {
                    out.extend(enc(k));
                    out.extend(enc(v));
                }
            }
        }
        out
    }

    pub fn t(s: &str) -> C {
        C::T(s.to_string())
    }
}

const OID_EC: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
const OID_P256: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
const OID_P384: &[u8] = &[0x2b, 0x81, 0x04, 0x00, 0x22];
const OID_ECDSA_SHA256: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02];
const OID_ECDSA_SHA384: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x03];
pub const OID_CN: &[u8] = &[0x55, 0x04, 0x03];
pub const OID_O: &[u8] = &[0x55, 0x04, 0x0a];
pub const OID_SERIAL: &[u8] = &[0x55, 0x04, 0x05];

pub struct Key {
    pair: EcdsaKeyPair,
    p384: bool,
}

impl Key {
    fn generate(alg: &'static signature::EcdsaSigningAlgorithm, p384: bool) -> Key {
        let rng = SystemRandom::new();
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(alg, &rng).unwrap();
        Key { pair: EcdsaKeyPair::from_pkcs8(alg, pkcs8.as_ref(), &rng).unwrap(), p384 }
    }

    pub fn p256() -> Key {
        Self::generate(&signature::ECDSA_P256_SHA256_ASN1_SIGNING, false)
    }

    pub fn p384() -> Key {
        Self::generate(&signature::ECDSA_P384_SHA384_ASN1_SIGNING, true)
    }

    pub fn public(&self) -> &[u8] {
        self.pair.public_key().as_ref()
    }

    pub fn spki(&self) -> Vec<u8> {
        let curve = if self.p384 { OID_P384 } else { OID_P256 };
        der::seq(&[&der::seq(&[&der::oid(OID_EC), &der::oid(curve)]), &der::bits(self.public())])
    }

    fn sig_alg(&self) -> Vec<u8> {
        der::seq(&[&der::oid(if self.p384 { OID_ECDSA_SHA384 } else { OID_ECDSA_SHA256 })])
    }

    pub fn sign(&self, msg: &[u8]) -> Vec<u8> {
        self.pair.sign(&SystemRandom::new(), msg).unwrap().as_ref().to_vec()
    }
}

pub struct CertSpec {
    pub serial: u64,
    pub issuer: Vec<u8>,
    pub subject: Vec<u8>,
    pub not_before: i64,
    pub not_after: i64,
    pub spki: Vec<u8>,
    pub extensions: Vec<(Vec<u8>, Vec<u8>)>,
}

pub fn cert(spec: &CertSpec, signer: &Key) -> Vec<u8> {
    let alg = signer.sig_alg();
    let exts: Vec<Vec<u8>> = spec.extensions.iter().map(|(o, v)| der::seq(&[&der::oid(o), &der::octets(v)])).collect();
    let ext_refs: Vec<&[u8]> = exts.iter().map(Vec::as_slice).collect();
    let mut tbs_parts: Vec<Vec<u8>> = vec![
        der::ctx(0, &der::uint(2)),
        der::uint(spec.serial),
        alg.clone(),
        spec.issuer.clone(),
        der::seq(&[&der::time(spec.not_before), &der::time(spec.not_after)]),
        spec.subject.clone(),
        spec.spki.clone(),
    ];
    if !exts.is_empty() {
        tbs_parts.push(der::ctx(3, &der::seq(&ext_refs)));
    }
    let refs: Vec<&[u8]> = tbs_parts.iter().map(Vec::as_slice).collect();
    let tbs = der::seq(&refs);
    let sig = signer.sign(&tbs);
    der::seq(&[&tbs, &alg, &der::bits(&sig)])
}

fn sha256(b: &[u8]) -> [u8; 32] {
    crate::crypto::sha256(b)
}

pub mod apple {
    use super::cbor::{enc, t, C};
    use super::*;

    pub const APP_ID: &str = "ABCDE12345.com.qnetmobile";
    pub const NOW: i64 = 1_790_000_000;
    const OID_NONCE: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x08, 0x02];
    const OID_OS_INFO: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x08, 0x07];

    #[derive(Clone, Debug)]
    pub struct Options {
        pub fmt: String,
        pub aaguid: [u8; 16],
        pub counter: u32,
        pub credential_id: Option<Vec<u8>>,
        pub cose_mismatch: bool,
        pub category: Option<u32>,
        pub bundle_version: Option<String>,
        pub app_id: String,
        pub flags: u8,
        pub trailing: Vec<u8>,
        pub wrong_nonce: bool,
        pub leaf_p384: bool,
        pub leaf_expired: bool,
        pub extra_x5c: bool,
        pub issuer_name_mismatch: bool,
        pub platform: String,
    }

    impl Default for Options {
        fn default() -> Self {
            Options {
                fmt: "apple-appattest".into(),
                aaguid: *b"appattest\0\0\0\0\0\0\0",
                counter: 0,
                credential_id: None,
                cose_mismatch: false,
                category: Some(4),
                bundle_version: Some("20".into()),
                app_id: APP_ID.into(),
                flags: 0x40,
                trailing: Vec::new(),
                wrong_nonce: false,
                leaf_p384: false,
                leaf_expired: false,
                extra_x5c: false,
                issuer_name_mismatch: false,
                platform: "iphoneos".into(),
            }
        }
    }

    pub struct Fixture {
        pub root_der: Vec<u8>,
        pub object: Vec<u8>,
        pub key_id: [u8; 32],
        pub client_data_hash: [u8; 32],
    }

    impl Fixture {
        pub fn build(o: &Options) -> Fixture {
            let root_key = Key::p384();
            let ca_key = Key::p384();
            let leaf_key = if o.leaf_p384 { Key::p384() } else { Key::p256() };
            let root_name = der::name(&[(OID_CN, "Test App Attestation Root")]);
            let ca_name = der::name(&[(OID_CN, "Test App Attestation CA")]);
            let root_der = cert(
                &CertSpec {
                    serial: 1,
                    issuer: root_name.clone(),
                    subject: root_name.clone(),
                    not_before: NOW - 1000 * 86_400,
                    not_after: NOW + 1000 * 86_400,
                    spki: root_key.spki(),
                    extensions: vec![],
                },
                &root_key,
            );
            let ca_der = cert(
                &CertSpec {
                    serial: 2,
                    issuer: root_name,
                    subject: ca_name.clone(),
                    not_before: NOW - 100 * 86_400,
                    not_after: NOW + 100 * 86_400,
                    spki: ca_key.spki(),
                    extensions: vec![],
                },
                &root_key,
            );

            let point = leaf_key.public().to_vec();
            let key_id = sha256(&point);
            let half = (point.len() - 1) / 2;
            let mut x = point[1..1 + half].to_vec();
            let y = point[1 + half..].to_vec();
            if o.cose_mismatch {
                x[0] ^= 1;
            }
            let cose = C::M(vec![
                (C::U(1), C::U(2)),
                (C::U(3), C::N(-7)),
                (C::N(-1), C::U(1)),
                (C::N(-2), C::B(x)),
                (C::N(-3), C::B(y)),
            ]);
            let cred = o.credential_id.clone().unwrap_or_else(|| key_id.to_vec());
            let mut auth = sha256(o.app_id.as_bytes()).to_vec();
            auth.push(o.flags);
            auth.extend(o.counter.to_be_bytes());
            auth.extend(o.aaguid);
            auth.extend((cred.len() as u16).to_be_bytes());
            auth.extend(&cred);
            auth.extend(enc(&cose));
            let mut ext = Vec::new();
            if let Some(v) = &o.bundle_version {
                ext.push((t("apple_bundle_version_01"), C::T(v.clone())));
            }
            if let Some(c) = o.category {
                ext.push((t("apple_validation_category_01"), C::B(c.to_le_bytes().to_vec())));
            }
            if !ext.is_empty() {
                auth.extend(enc(&C::M(ext)));
            }
            auth.extend(&o.trailing);

            let client_data_hash = sha256(b"qnet test challenge");
            let mut nonce = crate::crypto::sha256_two(&auth, &client_data_hash);
            if o.wrong_nonce {
                nonce[0] ^= 1;
            }
            let nonce_ext = der::seq(&[&der::ctx(1, &der::octets(&nonce))]);
            let os_ext = der::seq(&[
                &der::ctx(1400, &der::octets(b"26.0")),
                &der::ctx(1104, &der::uint(2)),
                &der::ctx(1403, &der::octets(b"23A341")),
                &der::ctx(1026, &der::octets(o.platform.as_bytes())),
            ]);
            let (nb, na) =
                if o.leaf_expired { (NOW - 5 * 86_400, NOW - 2 * 86_400) } else { (NOW - 86_400, NOW + 2 * 86_400) };
            let leaf_issuer = if o.issuer_name_mismatch { der::name(&[(OID_CN, "Someone Else")]) } else { ca_name };
            let leaf_der = cert(
                &CertSpec {
                    serial: 3,
                    issuer: leaf_issuer,
                    subject: der::name(&[(OID_CN, "leaf")]),
                    not_before: nb,
                    not_after: na,
                    spki: leaf_key.spki(),
                    extensions: vec![(OID_NONCE.to_vec(), nonce_ext), (OID_OS_INFO.to_vec(), os_ext)],
                },
                &ca_key,
            );
            let mut x5c = vec![C::B(leaf_der), C::B(ca_der)];
            if o.extra_x5c {
                x5c.push(C::B(root_der.clone()));
            }
            let object = enc(&C::M(vec![
                (t("fmt"), C::T(o.fmt.clone())),
                (t("attStmt"), C::M(vec![(t("x5c"), C::A(x5c)), (t("receipt"), C::B(b"receipt".to_vec()))])),
                (t("authData"), C::B(auth)),
            ]));
            Fixture { root_der, object, key_id, client_data_hash }
        }
    }
}

pub mod receipt {
    use super::*;

    pub const APP_ID: &str = "ABCDE12345.com.qnetmobile";
    pub const NOW: i64 = 1_790_000_000;
    pub const RECEIPT_CA: &str = "Apple Application Integration CA 5 - G1";
    const OID_SIGNED_DATA: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02];
    const OID_DATA: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01];
    const OID_SHA256: &[u8] = &[0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01];
    const OID_RECEIPT_SIGNER: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x0c, 0x0f];

    pub struct Options {
        /// Common name of the intermediate between the root and the signer.
        pub ca_cn: String,
        /// The App Attest receipt signer extension in the signer certificate.
        pub signer_marker: bool,
        pub metric: Option<u32>,
    }

    impl Default for Options {
        fn default() -> Self {
            Options { ca_cn: RECEIPT_CA.into(), signer_marker: true, metric: Some(2) }
        }
    }

    pub struct Fixture {
        pub root_der: Vec<u8>,
        pub receipt: Vec<u8>,
        pub device_key: Vec<u8>,
    }

    fn iso(unix: i64) -> String {
        let (y, m, d) = der::civil(unix.div_euclid(86_400));
        let s = unix.rem_euclid(86_400);
        format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, m, d, s / 3600, s % 3600 / 60, s % 60)
    }

    fn field(kind: u64, value: &[u8]) -> Vec<u8> {
        der::seq(&[&der::uint(kind), &der::uint(1), &der::octets(value)])
    }

    /// A RECEIPT receipt signed without signed attributes, chained to its own test root.
    pub fn build(o: &Options) -> Fixture {
        let (root_key, ca_key, signer_key, device) = (Key::p384(), Key::p384(), Key::p256(), Key::p256());
        let long = (NOW - 1000 * 86_400, NOW + 1000 * 86_400);
        let root_name = der::name(&[(OID_CN, "Test Root CA - G3"), (OID_O, "Apple Inc.")]);
        let ca_name = der::name(&[(OID_CN, o.ca_cn.as_str()), (OID_O, "Apple Inc.")]);
        let spec = |serial: u64, issuer: &[u8], subject: &[u8], spki: Vec<u8>, extensions: Vec<(Vec<u8>, Vec<u8>)>| CertSpec {
            serial,
            issuer: issuer.to_vec(),
            subject: subject.to_vec(),
            not_before: long.0,
            not_after: long.1,
            spki,
            extensions,
        };
        let root_der = cert(&spec(1, &root_name, &root_name, root_key.spki(), vec![]), &root_key);
        let ca = cert(&spec(2, &root_name, &ca_name, ca_key.spki(), vec![]), &root_key);
        let marker = if o.signer_marker { vec![(OID_RECEIPT_SIGNER.to_vec(), der::null())] } else { vec![] };
        let signer_name = der::name(&[(OID_CN, "Application Attestation Fraud Receipt Signing"), (OID_O, "Apple Inc.")]);
        let signer = cert(&spec(3, &ca_name, &signer_name, signer_key.spki(), marker), &ca_key);
        let key_cert = cert(&spec(4, &der::name(&[(OID_CN, "Test App Attestation CA")]), &der::name(&[(OID_CN, "leaf")]), device.spki(), vec![]), &ca_key);

        let mut fields = vec![
            field(2, APP_ID.as_bytes()),
            field(3, &key_cert),
            field(6, b"RECEIPT"),
            field(12, iso(NOW).as_bytes()),
            field(21, iso(NOW + 90 * 86_400).as_bytes()),
        ];
        if let Some(m) = o.metric {
            fields.push(field(17, m.to_string().as_bytes()));
        }
        let refs: Vec<&[u8]> = fields.iter().map(Vec::as_slice).collect();
        let payload = der::set(&refs);
        let signer_info = der::seq(&[
            &der::uint(1),
            &der::seq(&[&ca_name, &der::uint(3)]),
            &der::seq(&[&der::oid(OID_SHA256)]),
            &der::seq(&[&der::oid(OID_ECDSA_SHA256)]),
            &der::octets(&signer_key.sign(&payload)),
        ]);
        let signed_data = der::seq(&[
            &der::uint(1),
            &der::set(&[&der::seq(&[&der::oid(OID_SHA256)])]),
            &der::seq(&[&der::oid(OID_DATA), &der::ctx(0, &der::octets(&payload))]),
            &der::ctx(0, &[signer, ca].concat()),
            &der::set(&[&signer_info]),
        ]);
        let receipt = der::seq(&[&der::oid(OID_SIGNED_DATA), &der::ctx(0, &signed_data)]);
        Fixture { root_der, receipt, device_key: device.public().to_vec() }
    }
}

pub mod android {
    use super::cbor::{enc, C};
    use super::*;

    pub const PACKAGE: &str = "io.aiqnet.wallet";
    pub const STORE_DIGEST: [u8; 32] = [0x11; 32];
    pub const TEST_DIGEST: [u8; 32] = [0x22; 32];
    pub const CHALLENGE: &[u8] = b"qnet-test-challenge";
    pub const NOW: i64 = 1_790_000_000;
    const OID_KEY_DESCRIPTION: &[u8] = &[0x2b, 0x06, 0x01, 0x04, 0x01, 0xd6, 0x79, 0x02, 0x01, 0x11];
    const OID_PROVISIONING_INFO: &[u8] = &[0x2b, 0x06, 0x01, 0x04, 0x01, 0xd6, 0x79, 0x02, 0x01, 0x1e];

    #[derive(Clone, Debug)]
    pub struct Options {
        pub factory: bool,
        pub level: u64,
        pub keymint_level: Option<u64>,
        pub attest_org: String,
        pub locked: bool,
        pub boot_state: u64,
        pub root_of_trust: bool,
        pub algorithm: u64,
        pub origin: u64,
        pub purpose_sign: bool,
        pub leaf_p384: bool,
        pub challenge: Vec<u8>,
        pub package: String,
        pub digest: [u8; 32],
        pub key_description_in_attest: bool,
        pub provisioning_info: bool,
        pub provisioning_info_in_leaf: bool,
        pub issuer_name_mismatch: bool,
        pub rkp_expired: bool,
        pub rkp_not_yet_valid: bool,
        pub duplicate_tag: bool,
        pub extra_intermediate: bool,
        /// Factory chain whose top intermediate carries a common name instead of a serial number.
        pub plain_top_name: bool,
        pub drop_leaf: bool,
        pub ber_boolean: bool,
        pub unordered: bool,
        pub provisioning_info_odd_types: bool,
    }

    impl Default for Options {
        fn default() -> Self {
            Options {
                factory: false,
                level: 1,
                keymint_level: None,
                attest_org: "TEE".into(),
                locked: true,
                boot_state: 0,
                root_of_trust: true,
                algorithm: 3,
                origin: 0,
                purpose_sign: true,
                leaf_p384: false,
                challenge: CHALLENGE.to_vec(),
                package: PACKAGE.into(),
                digest: STORE_DIGEST,
                key_description_in_attest: false,
                provisioning_info: true,
                provisioning_info_in_leaf: false,
                issuer_name_mismatch: false,
                rkp_expired: false,
                rkp_not_yet_valid: false,
                duplicate_tag: false,
                extra_intermediate: false,
                plain_top_name: false,
                drop_leaf: false,
                ber_boolean: false,
                unordered: false,
                provisioning_info_odd_types: false,
            }
        }
    }

    pub struct Fixture {
        pub chain: Vec<Vec<u8>>,
        pub root_spki: Vec<u8>,
    }

    fn key_description(o: &Options) -> Vec<u8> {
        let app_id = der::seq(&[
            &der::set(&[&der::seq(&[&der::octets(o.package.as_bytes()), &der::uint(20)])]),
            &der::set(&[&der::octets(&o.digest)]),
        ]);
        let created = der::ctx(701, &der::uint(1_789_999_000_000));
        let software = der::seq(&[&created, &der::ctx(709, &der::octets(&app_id))]);
        let locked = match (o.locked, o.ber_boolean) {
            (false, _) => 0x00,
            (true, true) => 0x01,
            (true, false) => 0xff,
        };
        let rot = der::seq(&[
            &der::octets(&[0u8; 32]),
            &der::boolean(locked),
            &der::enumerated(o.boot_state),
            &der::octets(&[7u8; 32]),
        ]);
        let purposes =
            if o.purpose_sign { der::set(&[&der::uint(2), &der::uint(3)]) } else { der::set(&[&der::uint(3)]) };
        let mut hw: Vec<Vec<u8>> = vec![
            der::ctx(1, &purposes),
            der::ctx(2, &der::uint(o.algorithm)),
            der::ctx(3, &der::uint(256)),
            der::ctx(10, &der::uint(1)),
            der::ctx(503, &der::null()),
            der::ctx(702, &der::uint(o.origin)),
        ];
        let os = der::ctx(705, &der::uint(160_000));
        if o.unordered {
            hw.push(os.clone());
        }
        if o.root_of_trust {
            hw.push(der::ctx(704, &rot));
        }
        if !o.unordered {
            hw.push(os);
        }
        hw.push(der::ctx(706, &der::uint(202_609)));
        if o.duplicate_tag {
            hw.push(der::ctx(2, &der::uint(o.algorithm)));
        }
        let hw_refs: Vec<&[u8]> = hw.iter().map(Vec::as_slice).collect();
        der::seq(&[
            &der::uint(400),
            &der::enumerated(o.level),
            &der::uint(400),
            &der::enumerated(o.keymint_level.unwrap_or(o.level)),
            &der::octets(&o.challenge),
            &der::octets(b""),
            &software,
            &der::seq(&hw_refs),
        ])
    }

    impl Fixture {
        pub fn build(o: &Options) -> Fixture {
            let root_key = Key::p384();
            let root_name = der::name(&[(OID_SERIAL, "0123456789abcdef")]);
            let spec = |serial: u64,
                        issuer: &[u8],
                        subject: &[u8],
                        spki: Vec<u8>,
                        validity: (i64, i64),
                        extensions: Vec<(Vec<u8>, Vec<u8>)>| CertSpec {
                serial,
                issuer: issuer.to_vec(),
                subject: subject.to_vec(),
                not_before: validity.0,
                not_after: validity.1,
                spki,
                extensions,
            };
            let long = (NOW - 1000 * 86_400, NOW + 1000 * 86_400);
            let attest_validity = if o.rkp_expired {
                (NOW - 60 * 86_400, NOW - 86_400)
            } else if o.rkp_not_yet_valid {
                (NOW + 86_400, NOW + 30 * 86_400)
            } else {
                (NOW - 86_400, NOW + 30 * 86_400)
            };
            let root = cert(&spec(1, &root_name, &root_name, root_key.spki(), long, vec![]), &root_key);

            // Intermediates between the root and the attestation certificate, top first.
            let names: Vec<Vec<u8>> = if o.factory {
                let top =
                    if o.plain_top_name { (OID_CN, "Test Attestation CA") } else { (OID_SERIAL, "a0b63a35743673b7") };
                let mut v = vec![der::name(&[top])];
                if o.extra_intermediate {
                    v.push(der::name(&[(OID_SERIAL, "b1c74b46854784c8")]));
                }
                v
            } else {
                vec![
                    der::name(&[(OID_O, "Google LLC"), (OID_CN, "Droid CA2")]),
                    der::name(&[(OID_O, "Google LLC"), (OID_CN, "Droid CA3")]),
                ]
            };
            let keys: Vec<Key> = (0..names.len()).map(|i| if i == 0 { Key::p384() } else { Key::p256() }).collect();
            let mut above = Vec::new();
            for i in 0..names.len() {
                let (ik, iname) = if i == 0 { (&root_key, &root_name) } else { (&keys[i - 1], &names[i - 1]) };
                above.push(cert(&spec(10 + i as u64, iname, &names[i], keys[i].spki(), long, vec![]), ik));
            }
            let issuer_key = keys.last().unwrap();
            let issuer_name = names.last().unwrap();

            let attest_key = Key::p256();
            let attest_name = if o.factory {
                der::name(&[(OID_SERIAL, "5ee8e1017e57dfe8")])
            } else {
                der::name(&[(OID_CN, "f165849ef08b4658dd0a8ab95be53006"), (OID_O, o.attest_org.as_str())])
            };
            let prov = if o.provisioning_info_odd_types {
                enc(&C::M(vec![(C::U(1), C::U(3)), (C::U(4), C::U(1)), (C::U(6), C::T("no".into()))]))
            } else {
                enc(&C::M(vec![(C::U(1), C::U(3)), (C::U(4), C::T("TEE".into()))]))
            };
            let kd = key_description(o);
            let mut attest_ext = Vec::new();
            if o.provisioning_info && !o.factory {
                attest_ext.push((OID_PROVISIONING_INFO.to_vec(), prov.clone()));
            }
            if o.key_description_in_attest {
                attest_ext.push((OID_KEY_DESCRIPTION.to_vec(), kd.clone()));
            }
            let attest_spec = spec(20, issuer_name, &attest_name, attest_key.spki(), attest_validity, attest_ext);
            let attest = cert(&attest_spec, issuer_key);

            let leaf_key = if o.leaf_p384 { Key::p384() } else { Key::p256() };
            let mut leaf_ext = vec![(OID_KEY_DESCRIPTION.to_vec(), kd)];
            if o.provisioning_info_in_leaf {
                leaf_ext.push((OID_PROVISIONING_INFO.to_vec(), prov));
            }
            let leaf_issuer = if o.issuer_name_mismatch { der::name(&[(OID_CN, "Someone Else")]) } else { attest_name };
            let leaf = cert(
                &spec(
                    1,
                    &leaf_issuer,
                    &der::name(&[(OID_CN, "Android Keystore Key")]),
                    leaf_key.spki(),
                    (0, 2_461_449_600),
                    leaf_ext,
                ),
                &attest_key,
            );

            let mut chain = Vec::new();
            if !o.drop_leaf {
                chain.push(leaf);
            }
            chain.push(attest);
            for c in above.iter().rev() {
                chain.push(c.clone());
            }
            chain.push(root);
            Fixture { chain, root_spki: root_key.spki() }
        }
    }
}

pub mod play {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;

    pub const PACKAGE: &str = "io.aiqnet.wallet";
    pub const STORE_DIGEST: [u8; 32] = [0x11; 32];
    pub const TEST_DIGEST: [u8; 32] = [0x22; 32];
    pub const NONCE: &[u8] = b"0123456789abcdef0123456789abcdef";
    pub const NOW_MS: u64 = 1_790_000_000_000;

    pub fn b64(bytes: &[u8]) -> String {
        URL_SAFE_NO_PAD.encode(bytes)
    }

    pub fn verdict() -> serde_json::Value {
        serde_json::json!({
            "requestDetails": {
                "requestPackageName": PACKAGE,
                "nonce": b64(NONCE),
                "timestampMillis": (NOW_MS - 1000).to_string()
            },
            "appIntegrity": {
                "appRecognitionVerdict": "PLAY_RECOGNIZED",
                "packageName": PACKAGE,
                "certificateSha256Digest": [b64(&STORE_DIGEST)],
                "versionCode": "20"
            },
            "deviceIntegrity": {
                "deviceRecognitionVerdict": [
                    "MEETS_BASIC_INTEGRITY", "MEETS_DEVICE_INTEGRITY", "MEETS_STRONG_INTEGRITY"
                ],
                "recentDeviceActivity": {"deviceActivityLevel": "LEVEL_1"},
                "deviceRecall": {
                    "values": {"bitFirst": true, "bitSecond": false, "bitThird": false},
                    "writeDates": {"yyyymmFirst": 202609}
                }
            },
            "accountDetails": {"appLicensingVerdict": "LICENSED"},
            "environmentDetails": {"appAccessRiskVerdict": {"appsDetected": ["KNOWN_INSTALLED"]}}
        })
    }

    pub struct Signer {
        pair: EcdsaKeyPair,
    }

    impl Signer {
        pub fn new() -> Signer {
            let rng = SystemRandom::new();
            let alg = &signature::ECDSA_P256_SHA256_FIXED_SIGNING;
            let pkcs8 = EcdsaKeyPair::generate_pkcs8(alg, &rng).unwrap();
            Signer { pair: EcdsaKeyPair::from_pkcs8(alg, pkcs8.as_ref(), &rng).unwrap() }
        }

        pub fn public_key(&self) -> crate::DevicePublicKey {
            crate::DevicePublicKey::from_sec1(self.pair.public_key().as_ref()).unwrap()
        }

        pub fn sign(&self, v: &serde_json::Value) -> String {
            let input = format!("{}.{}", b64(br#"{"alg":"ES256"}"#), b64(&serde_json::to_vec(v).unwrap()));
            let sig = self.pair.sign(&SystemRandom::new(), input.as_bytes()).unwrap();
            format!("{}.{}", input, b64(sig.as_ref()))
        }
    }
}
