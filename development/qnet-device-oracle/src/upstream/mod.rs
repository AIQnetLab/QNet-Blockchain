//! Clients of the vendor services. All HTTP goes through `HttpClient`, so tests use a scripted fake and
//! never reach a vendor. Tokens pass through memory only.

pub mod appattest;
pub mod crl;
pub mod devicecheck;
pub mod jwt;
pub mod playintegrity;

use parking_lot::Mutex;
use std::collections::HashMap;
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
}

#[derive(Clone, Debug)]
pub struct HttpRequest {
    pub method: Method,
    pub url: String,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpResponse {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

pub trait HttpClient: Send + Sync {
    /// `Err` is a transport failure (DNS, connect, TLS, timeout).
    fn send(&self, req: &HttpRequest) -> Result<HttpResponse, String>;
}

/// Largest vendor response read into memory (the revocation list is the big one).
const MAX_RESPONSE: u64 = 16 << 20;

pub struct ReqwestHttp {
    client: reqwest::blocking::Client,
}

impl ReqwestHttp {
    pub fn new(timeout: Duration) -> Result<Self, String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(timeout)
            .connect_timeout(Duration::from_secs(5))
            .https_only(true)
            .user_agent("qnet-device-oracle")
            .build()
            .map_err(|e| e.to_string())?;
        Ok(ReqwestHttp { client })
    }
}

impl HttpClient for ReqwestHttp {
    fn send(&self, req: &HttpRequest) -> Result<HttpResponse, String> {
        use std::io::Read;
        let mut b = match req.method {
            Method::Get => self.client.get(&req.url),
            Method::Post => self.client.post(&req.url).body(req.body.clone()),
        };
        for (k, v) in &req.headers {
            b = b.header(*k, v);
        }
        // The error text of a failed request may carry the URL, never a body or a token.
        let resp = b.send().map_err(|e| e.without_url().to_string())?;
        let status = resp.status().as_u16();
        let headers = resp
            .headers()
            .iter()
            .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.as_str().to_string(), v.to_string())))
            .collect();
        let mut body = Vec::new();
        resp.take(MAX_RESPONSE).read_to_end(&mut body).map_err(|e| e.to_string())?;
        Ok(HttpResponse { status, headers, body })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VendorError {
    /// Transport failure, 429 or 5xx: an outage, never the device's fault.
    Unavailable(String),
    /// The vendor refused the token or the payload as invalid.
    Rejected(String),
    /// Our own credentials or configuration were refused: an outage for the device, an alert for us.
    Config(String),
}

impl VendorError {
    /// Whether the device may be blamed for the failure.
    pub fn is_rejection(&self) -> bool {
        matches!(self, VendorError::Rejected(_))
    }
    pub fn message(&self) -> &str {
        match self {
            VendorError::Unavailable(m) | VendorError::Rejected(m) | VendorError::Config(m) => m,
        }
    }
}

