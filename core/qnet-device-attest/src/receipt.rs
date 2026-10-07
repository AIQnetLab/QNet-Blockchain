//! App Attest receipts: a signed PKCS #7 container of numbered fields, chained to Apple Root CA - G3.
//!
//! The ATTEST receipt comes inside every attestation object; the oracle exchanges it with Apple for
//! RECEIPT receipts, the only ones that carry the risk metric (field 17). Apple's acceptance rule:
//! the signature chains to Apple Root CA - G3, field 2 is our App ID, field 3 is the certified key and
//! field 12 is at most five minutes old. The root alone is not enough: Apple issues other intermediates
//! under it, some of which certify keys that developers hold, so the chain must also run through the
//! intermediate that issues App Attest receipt signers, to a signer certificate marked as one.

use crate::crypto::{sha256, DevicePublicKey, KeyKind, SigAlg};
use crate::der::{self, Reader, Tag};
use crate::x509::{name_attr, Certificate, OID_CN, OID_O};
use crate::{time, Refusal};

/// Apple Root CA - G3 (SHA-256 of the DER `63343abf…9179`).
pub const APPLE_ROOT_CA_G3_DER: &[u8] = include_bytes!("../roots/apple_root_ca_g3.der");

/// The intermediate under Apple Root CA - G3 that issues the App Attest receipt signing certificates.
const RECEIPT_CA_CN: &[u8] = b"Apple Application Integration CA 5 - G1";
const APPLE_ORG: &[u8] = b"Apple Inc.";
/// The extension Apple puts in an App Attest receipt signing certificate (1.2.840.113635.100.12.15).
const OID_RECEIPT_SIGNER: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x0c, 0x0f];

const OID_SIGNED_DATA: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02];
const OID_DATA: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01];
const OID_SHA256: &[u8] = &[0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01];
const OID_MESSAGE_DIGEST: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x04];

const M: Refusal = Refusal::Malformed("receipt");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReceiptKind {
    /// Delivered with an attestation object.
    Attest,
    /// Returned by Apple for a receipt exchange; carries the risk metric.
    Receipt,
}

#[derive(Clone, Debug)]
pub struct Receipt {
    pub app_id: String,
    /// The key of the credential certificate in field 3.
    pub public_key: DevicePublicKey,
    pub client_hash: Vec<u8>,
    pub token: Option<String>,
    pub kind: ReceiptKind,
    /// Field 7 (undocumented; `production` in Apple's sample).
    pub environment: Option<String>,
    pub created_at: i64,
    /// Attested keys on this device for this app over the past 30 days.
    pub risk_metric: Option<u32>,
    /// A refresh before this time returns HTTP 304.
    pub not_before: Option<i64>,
    pub expires_at: Option<i64>,
}

impl Receipt {
    /// Apple's acceptance rule for a receipt of the recorded key: our App ID, created at most
    /// `max_age_secs` before `now` (and not after it, beyond the clock slack).
    pub fn check(&self, app_id: &str, key: &DevicePublicKey, max_age_secs: i64, now: i64) -> Result<(), Refusal> {
        if self.app_id != app_id {
            return Err(Refusal::AppMismatch);
        }
        if &self.public_key != key {
            return Err(Refusal::KeyIdMismatch);
        }
        let ahead = self.created_at.saturating_sub(now) > time::CLOCK_SKEW_SECS;
        if ahead || now.saturating_sub(self.created_at) > max_age_secs {
            return Err(Refusal::ReceiptStale);
        }
        Ok(())
    }
}

/// Verifies the receipt's signature and certificate chain at Unix time `now`, then reads its fields.
pub fn verify_receipt(receipt: &[u8], now: i64) -> Result<Receipt, Refusal> {
    let root = Certificate::parse(APPLE_ROOT_CA_G3_DER)?;
    verify_receipt_with_root(receipt, now, &root)
}

