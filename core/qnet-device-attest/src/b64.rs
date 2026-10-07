//! Base64 forms used by the evidence.

use base64::alphabet;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig, URL_SAFE_NO_PAD};
use base64::engine::DecodePaddingMode;
use base64::Engine;

/// Canonical b64url: URL alphabet, no padding, zero padding bits (spec section 2).
pub(crate) fn url_canonical(s: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(s).ok()
}

const LENIENT: GeneralPurposeConfig =
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent);
const URL_LENIENT: GeneralPurpose = GeneralPurpose::new(&alphabet::URL_SAFE, LENIENT);
const STD_LENIENT: GeneralPurpose = GeneralPurpose::new(&alphabet::STANDARD, LENIENT);

/// Either alphabet, padding optional: for values Google encodes, whose padding it does not fix.
pub(crate) fn lenient(s: &str) -> Option<Vec<u8>> {
    URL_LENIENT.decode(s).ok().or_else(|| STD_LENIENT.decode(s).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_refuses_padding_and_stray_bits() {
        assert_eq!(url_canonical("AQI").unwrap(), vec![1, 2]);
        assert!(url_canonical("AQI=").is_none());
        assert!(url_canonical("AQJ").is_none()); // non-zero padding bits
        assert!(url_canonical("A").is_none());
        assert!(url_canonical("+/8").is_none());
    }

    #[test]
    fn lenient_takes_both_alphabets() {
        assert_eq!(lenient("-_8").unwrap(), vec![0xfb, 0xff]);
        assert_eq!(lenient("+/8=").unwrap(), vec![0xfb, 0xff]);
        assert!(lenient("*").is_none());
    }
}
