//! The parts of an X.509 certificate the vendor chains need.

use crate::crypto::{self, SigAlg, Spki};
use crate::der::{self, Reader, Tag};
use crate::time;
use crate::Refusal;

pub(crate) const OID_CN: &[u8] = &[0x55, 0x04, 0x03];
pub(crate) const OID_O: &[u8] = &[0x55, 0x04, 0x0a];
pub(crate) const OID_SERIAL_NUMBER: &[u8] = &[0x55, 0x04, 0x05];

const M: Refusal = Refusal::Malformed("certificate");

#[derive(Clone, Copy, Debug)]
pub(crate) struct Extension<'a> {
    pub oid: &'a [u8],
    pub value: &'a [u8],
}

#[derive(Clone, Debug)]
pub(crate) struct Certificate<'a> {
    pub tbs: &'a [u8],
    /// INTEGER content octets of the serial number.
    pub serial: &'a [u8],
    /// `None` when the signature algorithm is not one this crate verifies.
    pub sig_alg: Option<SigAlg>,
    pub issuer: &'a [u8],
    pub subject: &'a [u8],
    pub not_before: i64,
    pub not_after: i64,
    pub spki: Spki<'a>,
    pub extensions: Vec<Extension<'a>>,
    pub signature: &'a [u8],
}

fn parse_time(t: &der::Tlv<'_>) -> Result<i64, Refusal> {
    if t.tag.is(der::UTC_TIME) {
        time::utc_time(t.value)
    } else if t.tag.is(der::GENERALIZED_TIME) {
        time::generalized_time(t.value)
    } else {
        Err(M)
    }
}

impl<'a> Certificate<'a> {
    pub fn parse(data: &'a [u8]) -> Result<Certificate<'a>, Refusal> {
        let mut outer = Reader::der(data);
        let cert = outer.expect_universal(der::SEQUENCE)?;
        outer.finish()?;
        let mut c = cert.reader()?;
        let tbs = c.expect_universal(der::SEQUENCE)?;
        let outer_alg = c.expect_universal(der::SEQUENCE)?;
        let signature = c.expect_universal(der::BIT_STRING)?.bit_string()?;
        c.finish()?;

        let mut t = tbs.reader()?;
        if let Some(v) = t.optional(Tag::context(0, true))? {
            let mut vr = v.reader()?;
            if vr.expect_universal(der::INTEGER)?.uint()? > 2 {
                return Err(M);
            }
            vr.finish()?;
        }
        let serial = t.expect_universal(der::INTEGER)?.integer_bytes()?;
        let inner_alg = t.expect_universal(der::SEQUENCE)?;
        if inner_alg.raw != outer_alg.raw {
            return Err(M);
        }
        let sig_alg = SigAlg::from_algorithm_identifier(&outer_alg)?;
        let issuer = t.expect_universal(der::SEQUENCE)?.raw;
        let validity = t.expect_universal(der::SEQUENCE)?;
        let mut vr = validity.reader()?;
        let not_before = parse_time(&vr.read()?)?;
        let not_after = parse_time(&vr.read()?)?;
        vr.finish()?;
        let subject = t.expect_universal(der::SEQUENCE)?.raw;
        let spki = Spki::parse(&t.read()?)?;
        t.optional(Tag::context(1, false))?;
        t.optional(Tag::context(2, false))?;
        let mut extensions = Vec::new();
        if let Some(e) = t.optional(Tag::context(3, true))? {
            let mut er = e.reader()?;
            let list = er.expect_universal(der::SEQUENCE)?;
            er.finish()?;
            let mut lr = list.reader()?;
            while !lr.is_empty() {
                let ext = lr.expect_universal(der::SEQUENCE)?;
                let mut x = ext.reader()?;
                let oid = x.expect_universal(der::OID)?.oid()?;
                if let Some(b) = x.optional(Tag::universal(der::BOOLEAN))? {
                    b.boolean_lenient()?;
                }
                let value = x.expect_universal(der::OCTET_STRING)?.octets()?;
                x.finish()?;
                if extensions.iter().any(|e: &Extension<'_>| e.oid == oid) {
                    return Err(M);
                }
                extensions.push(Extension { oid, value });
            }
        }
        t.finish()?;
        Ok(Certificate {
            tbs: tbs.raw,
            serial,
            sig_alg,
            issuer,
            subject,
            not_before,
            not_after,
            spki,
            extensions,
            signature,
        })
    }

    pub fn extension(&self, oid: &[u8]) -> Option<&'a [u8]> {
        self.extensions.iter().find(|e| e.oid == oid).map(|e| e.value)
    }

    /// Checks that `issuer` names and signs this certificate.
    pub fn verify_issued_by(&self, issuer: &Certificate<'_>) -> Result<(), Refusal> {
        if self.issuer != issuer.subject {
            return Err(Refusal::ChainName);
        }
        crypto::verify(self.sig_alg, &issuer.spki, self.tbs, self.signature)
    }

