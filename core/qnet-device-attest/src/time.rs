//! Certificate and receipt times as Unix seconds.

use crate::Refusal;

const M: Refusal = Refusal::Malformed("time");

/// Clocks of the vendors, the genesis nodes and the oracle differ; validity windows and creation
/// times are read with this much slack either way.
pub(crate) const CLOCK_SKEW_SECS: i64 = 300;

fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ => {
            if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 {
                29
            } else {
                28
            }
        }
    }
}

/// Days since 1970-01-01 of a proleptic Gregorian date.
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = month as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn unix(year: i64, month: u32, day: u32, h: u32, mi: u32, s: u32) -> Result<i64, Refusal> {
    if !(1..=12).contains(&month) || day == 0 || day > days_in_month(year, month) || h > 23 || mi > 59 || s > 59 {
        return Err(M);
    }
    Ok(days_from_civil(year, month, day) * 86_400 + (h * 3600 + mi * 60 + s) as i64)
}

fn digits(b: &[u8]) -> Result<u32, Refusal> {
    if b.is_empty() || !b.iter().all(u8::is_ascii_digit) {
        return Err(M);
    }
    Ok(b.iter().fold(0u32, |acc, &d| acc * 10 + (d - b'0') as u32))
}

/// UTCTime `YYMMDDHHMMSSZ`; years 50..99 are 19xx (RFC 5280).
pub(crate) fn utc_time(b: &[u8]) -> Result<i64, Refusal> {
    if b.len() != 13 || b[12] != b'Z' {
        return Err(M);
    }
    let yy = digits(&b[0..2])? as i64;
    let year = if yy >= 50 { 1900 + yy } else { 2000 + yy };
    unix(year, digits(&b[2..4])?, digits(&b[4..6])?, digits(&b[6..8])?, digits(&b[8..10])?, digits(&b[10..12])?)
}

/// GeneralizedTime `YYYYMMDDHHMMSSZ` (RFC 5280: no fraction).
pub(crate) fn generalized_time(b: &[u8]) -> Result<i64, Refusal> {
    if b.len() != 15 || b[14] != b'Z' {
        return Err(M);
    }
    let year = digits(&b[0..4])? as i64;
    unix(year, digits(&b[4..6])?, digits(&b[6..8])?, digits(&b[8..10])?, digits(&b[10..12])?, digits(&b[12..14])?)
}

/// `YYYY-MM-DDTHH:MM:SS[.fraction]Z`, as in App Attest receipts; the fraction is dropped.
pub(crate) fn iso8601(s: &[u8]) -> Result<i64, Refusal> {
    if s.len() < 20 || s[s.len() - 1] != b'Z' {
        return Err(M);
    }
    let sep = |i: usize, c: u8| if s[i] == c { Ok(()) } else { Err(M) };
    sep(4, b'-')?;
    sep(7, b'-')?;
    sep(10, b'T')?;
    sep(13, b':')?;
    sep(16, b':')?;
    let rest = &s[19..s.len() - 1];
    if !rest.is_empty() && (rest[0] != b'.' || rest.len() < 2 || !rest[1..].iter().all(u8::is_ascii_digit)) {
        return Err(M);
    }
    unix(
        digits(&s[0..4])? as i64,
        digits(&s[5..7])?,
        digits(&s[8..10])?,
        digits(&s[11..13])?,
        digits(&s[14..16])?,
        digits(&s[17..19])?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_instants() {
        assert_eq!(utc_time(b"700101000000Z").unwrap(), 0);
        assert_eq!(utc_time(b"260420181312Z").unwrap(), 1_776_708_792);
        assert_eq!(generalized_time(b"20480101000000Z").unwrap(), 2_461_449_600);
        assert_eq!(generalized_time(b"19691231235959Z").unwrap(), -1);
        assert_eq!(iso8601(b"2026-04-21T18:13:12.153Z").unwrap(), 1_776_795_192);
        assert_eq!(iso8601(b"2000-02-29T00:00:00Z").unwrap(), 951_782_400);
    }

    #[test]
    fn refuses_invalid_dates() {
        assert!(utc_time(b"260230000000Z").is_err()); // 30 February
        assert!(utc_time(b"261301000000Z").is_err());
        assert!(utc_time(b"260101240000Z").is_err());
        assert!(utc_time(b"2601010000Z").is_err());
        assert!(generalized_time(b"20260101000000.5Z").is_err());
        assert!(iso8601(b"2026-04-21 18:13:12Z").is_err());
        assert!(iso8601(b"2026-04-21T18:13:12.Z").is_err());
        assert!(iso8601(b"2100-02-29T00:00:00Z").is_err());
    }
}