pub(crate) fn verify_receipt_with_root(receipt: &[u8], now: i64, root: &Certificate<'_>) -> Result<Receipt, Refusal> {
    let mut r = Reader::ber(receipt);
    let content_info = r.expect_universal(der::SEQUENCE)?;
    r.finish()?;
    let mut ci = content_info.reader()?;
    if ci.expect_universal(der::OID)?.oid()? != OID_SIGNED_DATA {
        return Err(M);
    }
    let explicit = ci.expect(Tag::context(0, true))?;
    ci.finish()?;
    let mut e = explicit.reader()?;
    let signed_data = e.expect_universal(der::SEQUENCE)?;
    e.finish()?;

    let mut sd = signed_data.reader()?;
    sd.expect_universal(der::INTEGER)?;
    sd.expect_universal(der::SET)?;
    let encap = sd.expect_universal(der::SEQUENCE)?;
    let certs_tlv = sd.optional(Tag::context(0, true))?.ok_or(M)?;
    sd.optional(Tag::context(1, true))?;
    let signer_infos = sd.expect_universal(der::SET)?;
    sd.finish()?;

    let mut en = encap.reader()?;
    if en.expect_universal(der::OID)?.oid()? != OID_DATA {
        return Err(M);
    }
    let econtent_explicit = en.expect(Tag::context(0, true))?;
    en.finish()?;
    let mut ec = econtent_explicit.reader()?;
    let payload = ec.read()?.octets_ber()?;
    ec.finish()?;

    let mut certs = Vec::new();
    let mut cr = certs_tlv.reader()?;
    while !cr.is_empty() {
        certs.push(Certificate::parse(cr.read()?.raw)?);
    }

    let mut si_set = signer_infos.reader()?;
    let signer = si_set.expect_universal(der::SEQUENCE)?;
    si_set.finish()?;
    let mut si = signer.reader()?;
    si.expect_universal(der::INTEGER)?;
    let sid = si.expect_universal(der::SEQUENCE)?;
    let digest_alg = si.expect_universal(der::SEQUENCE)?;
    let signed_attrs = si.optional(Tag::context(0, true))?;
    let sig_alg_tlv = si.expect_universal(der::SEQUENCE)?;
    let signature = si.expect_universal(der::OCTET_STRING)?.octets()?;
    si.optional(Tag::context(1, true))?;
    si.finish()?;

    let mut da = digest_alg.reader()?;
    if da.expect_universal(der::OID)?.oid()? != OID_SHA256 {
        return Err(Refusal::UnsupportedAlgorithm);
    }
    let mut sr = sid.reader()?;
    let sid_issuer = sr.expect_universal(der::SEQUENCE)?.raw;
    let sid_serial = sr.expect_universal(der::INTEGER)?.integer_bytes()?;
    sr.finish()?;

    let signer_cert = certs
        .iter()
        .find(|c| c.issuer == sid_issuer && c.serial == sid_serial)
        .ok_or(Refusal::ChainShape)?;
    let ca = certs.iter().find(|c| c.subject == signer_cert.issuer).ok_or(Refusal::ChainShape)?;
    if name_attr(ca.subject, OID_CN) != Some(RECEIPT_CA_CN) || name_attr(ca.subject, OID_O) != Some(APPLE_ORG) {
        return Err(Refusal::UntrustedRoot);
    }
    if signer_cert.extension(OID_RECEIPT_SIGNER).is_none() {
        return Err(Refusal::ChainShape);
    }
    ca.verify_issued_by(root)?;
    signer_cert.verify_issued_by(ca)?;
    ca.check_validity(now)?;
    signer_cert.check_validity(now)?;
    if signer_cert.spki.kind != KeyKind::P256 {
        return Err(Refusal::UnsupportedAlgorithm);
    }

    let sig_alg = SigAlg::from_algorithm_identifier(&sig_alg_tlv)?;
    let signed_message: Vec<u8> = match signed_attrs {
        None => payload.to_vec(),
        Some(attrs) => {
            if message_digest(&attrs)? != sha256(&payload) {
                return Err(Refusal::SignatureInvalid);
            }
            // The signature covers the attributes re-tagged as a DER SET.
            let mut m = attrs.raw.to_vec();
            m[0] = der::SET;
            m
        }
    };
    crate::crypto::verify(sig_alg, &signer_cert.spki, &signed_message, signature).map_err(|e| match e {
        Refusal::ChainSignature => Refusal::SignatureInvalid,
        other => other,
    })?;

    parse_fields(&payload)
}

