//! The Android device report (spec section 5.3): canonical JSON of nine booleans, signed by the new
//! device key. Its flags are trustworthy only together with a verified key attestation of that key
//! (locked, verified boot; the store app) and a Play Integrity verdict naming the same report.

use crate::crypto::DevicePublicKey;
use crate::Refusal;

const KEYS: [&str; 9] =
    ["arc", "automotive", "embedded", "feature_pc", "hsum", "leanback", "system_user", "touchscreen", "watch"];

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DeviceReport {
    pub arc: bool,
    pub automotive: bool,
    pub embedded: bool,
    pub feature_pc: bool,
    pub hsum: bool,
    pub leanback: bool,
    pub system_user: bool,
    pub touchscreen: bool,
    pub watch: bool,
}

impl DeviceReport {
    /// Parses the exact canonical text: these keys in this order, `true`/`false`, no spaces.
    pub fn parse(text: &str) -> Result<DeviceReport, Refusal> {
        const M: Refusal = Refusal::Malformed("device report");
        let body = text.strip_prefix('{').and_then(|t| t.strip_suffix('}')).ok_or(M)?;
        let parts: Vec<&str> = body.split(',').collect();
        if parts.len() != KEYS.len() {
            return Err(M);
        }
        let mut v = [false; 9];
        for (i, (part, key)) in parts.iter().zip(KEYS).enumerate() {
            let value = part
                .strip_prefix('"')
                .and_then(|p| p.strip_prefix(key))
                .and_then(|p| p.strip_prefix("\":"))
                .ok_or(M)?;
            v[i] = match value {
                "true" => true,
                "false" => false,
                _ => return Err(M),
            };
        }
        Ok(DeviceReport {
            arc: v[0],
            automotive: v[1],
            embedded: v[2],
            feature_pc: v[3],
            hsum: v[4],
            leanback: v[5],
            system_user: v[6],
            touchscreen: v[7],
            watch: v[8],
        })
    }

    /// A phone or tablet: no computer, ChromeOS, TV, car, watch or embedded features, and a touchscreen.
    pub fn check_form_factor(&self) -> Result<(), Refusal> {
        let other = self.arc || self.automotive || self.embedded || self.feature_pc || self.leanback || self.watch;
        if other || !self.touchscreen {
            return Err(Refusal::FormFactor);
        }
        Ok(())
    }

    /// The main profile of a device that is not in headless system user mode.
    pub fn check_main_profile(&self) -> Result<(), Refusal> {
        if !self.system_user || self.hsum {
            return Err(Refusal::SecondaryUser);
        }
        Ok(())
    }
}

/// Parses the report, checks `report_sig` (the device key's DER signature over the report's UTF-8
/// bytes) and the phone-or-tablet and main-profile rules.
pub fn verify_device_report(text: &str, report_sig: &[u8], key: &DevicePublicKey) -> Result<DeviceReport, Refusal> {
    let report = DeviceReport::parse(text)?;
    key.verify_der(text.as_bytes(), report_sig)?;
    report.check_form_factor()?;
    report.check_main_profile()?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = concat!(
        "{\"arc\":false,\"automotive\":false,\"embedded\":false,\"feature_pc\":false,\"hsum\":false,",
        "\"leanback\":false,\"system_user\":true,\"touchscreen\":true,\"watch\":false}"
    );

    #[test]
    fn parses_the_canonical_form_only() {
        let r = DeviceReport::parse(GOOD).unwrap();
        assert!(r.system_user && r.touchscreen && !r.feature_pc);
        for bad in [
            GOOD.replace(":false,", ": false,"),
            GOOD.replace("\"arc\":false,\"automotive\":false", "\"automotive\":false,\"arc\":false"),
            GOOD.replace("true", "1"),
            GOOD.replacen('{', "{ ", 1),
            format!("{},\"extra\":true}}", &GOOD[..GOOD.len() - 1]),
            GOOD[..GOOD.len() - 1].to_string(),
        ] {
            assert_eq!(DeviceReport::parse(&bad).unwrap_err(), Refusal::Malformed("device report"), "{}", bad);
        }
    }

    #[test]
    fn form_factor_and_profile_rules() {
        let base = DeviceReport::parse(GOOD).unwrap();
        assert!(base.check_form_factor().is_ok() && base.check_main_profile().is_ok());
        let mutations: [fn(&mut DeviceReport); 7] = [
            |r: &mut DeviceReport| r.arc = true,
            |r: &mut DeviceReport| r.automotive = true,
            |r: &mut DeviceReport| r.embedded = true,
            |r: &mut DeviceReport| r.feature_pc = true,
            |r: &mut DeviceReport| r.leanback = true,
            |r: &mut DeviceReport| r.watch = true,
            |r: &mut DeviceReport| r.touchscreen = false,
        ];
        for f in mutations {
            let mut r = base;
            f(&mut r);
            assert_eq!(r.check_form_factor().unwrap_err(), Refusal::FormFactor);
        }
        let mut r = base;
        r.system_user = false;
        assert_eq!(r.check_main_profile().unwrap_err(), Refusal::SecondaryUser);
        let mut r = base;
        r.hsum = true;
        assert_eq!(r.check_main_profile().unwrap_err(), Refusal::SecondaryUser);
    }
}
