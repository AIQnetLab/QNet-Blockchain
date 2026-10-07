//! Signed JSON web tokens for the vendor APIs: ES256 with the Apple key that has DeviceCheck enabled, and
//! RS256 service-account assertions for Google's token endpoint.

use aws_lc_rs::rand::SystemRandom;
use aws_lc_rs::signature::{EcdsaKeyPair, RsaKeyPair, ECDSA_P256_SHA256_FIXED_SIGNING, RSA_PKCS1_SHA256};
use parking_lot::Mutex;

use crate::messages::{b64url, pem_decode};

/// Apple accepts a provider token for up to an hour; a fresh one is made well before that.
const APPLE_TOKEN_REUSE: u64 = 20 * 60;

pub struct Es256Jwt {
    key: EcdsaKeyPair,
    kid: String,
    iss: String,
    cache: Mutex<Option<(u64, String)>>,
}

impl Es256Jwt {
    /// `pem`: the `.p8` file (PKCS#8 `PRIVATE KEY`). `kid`: its key id. `iss`: the Team ID.
    pub fn from_p8(pem: &str, kid: &str, iss: &str) -> Result<Self, String> {
        let der = pem_decode(pem, "PRIVATE KEY").ok_or("the Apple key file is not a PKCS#8 PEM")?;
        let key = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &der)
            .map_err(|e| format!("the Apple key is not a P-256 key: {}", e))?;
        if kid.is_empty() || iss.is_empty() {
            return Err("the Apple key id and Team ID must be set".into());
        }
        Ok(Es256Jwt { key, kid: kid.to_string(), iss: iss.to_string(), cache: Mutex::new(None) })
    }

    pub fn token(&self, now: u64) -> Result<String, String> {
        let mut c = self.cache.lock();
        if let Some((iat, t)) = c.as_ref() {
            if now < iat + APPLE_TOKEN_REUSE && now >= *iat {
                return Ok(t.clone());
            }
        }
        let header = serde_json::json!({"alg": "ES256", "kid": self.kid});
        let claims = serde_json::json!({"iss": self.iss, "iat": now});
        let t = sign_compact(&header, &claims, |m| {
            self.key.sign(&SystemRandom::new(), m).map(|s| s.as_ref().to_vec()).map_err(|_| "ES256 signing failed".to_string())
        })?;
        *c = Some((now, t.clone()));
        Ok(t)
    }
}

fn sign_compact(
    header: &serde_json::Value,
    claims: &serde_json::Value,
    sign: impl FnOnce(&[u8]) -> Result<Vec<u8>, String>,
) -> Result<String, String> {
    let signing_input = format!("{}.{}", b64url(header.to_string().as_bytes()), b64url(claims.to_string().as_bytes()));
    let sig = sign(signing_input.as_bytes())?;
    Ok(format!("{}.{}", signing_input, b64url(&sig)))
}

/// A Google service account limited to the Play Integrity scope.
pub struct ServiceAccount {
    pub client_email: String,
    pub token_uri: String,
    key_id: String,
    key: RsaKeyPair,
}

impl ServiceAccount {
    /// Parses the service-account JSON file.
    pub fn from_json(text: &str) -> Result<Self, String> {
        let v: serde_json::Value = serde_json::from_str(text).map_err(|_| "service account file is not JSON")?;
        let get = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
        let client_email = get("client_email").ok_or("service account without client_email")?;
        let token_uri = get("token_uri").ok_or("service account without token_uri")?;
        let key_id = get("private_key_id").unwrap_or_default();
        let pem = get("private_key").ok_or("service account without private_key")?;
        let der = pem_decode(&pem, "PRIVATE KEY").ok_or("service account key is not a PKCS#8 PEM")?;
        let key = RsaKeyPair::from_pkcs8(&der).map_err(|e| format!("service account key rejected: {}", e))?;
        if !token_uri.starts_with("https://") {
            return Err("service account token_uri must be https".into());
        }
        Ok(ServiceAccount { client_email, token_uri, key_id, key })
    }

    /// The RS256 assertion exchanged for an access token.
    pub fn assertion(&self, scope: &str, now: u64) -> Result<String, String> {
        let header = serde_json::json!({"alg": "RS256", "typ": "JWT", "kid": self.key_id});
        let claims = serde_json::json!({
            "iss": self.client_email,
            "scope": scope,
            "aud": self.token_uri,
            "iat": now,
            "exp": now + 3600,
        });
        sign_compact(&header, &claims, |m| {
            let mut sig = vec![0u8; self.key.public_modulus_len()];
            self.key
                .sign(&RSA_PKCS1_SHA256, &SystemRandom::new(), m, &mut sig)
                .map_err(|_| "RS256 signing failed".to_string())?;
            Ok(sig)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_lc_rs::signature::{KeyPair, UnparsedPublicKey, ECDSA_P256_SHA256_FIXED};
    use base64::Engine;

    fn pem(label: &str, der: &[u8]) -> String {
        format!(
            "-----BEGIN {l}-----\n{}\n-----END {l}-----\n",
            base64::engine::general_purpose::STANDARD.encode(der),
            l = label
        )
    }

    #[test]
    fn es256_token_verifies_under_the_key_and_is_reused_for_twenty_minutes() {
        let rng = SystemRandom::new();
        let doc = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
        let jwt = Es256Jwt::from_p8(&pem("PRIVATE KEY", doc.as_ref()), "KEY123", "TEAM456").unwrap();
        let t = jwt.token(1_000).unwrap();
        let parts: Vec<&str> = t.split('.').collect();
        assert_eq!(parts.len(), 3);
        let header: serde_json::Value =
            serde_json::from_slice(&crate::messages::b64url_decode(parts[0]).unwrap()).unwrap();
        assert_eq!(header["alg"], "ES256");
        assert_eq!(header["kid"], "KEY123");
        let claims: serde_json::Value =
            serde_json::from_slice(&crate::messages::b64url_decode(parts[1]).unwrap()).unwrap();
        assert_eq!(claims["iss"], "TEAM456");
        let sig = crate::messages::b64url_decode(parts[2]).unwrap();
        let pk = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, doc.as_ref()).unwrap();
        UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, pk.public_key().as_ref())
            .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &sig)
            .unwrap();
        assert_eq!(jwt.token(1_000 + 60).unwrap(), t);
        assert_ne!(jwt.token(1_000 + 1_200).unwrap(), t);
    }

    #[test]
    fn a_key_that_is_not_pkcs8_is_refused() {
        assert!(Es256Jwt::from_p8("not a key", "k", "t").is_err());
    }
}