/// Default classification of a non-success status.
pub fn classify_status(status: u16, what: &str) -> VendorError {
    match status {
        401 | 403 => VendorError::Config(format!("{} status={}", what, status)),
        429 | 500..=599 => VendorError::Unavailable(format!("{} status={}", what, status)),
        _ => VendorError::Rejected(format!("{} status={}", what, status)),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Service {
    DeviceCheck,
    AppAttestData,
    PlayRecall,
    GoogleAuth,
    Crl,
}

impl Service {
    pub fn as_str(self) -> &'static str {
        match self {
            Service::DeviceCheck => "devicecheck",
            Service::AppAttestData => "appattest_data",
            Service::PlayRecall => "play_recall",
            Service::GoogleAuth => "google_auth",
            Service::Crl => "crl",
        }
    }
}

#[derive(Clone, Debug, Default)]
struct OutageState {
    started_at: Option<u64>,
    failures: u32,
}

/// Consecutive-failure tracking per vendor service. An outage starts at the first failure of a run.
#[derive(Default)]
pub struct Outages {
    inner: Mutex<HashMap<Service, OutageState>>,
}

/// Failures in a row that make a run of failures an alert.
pub const OUTAGE_ALERT_AFTER: u32 = 3;

impl Outages {
    /// Records a failure; returns the outage start and whether this failure crossed the alert threshold.
    pub fn failure(&self, s: Service, now: u64) -> (u64, bool) {
        let mut m = self.inner.lock();
        let st = m.entry(s).or_default();
        let started = *st.started_at.get_or_insert(now);
        st.failures += 1;
        (started, st.failures == OUTAGE_ALERT_AFTER)
    }

    /// Records a success; returns the start of the outage it ended, if one had been alerted.
    pub fn success(&self, s: Service) -> Option<u64> {
        let mut m = self.inner.lock();
        let st = m.entry(s).or_default();
        let alerted = st.failures >= OUTAGE_ALERT_AFTER;
        let started = st.started_at.take();
        st.failures = 0;
        if alerted {
            started
        } else {
            None
        }
    }

    pub fn started(&self, s: Service) -> Option<u64> {
        self.inner.lock().get(&s).and_then(|st| st.started_at)
    }

    pub fn snapshot(&self) -> Vec<(&'static str, u64, u32)> {
        let m = self.inner.lock();
        let mut v: Vec<_> = m
            .iter()
            .filter_map(|(s, st)| st.started_at.map(|t| (s.as_str(), t, st.failures)))
            .collect();
        v.sort();
        v
    }
}

#[cfg(test)]
pub mod fake {
    //! Scripted HTTP for tests: responses are matched by URL substring, in order.
    use super::*;
    use std::collections::VecDeque;

    #[derive(Default)]
    pub struct FakeHttp {
        pub script: Mutex<VecDeque<(String, Result<HttpResponse, String>)>>,
        /// Answers used whenever no scripted response matches.
        pub sticky: Mutex<Vec<(String, HttpResponse)>>,
        pub seen: Mutex<Vec<HttpRequest>>,
    }

    impl FakeHttp {
        pub fn sticky(&self, url_part: &str, status: u16, body: &[u8]) {
            self.sticky
                .lock()
                .push((url_part.to_string(), HttpResponse { status, headers: vec![], body: body.to_vec() }));
        }
        pub fn count(&self, url_part: &str) -> usize {
            self.seen.lock().iter().filter(|r| r.url.contains(url_part)).count()
        }
        pub fn push(&self, url_part: &str, status: u16, body: &[u8]) {
            self.script.lock().push_back((
                url_part.to_string(),
                Ok(HttpResponse { status, headers: vec![], body: body.to_vec() }),
            ));
        }
        pub fn push_err(&self, url_part: &str) {
            self.script.lock().push_back((url_part.to_string(), Err("connect timeout".into())));
        }
    }

    /// A throwaway Apple provider-token signer.
    pub fn test_jwt() -> std::sync::Arc<super::jwt::Es256Jwt> {
        use aws_lc_rs::signature::{EcdsaKeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
        use base64::Engine;
        let doc = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &aws_lc_rs::rand::SystemRandom::new())
            .unwrap();
        let pem = format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
            base64::engine::general_purpose::STANDARD.encode(doc.as_ref())
        );
        std::sync::Arc::new(super::jwt::Es256Jwt::from_p8(&pem, "KID", "TEAM").unwrap())
    }

    impl HttpClient for FakeHttp {
        fn send(&self, req: &HttpRequest) -> Result<HttpResponse, String> {
            self.seen.lock().push(req.clone());
            let mut s = self.script.lock();
            let pos = s.iter().position(|(u, _)| req.url.contains(u.as_str()));
            if let Some(i) = pos {
                return s.remove(i).unwrap().1;
            }
            let st = self.sticky.lock();
            match st.iter().find(|(u, _)| req.url.contains(u.as_str())) {
                Some((_, r)) => Ok(r.clone()),
                None => panic!("unexpected request to {}", req.url),
            }
        }
    }
}
