//! Identities of the QNet app that the evidence must name. The site publishes the same values in
//! `applications/qnet-explorer/frontend/src/lib/app-links.ts`; a test keeps the two equal.

/// Apple Developer Team ID of Orrery Group LLC.
pub const IOS_TEAM_ID: &str = "33H36C42XS";
pub const IOS_BUNDLE_ID: &str = "com.qnetmobile";
/// `<TeamID>.<bundle id>`: the App Attest RP ID and the receipt App ID.
pub const IOS_APP_ID: &str = "33H36C42XS.com.qnetmobile";

/// The one Android package that runs a node, from Google Play and from aiqnet.io alike.
pub const ANDROID_PACKAGE: &str = "io.aiqnet.wallet";

/// SHA-256 of the Play app-signing certificate: the store build (`trust = store`).
pub const ANDROID_STORE_CERT_SHA256: [u8; 32] = [
    0x2A, 0xA5, 0xA0, 0xB0, 0x40, 0xDD, 0xD2, 0x50, 0x3A, 0xEA, 0x28, 0xBC, 0xAC, 0x8D, 0x47, 0x89, 0x24, 0x7D, 0x8A,
    0xE4, 0x7A, 0x20, 0xB4, 0x9B, 0x6A, 0xC6, 0xB1, 0xE1, 0xBE, 0x7D, 0xD0, 0x4A,
];

/// SHA-256 of the release key that signs uploads and local builds (`trust = test`).
pub const ANDROID_UPLOAD_CERT_SHA256: [u8; 32] = [
    0xF2, 0x17, 0x49, 0x46, 0xC9, 0x7C, 0x9A, 0x3B, 0xAD, 0x3B, 0x16, 0x92, 0x14, 0x95, 0xF3, 0x22, 0x92, 0xE8, 0x5A,
    0x05, 0x18, 0xCA, 0xD6, 0x22, 0x98, 0x2B, 0x3E, 0x70, 0xA1, 0x57, 0xCE, 0x59,
];

#[cfg(test)]
mod tests {
    use super::*;

    fn fingerprint(bytes: &[u8; 32]) -> String {
        bytes.iter().map(|b| format!("{:02X}", b)).collect::<Vec<_>>().join(":")
    }

    fn site_constant(source: &str, name: &str) -> Option<String> {
        let line = source.lines().find(|l| l.contains(&format!("const {}", name)))?;
        let start = line.find('\'')? + 1;
        let end = line[start..].find('\'')? + start;
        Some(line[start..end].to_string())
    }

    #[test]
    fn matches_the_site_values() {
        let path =
            concat!(env!("CARGO_MANIFEST_DIR"), "/../../applications/qnet-explorer/frontend/src/lib/app-links.ts");
        let source = std::fs::read_to_string(path).expect("app-links.ts");
        let site = |name: &str| site_constant(&source, name);
        assert_eq!(site("IOS_TEAM_ID").as_deref(), Some(IOS_TEAM_ID));
        assert_eq!(site("IOS_BUNDLE_ID").as_deref(), Some(IOS_BUNDLE_ID));
        assert_eq!(site("ANDROID_PLAY_PACKAGE").as_deref(), Some(ANDROID_PACKAGE));
        assert_eq!(site("ANDROID_PLAY_CERT_SHA256"), Some(fingerprint(&ANDROID_STORE_CERT_SHA256)));
        // The site serves the Play-signed file only; the upload key is never published as an app identity.
        assert!(!source.contains(&fingerprint(&ANDROID_UPLOAD_CERT_SHA256)));
        assert_ne!(ANDROID_UPLOAD_CERT_SHA256, ANDROID_STORE_CERT_SHA256);
        assert_eq!(IOS_APP_ID, format!("{}.{}", IOS_TEAM_ID, IOS_BUNDLE_ID));
    }
}
