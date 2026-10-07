//! UTC calendar arithmetic on Unix seconds (proleptic Gregorian, days-from-civil algorithm).

pub const DAY: u64 = 86_400;

pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let m = m as i64;
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// (year, month) of a Unix time.
pub fn year_month(unix: u64) -> (i64, u32) {
    let z = (unix / DAY) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    (y, m)
}

/// Unix time of the first day of a month.
pub fn month_start(y: i64, m: u32) -> u64 {
    (days_from_civil(y, m, 1).max(0) as u64) * DAY
}

/// `YYYY-MM-DDTHH:MM:SS[.fraction]Z` to Unix seconds; `None` for anything else.
pub fn parse_rfc3339_utc(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || (b[10] != b'T' && b[10] != b't') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<u32> {
        let t = s.get(r)?;
        t.bytes().all(|c| c.is_ascii_digit()).then(|| t.parse().ok())?
    };
    let (y, mo, d, h, mi, se) = (num(0..4)?, num(5..7)?, num(8..10)?, num(11..13)?, num(14..16)?, num(17..19)?);
    let rest = &s[19..];
    let rest = match rest.strip_prefix('.') {
        Some(f) => {
            let digits = f.bytes().take_while(|c| c.is_ascii_digit()).count();
            if digits == 0 {
                return None;
            }
            &f[digits..]
        }
        None => rest,
    };
    if rest != "Z" && rest != "z" {
        return None;
    }
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    let days = days_from_civil(y as i64, mo, d);
    if days < 0 {
        return None;
    }
    Some(days as u64 * DAY + h as u64 * 3600 + mi as u64 * 60 + se as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_known_dates() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(year_month(1_790_000_000), (2026, 9));
        assert_eq!(month_start(2026, 9), 1_788_220_800);
        assert_eq!(parse_rfc3339_utc("2026-04-21T18:13:12.153Z"), Some(1_776_795_192));
        assert_eq!(parse_rfc3339_utc("2000-02-29T00:00:00Z"), Some(951_782_400));
        assert_eq!(parse_rfc3339_utc("2026-04-21 18:13:12Z"), None);
        assert_eq!(parse_rfc3339_utc("2026-04-21T18:13:12+01:00"), None);
    }
}
