//! Hashes, key types and signature checks over `ring`.

use crate::der::{self, Reader, Tag};
use crate::Refusal;
use ring::{digest, signature};
use std::fmt;

// DER content of the object identifiers used here.
pub(crate) const OID_EC_PUBLIC_KEY: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
pub(crate) const OID_P256: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
pub(crate) const OID_P384: &[u8] = &[0x2b, 0x81, 0x04, 0x00, 0x22];
pub(crate) const OID_RSA: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
const OID_ECDSA_SHA256: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02];
const OID_ECDSA_SHA384: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x03];
const OID_ECDSA_SHA512: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x04];
const OID_RSA_SHA256: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b];
const OID_RSA_SHA384: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0c];
const OID_RSA_SHA512: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0d];

pub(crate) fn sha256(data: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(digest::digest(&digest::SHA256, data).as_ref());
    out
}

pub(crate) fn sha256_two(a: &[u8], b: &[u8]) -> [u8; 32] {
    let mut ctx = digest::Context::new(&digest::SHA256);
    ctx.update(a);
    ctx.update(b);
    let mut out = [0u8; 32];
    out.copy_from_slice(ctx.finish().as_ref());
    out
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SigAlg {
    EcdsaSha256,
    EcdsaSha384,
    EcdsaSha512,
    RsaSha256,
    RsaSha384,
    RsaSha512,
}

impl SigAlg {
    /// From an AlgorithmIdentifier; `None` for an algorithm this crate does not verify.
    pub fn from_algorithm_identifier(alg: &der::Tlv<'_>) -> Result<Option<SigAlg>, Refusal> {
        let mut r = alg.reader()?;
        let oid = r.expect_universal(der::OID)?.oid()?;
        let params = if r.is_empty() { None } else { Some(r.read()?) };
        r.finish()?;
        let found = match oid {
            o if o == OID_ECDSA_SHA256 => SigAlg::EcdsaSha256,
            o if o == OID_ECDSA_SHA384 => SigAlg::EcdsaSha384,
            o if o == OID_ECDSA_SHA512 => SigAlg::EcdsaSha512,
            o if o == OID_RSA_SHA256 => SigAlg::RsaSha256,
            o if o == OID_RSA_SHA384 => SigAlg::RsaSha384,
            o if o == OID_RSA_SHA512 => SigAlg::RsaSha512,
            _ => return Ok(None),
        };
        // ECDSA takes no parameters and RSA takes NULL; both are tolerated as absent or NULL.
        if let Some(p) = params {
            p.null()?;
        }
        Ok(Some(found))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum KeyKind {
    P256,
    P384,
    Rsa,
    Other,
}

/// A SubjectPublicKeyInfo: the key kind and the subjectPublicKey bits.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Spki<'a> {
    pub kind: KeyKind,
    pub key: &'a [u8],
    pub raw: &'a [u8],
}

impl<'a> Spki<'a> {
    pub fn parse(tlv: &der::Tlv<'a>) -> Result<Spki<'a>, Refusal> {
        if !tlv.tag.is(der::SEQUENCE) {
            return Err(Refusal::Malformed("spki"));
        }
        let mut r = tlv.reader()?;
        let alg = r.expect_universal(der::SEQUENCE)?;
        let key = r.expect_universal(der::BIT_STRING)?.bit_string()?;
        r.finish()?;
        let mut a = alg.reader()?;
        let oid = a.expect_universal(der::OID)?.oid()?;
        let kind = if oid == OID_EC_PUBLIC_KEY {
            let curve = a.expect_universal(der::OID)?.oid()?;
            if curve == OID_P256 && key.len() == 65 && key[0] == 4 {
                KeyKind::P256
            } else if curve == OID_P384 && key.len() == 97 && key[0] == 4 {
                KeyKind::P384
            } else {
                KeyKind::Other
            }
        } else if oid == OID_RSA {
            if let Some(t) = a.optional(Tag::universal(der::NULL))? {
                t.null()?;
            }
            KeyKind::Rsa
        } else {
            KeyKind::Other
        };
        Ok(Spki { kind, key, raw: tlv.raw })
    }
}

/// Verifies `sig` over `msg` with `key` under `alg`.
pub(crate) fn verify(alg: Option<SigAlg>, key: &Spki<'_>, msg: &[u8], sig: &[u8]) -> Result<(), Refusal> {
    use signature::VerificationAlgorithm as V;
    let a: &'static dyn V = match (key.kind, alg.ok_or(Refusal::UnsupportedAlgorithm)?) {
        (KeyKind::P256, SigAlg::EcdsaSha256) => &signature::ECDSA_P256_SHA256_ASN1,
        (KeyKind::P256, SigAlg::EcdsaSha384) => &signature::ECDSA_P256_SHA384_ASN1,
        (KeyKind::P384, SigAlg::EcdsaSha256) => &signature::ECDSA_P384_SHA256_ASN1,
        (KeyKind::P384, SigAlg::EcdsaSha384) => &signature::ECDSA_P384_SHA384_ASN1,
        (KeyKind::Rsa, SigAlg::RsaSha256) => &signature::RSA_PKCS1_2048_8192_SHA256,
        (KeyKind::Rsa, SigAlg::RsaSha384) => &signature::RSA_PKCS1_2048_8192_SHA384,
        (KeyKind::Rsa, SigAlg::RsaSha512) => &signature::RSA_PKCS1_2048_8192_SHA512,
        _ => return Err(Refusal::UnsupportedAlgorithm),
    };
    signature::UnparsedPublicKey::new(a, key.key).verify(msg, sig).map_err(|_| Refusal::ChainSignature)
}

/// A device key: an ECDSA P-256 public key as its 65-byte uncompressed point (spec section 2).
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct DevicePublicKey([u8; 65]);

impl DevicePublicKey {
    /// From the uncompressed SEC1 point `0x04 ‖ X ‖ Y`.
    pub fn from_sec1(bytes: &[u8]) -> Result<Self, Refusal> {
        if bytes.len() != 65 || bytes[0] != 4 {
            return Err(Refusal::Malformed("device key"));
        }
        let mut k = [0u8; 65];
        k.copy_from_slice(bytes);
        Ok(DevicePublicKey(k))
    }

    /// From a DER SubjectPublicKeyInfo holding a P-256 key.
    pub fn from_spki_der(der_bytes: &[u8]) -> Result<Self, Refusal> {
        let mut r = Reader::der(der_bytes);
        let tlv = r.read()?;
        r.finish()?;
        let spki = Spki::parse(&tlv)?;
        if spki.kind != KeyKind::P256 {
            return Err(Refusal::KeyType);
        }
        Self::from_sec1(spki.key)
    }

    pub fn as_bytes(&self) -> &[u8; 65] {
        &self.0
    }

    /// SHA-256 of the point: the App Attest key identifier.
    pub fn key_id(&self) -> [u8; 32] {
        sha256(&self.0)
    }

    /// Checks a device signature made the Android way: ECDSA-SHA256 over `message`, DER encoded.
    pub fn verify_der(&self, message: &[u8], der_signature: &[u8]) -> Result<(), Refusal> {
        signature::UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_ASN1, &self.0[..])
            .verify(message, der_signature)
            .map_err(|_| Refusal::SignatureInvalid)
    }

    /// Checks an ECDSA-SHA256 signature in the fixed `r ‖ s` form of signed tokens.
    pub fn verify_fixed(&self, message: &[u8], signature64: &[u8]) -> Result<(), Refusal> {
        signature::UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_FIXED, &self.0[..])
            .verify(message, signature64)
            .map_err(|_| Refusal::SignatureInvalid)
    }
}

impl fmt::Debug for DevicePublicKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "DevicePublicKey(")?;
        for b in &self.0 {
            write!(f, "{:02x}", b)?;
        }
        write!(f, ")")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_known_answer() {
        let h = sha256(b"abc");
        assert_eq!(h[..4], [0xba, 0x78, 0x16, 0xbf]);
        assert_eq!(sha256_two(b"a", b"bc"), h);
    }

    #[test]
    fn device_key_shape() {
        assert!(DevicePublicKey::from_sec1(&[4u8; 64]).is_err());
        let mut compressed = [0u8; 65];
        compressed[0] = 2;
        assert!(DevicePublicKey::from_sec1(&compressed).is_err());
    }
}