    /// Checks the validity window at `now`, with the clock slack of [`time::CLOCK_SKEW_SECS`].
    pub fn check_validity(&self, now: i64) -> Result<(), Refusal> {
        if now.saturating_add(time::CLOCK_SKEW_SECS) < self.not_before {
            Err(Refusal::CertificateNotYetValid)
        } else if now.saturating_sub(time::CLOCK_SKEW_SECS) > self.not_after {
            Err(Refusal::CertificateExpired)
        } else {
            Ok(())
        }
    }

    pub fn is_self_issued(&self) -> bool {
        self.issuer == self.subject
    }

    /// The serial number as lowercase hex without leading zeros, the form of the status list.
    pub fn serial_hex(&self) -> String {
        serial_hex(self.serial)
    }
}

pub(crate) fn serial_hex(serial: &[u8]) -> String {
    let negative = serial.first().is_some_and(|b| b & 0x80 != 0);
    let magnitude: Vec<u8> = if negative {
        // Two's complement magnitude, printed with a sign as the status list tools do.
        let mut v: Vec<u8> = serial.iter().map(|b| !b).collect();
        for byte in v.iter_mut().rev() {
            let (n, carry) = byte.overflowing_add(1);
            *byte = n;
            if !carry {
                break;
            }
        }
        v
    } else {
        serial.to_vec()
    };
    let mut hex: String = magnitude.iter().map(|b| format!("{:02x}", b)).collect();
    let trimmed = hex.trim_start_matches('0').len();
    hex = if trimmed == 0 { "0".to_string() } else { hex[hex.len() - trimmed..].to_string() };
    if negative {
        format!("-{}", hex)
    } else {
        hex
    }
}

/// The first attribute value of type `oid` in a Name, as its string bytes.
pub(crate) fn name_attr<'a>(name: &'a [u8], oid: &[u8]) -> Option<&'a [u8]> {
    let mut outer = Reader::der(name);
    let seq = outer.expect_universal(der::SEQUENCE).ok()?;
    let mut rdns = seq.reader().ok()?;
    while !rdns.is_empty() {
        let set = rdns.expect_universal(der::SET).ok()?;
        let mut atvs = set.reader().ok()?;
        while !atvs.is_empty() {
            let atv = atvs.expect_universal(der::SEQUENCE).ok()?;
            let mut a = atv.reader().ok()?;
            let t = a.expect_universal(der::OID).ok()?.oid().ok()?;
            let v = a.read().ok()?;
            if t == oid {
                return v.string_bytes().ok();
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn p256_issuer_with_sha384_signatures() {
        use base64::Engine;
        let pem = include_str!("../tests/testdata/android/p256_sha384_intermediate.pem");
        let ders: Vec<Vec<u8>> = pem
            .split("-----BEGIN CERTIFICATE-----")
            .skip(1)
            .map(|b| {
                let body: String = b.split("-----END").next().unwrap().split_whitespace().collect();
                base64::engine::general_purpose::STANDARD.decode(body).unwrap()
            })
            .collect();
        let certs: Vec<Certificate<'_>> = ders.iter().map(|d| Certificate::parse(d).unwrap()).collect();
        assert_eq!(certs.len(), 3);
        assert_eq!(certs[0].sig_alg, Some(SigAlg::EcdsaSha384));
        assert_eq!(certs[1].spki.kind, crate::crypto::KeyKind::P256);
        certs[0].verify_issued_by(&certs[1]).unwrap();
        certs[1].verify_issued_by(&certs[2]).unwrap();
        assert_eq!(certs[1].verify_issued_by(&certs[1]).unwrap_err(), Refusal::ChainName);
        assert_eq!(name_attr(certs[0].subject, OID_CN), Some(&b"Test Leaf"[..]));

        // Validity windows carry the clock slack on both ends.
        let (from, to) = (certs[0].not_before, certs[0].not_after);
        let skew = time::CLOCK_SKEW_SECS;
        assert!(certs[0].check_validity(from - skew).is_ok() && certs[0].check_validity(to + skew).is_ok());
        assert_eq!(certs[0].check_validity(from - skew - 1).unwrap_err(), Refusal::CertificateNotYetValid);
        assert_eq!(certs[0].check_validity(to + skew + 1).unwrap_err(), Refusal::CertificateExpired);
    }

    #[test]
    fn serial_forms() {
        assert_eq!(serial_hex(&[0x01]), "1");
        assert_eq!(serial_hex(&[0x00, 0xf1, 0xc1]), "f1c1");
        assert_eq!(serial_hex(&[0x00]), "0");
        assert_eq!(serial_hex(&[0xff]), "-1");
        assert_eq!(serial_hex(&[0x80, 0x00]), "-8000");
    }
}