fn message_digest(attrs: &der::Tlv<'_>) -> Result<[u8; 32], Refusal> {
    let mut r = attrs.reader()?;
    while !r.is_empty() {
        let attr = r.expect_universal(der::SEQUENCE)?;
        let mut a = attr.reader()?;
        if a.expect_universal(der::OID)?.oid()? == OID_MESSAGE_DIGEST {
            let mut values = a.expect_universal(der::SET)?.reader()?;
            let d = values.expect_universal(der::OCTET_STRING)?.octets()?;
            return d.try_into().map_err(|_| M);
        }
    }
    Err(M)
}

fn parse_fields(payload: &[u8]) -> Result<Receipt, Refusal> {
    let mut r = Reader::der(payload);
    let set = r.expect_universal(der::SET)?;
    r.finish()?;
    let mut fields: Vec<(u64, &[u8])> = Vec::new();
    let mut s = set.reader()?;
    while !s.is_empty() {
        let f = s.expect_universal(der::SEQUENCE)?;
        let mut fr = f.reader()?;
        let kind = fr.expect_universal(der::INTEGER)?.uint()?;
        fr.expect_universal(der::INTEGER)?;
        let value = fr.expect_universal(der::OCTET_STRING)?.octets()?;
        fr.finish()?;
        if matches!(kind, 2..=7 | 12 | 17 | 19 | 21) && fields.iter().any(|(k, _)| *k == kind) {
            return Err(M);
        }
        fields.push((kind, value));
    }
    let get = |k: u64| fields.iter().find(|(t, _)| *t == k).map(|(_, v)| *v);
    let text = |k: u64| -> Result<Option<String>, Refusal> {
        get(k).map(|v| String::from_utf8(v.to_vec()).map_err(|_| M)).transpose()
    };
    let when = |k: u64| -> Result<Option<i64>, Refusal> { get(k).map(time::iso8601).transpose() };

    let app_id = text(2)?.ok_or(M)?;
    let key_cert = Certificate::parse(get(3).ok_or(M)?)?;
    if key_cert.spki.kind != KeyKind::P256 {
        return Err(Refusal::KeyType);
    }
    let public_key = DevicePublicKey::from_sec1(key_cert.spki.key)?;
    let kind = match get(6) {
        Some(b"ATTEST") => ReceiptKind::Attest,
        Some(b"RECEIPT") => ReceiptKind::Receipt,
        _ => return Err(M),
    };
    let risk_metric = match text(17)? {
        None => None,
        Some(t) => Some(t.trim().parse::<u32>().map_err(|_| M)?),
    };
    Ok(Receipt {
        app_id,
        public_key,
        client_hash: get(4).map(<[u8]>::to_vec).unwrap_or_default(),
        token: text(5)?,
        kind,
        environment: text(7)?,
        created_at: when(12)?.ok_or(M)?,
        risk_metric,
        not_before: when(19)?,
        expires_at: when(21)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::receipt::{build, Options, APP_ID, NOW};

    fn verify(o: &Options) -> (Result<Receipt, Refusal>, Vec<u8>) {
        let f = build(o);
        let root = Certificate::parse(&f.root_der).unwrap();
        (verify_receipt_with_root(&f.receipt, NOW, &root), f.device_key)
    }

    #[test]
    fn a_receipt_from_the_receipt_intermediate_and_a_marked_signer_verifies() {
        let (r, key) = verify(&Options::default());
        let r = r.unwrap();
        assert_eq!(r.app_id, APP_ID);
        assert_eq!(r.kind, ReceiptKind::Receipt);
        assert_eq!(r.risk_metric, Some(2));
        assert_eq!(&r.public_key.as_bytes()[..], &key[..]);
        assert_eq!(r.created_at, NOW);
    }

    #[test]
    fn a_receipt_signed_under_another_intermediate_of_the_root_is_refused() {
        // Chains to the root and carries the signer marker, but through an intermediate that certifies
        // developer-held keys: any metric it states could be anyone's.
        let o = Options { ca_cn: "Apple Application Integration CA - G3".into(), ..Options::default() };
        assert_eq!(verify(&o).0.unwrap_err(), Refusal::UntrustedRoot);
    }

    #[test]
    fn a_receipt_whose_signer_is_not_marked_as_a_receipt_signer_is_refused() {
        let o = Options { signer_marker: false, ..Options::default() };
        assert_eq!(verify(&o).0.unwrap_err(), Refusal::ChainShape);
    }
}
