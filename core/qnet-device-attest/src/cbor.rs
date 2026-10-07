//! Minimal CBOR decoder for the vendor structures: definite lengths only, no tags, no floats, bounded
//! nesting, duplicate map keys refused. Never panics on hostile input.

use crate::Refusal;

const MAX_DEPTH: usize = 16;
const M: Refusal = Refusal::Malformed("cbor");

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Value<'a> {
    Uint(u64),
    /// The negative integer `-1 - n`.
    Nint(u64),
    Bytes(&'a [u8]),
    Text(&'a str),
    Array(Vec<Value<'a>>),
    Map(Vec<(Value<'a>, Value<'a>)>),
    Bool(bool),
    Null,
}

impl<'a> Value<'a> {
    pub fn get(&self, key: &Value<'_>) -> Option<&Value<'a>> {
        match self {
            Value::Map(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn get_text_key(&self, key: &str) -> Option<&Value<'a>> {
        self.get(&Value::Text(key))
    }

    /// The value under an integer key (positive or negative).
    pub fn get_int_key(&self, key: i64) -> Option<&Value<'a>> {
        let k = if key >= 0 { Value::Uint(key as u64) } else { Value::Nint((-1 - key) as u64) };
        self.get(&k)
    }

    pub fn as_bytes(&self) -> Option<&'a [u8]> {
        match self {
            Value::Bytes(b) => Some(b),
            _ => None,
        }
    }

    pub fn as_text(&self) -> Option<&'a str> {
        match self {
            Value::Text(t) => Some(t),
            _ => None,
        }
    }

    /// An integer as i128, so every CBOR integer fits.
    pub fn as_int(&self) -> Option<i128> {
        match self {
            Value::Uint(n) => Some(*n as i128),
            Value::Nint(n) => Some(-1 - *n as i128),
            _ => None,
        }
    }
}

/// Decodes exactly one item that spans all of `data`.
pub(crate) fn decode(data: &[u8]) -> Result<Value<'_>, Refusal> {
    let (v, used) = decode_prefix(data)?;
    if used != data.len() {
        return Err(M);
    }
    Ok(v)
}

/// Decodes one item from the start of `data`; returns it and the bytes it used.
pub(crate) fn decode_prefix(data: &[u8]) -> Result<(Value<'_>, usize), Refusal> {
    let mut pos = 0;
    let v = item(data, &mut pos, 0)?;
    Ok((v, pos))
}

fn head(data: &[u8], pos: &mut usize) -> Result<(u8, u8, u64), Refusal> {
    let ib = *data.get(*pos).ok_or(M)?;
    *pos += 1;
    let major = ib >> 5;
    let ai = ib & 0x1f;
    let arg = match ai {
        0..=23 => ai as u64,
        24..=27 => {
            let n = 1usize << (ai - 24);
            let bytes = data.get(*pos..*pos + n).ok_or(M)?;
            *pos += n;
            bytes.iter().fold(0u64, |acc, &b| (acc << 8) | b as u64)
        }
        _ => return Err(M),
    };
    Ok((major, ai, arg))
}

fn take<'a>(data: &'a [u8], pos: &mut usize, len: u64) -> Result<&'a [u8], Refusal> {
    let len = usize::try_from(len).map_err(|_| M)?;
    let end = pos.checked_add(len).ok_or(M)?;
    let out = data.get(*pos..end).ok_or(M)?;
    *pos = end;
    Ok(out)
}

fn item<'a>(data: &'a [u8], pos: &mut usize, depth: usize) -> Result<Value<'a>, Refusal> {
    if depth > MAX_DEPTH {
        return Err(M);
    }
    let (major, ai, arg) = head(data, pos)?;
    match major {
        0 => Ok(Value::Uint(arg)),
        1 => Ok(Value::Nint(arg)),
        2 => Ok(Value::Bytes(take(data, pos, arg)?)),
        3 => {
            let raw = take(data, pos, arg)?;
            Ok(Value::Text(std::str::from_utf8(raw).map_err(|_| M)?))
        }
        4 => {
            // Every element takes at least one byte: a count beyond the input is refused up front.
            if arg > (data.len() - *pos) as u64 {
                return Err(M);
            }
            let mut out = Vec::new();
            for _ in 0..arg {
                out.push(item(data, pos, depth + 1)?);
            }
            Ok(Value::Array(out))
        }
        5 => {
            if arg.saturating_mul(2) > (data.len() - *pos) as u64 {
                return Err(M);
            }
            let mut out: Vec<(Value<'a>, Value<'a>)> = Vec::new();
            for _ in 0..arg {
                let k = item(data, pos, depth + 1)?;
                if matches!(k, Value::Array(_) | Value::Map(_)) || out.iter().any(|(e, _)| *e == k) {
                    return Err(M);
                }
                let v = item(data, pos, depth + 1)?;
                out.push((k, v));
            }
            Ok(Value::Map(out))
        }
        7 => match ai {
            20 => Ok(Value::Bool(false)),
            21 => Ok(Value::Bool(true)),
            22 => Ok(Value::Null),
            _ => Err(M),
        },
        _ => Err(M),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_maps_with_mixed_keys() {
        // {1: 2, -1: h'0102', "a": true}
        let data = [0xa3, 0x01, 0x02, 0x20, 0x42, 0x01, 0x02, 0x61, b'a', 0xf5];
        let v = decode(&data).unwrap();
        assert_eq!(v.get_int_key(1).and_then(Value::as_int), Some(2));
        assert_eq!(v.get_int_key(-1).and_then(Value::as_bytes), Some(&[1u8, 2][..]));
        assert_eq!(v.get_text_key("a"), Some(&Value::Bool(true)));
    }

    #[test]
    fn refuses_what_the_vendors_never_send() {
        assert!(decode(&[0x5f, 0x41, 0x00, 0xff]).is_err()); // indefinite byte string
        assert!(decode(&[0xc1, 0x00]).is_err()); // tag
        assert!(decode(&[0xfb, 0, 0, 0, 0, 0, 0, 0, 0]).is_err()); // float
        assert!(decode(&[0xa2, 0x01, 0x00, 0x01, 0x00]).is_err()); // duplicate key
        assert!(decode(&[0x62, 0xff, 0xfe]).is_err()); // invalid UTF-8
        assert!(decode(&[0x01, 0x00]).is_err()); // trailing byte
        assert!(decode(&[0x9b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]).is_err()); // huge count
        assert!(decode(&[0x5b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]).is_err()); // huge length
        assert!(decode(&[0xa1, 0x80, 0x00]).is_err()); // array as a map key
    }

    #[test]
    fn bounds_nesting() {
        let data = vec![0x81u8; 64];
        assert!(decode(&data).is_err());
    }

    #[test]
    fn prefix_reports_the_bytes_used() {
        let (v, used) = decode_prefix(&[0x01, 0xa0]).unwrap();
        assert_eq!((v, used), (Value::Uint(1), 1));
    }
}
