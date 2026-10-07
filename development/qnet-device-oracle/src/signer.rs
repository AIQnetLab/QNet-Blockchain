//! The oracle's ML-DSA-65 signing key: lease statements and revocation snapshots. The node binary pins
//! the public key, so the key is generated once on the oracle host and never leaves it.

use pqcrypto_mldsa::mldsa65;
use pqcrypto_traits::sign::{DetachedSignature, PublicKey, SecretKey};
use std::io::Write;
use std::path::Path;

const MAGIC: &[u8; 8] = b"QNETORK1";

pub struct Signer {
    pk: mldsa65::PublicKey,
    sk: mldsa65::SecretKey,
}

impl Signer {
    pub fn generate() -> Self {
        let (pk, sk) = mldsa65::keypair();
        Signer { pk, sk }
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, String> {
        let pk_len = mldsa65::public_key_bytes();
        let sk_len = mldsa65::secret_key_bytes();
        if bytes.len() != MAGIC.len() + pk_len + sk_len || &bytes[..MAGIC.len()] != MAGIC {
            return Err("oracle key file has the wrong format".into());
        }
        let pk = mldsa65::PublicKey::from_bytes(&bytes[MAGIC.len()..MAGIC.len() + pk_len])
            .map_err(|_| "oracle public key is malformed".to_string())?;
        let sk = mldsa65::SecretKey::from_bytes(&bytes[MAGIC.len() + pk_len..])
            .map_err(|_| "oracle secret key is malformed".to_string())?;
        let s = Signer { pk, sk };
        // A key file whose halves do not match would sign statements every node refuses.
        let probe = s.sign(b"qnet_oracle_key_check");
        if !verify(s.pk.as_bytes(), b"qnet_oracle_key_check", &probe) {
            return Err("oracle key halves do not match".into());
        }
        Ok(s)
    }

    pub fn load(path: &Path) -> Result<Self, String> {
        let bytes = std::fs::read(path).map_err(|e| format!("read {}: {}", path.display(), e))?;
        Self::from_bytes(&bytes)
    }

    /// Writes the key file; refuses to overwrite an existing one.
    pub fn save_new(&self, path: &Path) -> Result<(), String> {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o400);
        }
        let mut f = opts.open(path).map_err(|e| format!("create {}: {}", path.display(), e))?;
        f.write_all(MAGIC).map_err(|e| e.to_string())?;
        f.write_all(self.pk.as_bytes()).map_err(|e| e.to_string())?;
        f.write_all(self.sk.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())
    }

    pub fn sign(&self, msg: &[u8]) -> Vec<u8> {
        mldsa65::detached_sign(msg, &self.sk).as_bytes().to_vec()
    }

    pub fn public_key(&self) -> &[u8] {
        self.pk.as_bytes()
    }
}

pub fn verify(pk: &[u8], msg: &[u8], sig: &[u8]) -> bool {
    let (Ok(pk), Ok(sig)) = (mldsa65::PublicKey::from_bytes(pk), mldsa65::DetachedSignature::from_bytes(sig)) else {
        return false;
    };
    mldsa65::verify_detached_signature(&sig, msg, &pk).is_ok()
}
