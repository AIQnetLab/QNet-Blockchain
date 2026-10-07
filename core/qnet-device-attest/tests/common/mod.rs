#![allow(dead_code)]

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use std::path::PathBuf;

pub fn testdata(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("testdata").join(rel)
}

/// The DER certificates of a PEM file, in file order.
pub fn pem_chain(rel: &str) -> Vec<Vec<u8>> {
    let text = std::fs::read_to_string(testdata(rel)).expect(rel);
    let mut out = Vec::new();
    let mut body = String::new();
    let mut inside = false;
    for line in text.lines() {
        if line.starts_with("-----BEGIN CERTIFICATE-----") {
            inside = true;
            body.clear();
        } else if line.starts_with("-----END CERTIFICATE-----") {
            inside = false;
            out.push(STANDARD.decode(&body).expect("pem body"));
        } else if inside {
            body.push_str(line.trim());
        }
    }
    out
}

pub fn refs(chain: &[Vec<u8>]) -> Vec<&[u8]> {
    chain.iter().map(Vec::as_slice).collect()
}

pub fn b64(s: &str) -> Vec<u8> {
    STANDARD.decode(s).expect("base64")
}

pub fn b64url(s: &str) -> Vec<u8> {
    URL_SAFE_NO_PAD.decode(s).expect("b64url")
}

pub fn hex(s: &str) -> Vec<u8> {
    assert!(s.len().is_multiple_of(2), "odd hex length");
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex")).collect()
}

pub fn digest32(bytes: &[u8]) -> [u8; 32] {
    bytes.try_into().expect("32 bytes")
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    digest32(ring::digest::digest(&ring::digest::SHA256, data).as_ref())
}

/// A small deterministic generator for mutation tests.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng(seed.max(1))
    }

    pub fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    pub fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}
