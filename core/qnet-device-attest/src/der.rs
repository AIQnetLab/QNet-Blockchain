//! Minimal ASN.1 reader: strict DER, plus the indefinite lengths of BER where the caller asks for
//! them (the App Attest receipt is BER). Never panics on hostile input; nesting is bounded.

use crate::Refusal;
use std::borrow::Cow;

const MAX_DEPTH: usize = 12;
/// Upper bound for a reassembled constructed OCTET STRING.
const MAX_OCTETS: usize = 64 * 1024;

pub(crate) const BOOLEAN: u8 = 0x01;
pub(crate) const INTEGER: u8 = 0x02;
pub(crate) const BIT_STRING: u8 = 0x03;
pub(crate) const OCTET_STRING: u8 = 0x04;
pub(crate) const NULL: u8 = 0x05;
pub(crate) const OID: u8 = 0x06;
pub(crate) const ENUMERATED: u8 = 0x0a;
pub(crate) const UTF8_STRING: u8 = 0x0c;
pub(crate) const PRINTABLE_STRING: u8 = 0x13;
pub(crate) const T61_STRING: u8 = 0x14;
pub(crate) const IA5_STRING: u8 = 0x16;
pub(crate) const UTC_TIME: u8 = 0x17;
pub(crate) const GENERALIZED_TIME: u8 = 0x18;
pub(crate) const SEQUENCE: u8 = 0x30;
pub(crate) const SET: u8 = 0x31;

const M: Refusal = Refusal::Malformed("asn1");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Class {
    Universal,
    Application,
    Context,
    Private,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Tag {
    pub class: Class,
    pub constructed: bool,
    pub number: u32,
}

impl Tag {
    /// A universal tag from its one-byte encoding (`SEQUENCE`, `INTEGER`, ...).
    pub const fn universal(byte: u8) -> Tag {
        Tag { class: Class::Universal, constructed: byte & 0x20 != 0, number: (byte & 0x1f) as u32 }
    }

    pub const fn context(number: u32, constructed: bool) -> Tag {
        Tag { class: Class::Context, constructed, number }
    }

    pub fn is(&self, byte: u8) -> bool {
        *self == Tag::universal(byte)
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Tlv<'a> {
    pub tag: Tag,
    /// Content octets; for an indefinite length, the children without the end-of-contents marker.
    pub value: &'a [u8],
    /// The whole encoding, header included.
    pub raw: &'a [u8],
    ber: bool,
    depth: usize,
}

#[derive(Clone)]
pub(crate) struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
    ber: bool,
    depth: usize,
}

fn parse_tag(data: &[u8], pos: &mut usize) -> Result<Tag, Refusal> {
    let b = *data.get(*pos).ok_or(M)?;
    *pos += 1;
    let class = match b >> 6 {
        0 => Class::Universal,
        1 => Class::Application,
        2 => Class::Context,
        _ => Class::Private,
    };
    let constructed = b & 0x20 != 0;
    let mut number = (b & 0x1f) as u32;
    if number == 0x1f {
        number = 0;
        let mut count = 0;
        loop {
            let nb = *data.get(*pos).ok_or(M)?;
            *pos += 1;
            if count == 0 && nb == 0x80 {
                return Err(M);
            }
            count += 1;
            if count > 4 {
                return Err(M);
            }
            number = (number << 7) | (nb & 0x7f) as u32;
            if nb & 0x80 == 0 {
                break;
            }
        }
        if number < 0x1f {
            return Err(M);
        }
    }
    Ok(Tag { class, constructed, number })
}

/// `None` is an indefinite length.
fn parse_len(data: &[u8], pos: &mut usize, allow_indefinite: bool) -> Result<Option<usize>, Refusal> {
    let b = *data.get(*pos).ok_or(M)?;
    *pos += 1;
    if b < 0x80 {
        return Ok(Some(b as usize));
    }
    if b == 0x80 {
        return if allow_indefinite { Ok(None) } else { Err(M) };
    }
    let n = (b & 0x7f) as usize;
    if n > 4 {
        return Err(M);
    }
    let bytes = data.get(*pos..*pos + n).ok_or(M)?;
    *pos += n;
    if bytes[0] == 0 {
        return Err(M);
    }
    let len = bytes.iter().fold(0usize, |acc, &x| (acc << 8) | x as usize);
    if len < 0x80 {
        return Err(M);
    }
    Ok(Some(len))
}

impl<'a> Reader<'a> {
    pub fn der(data: &'a [u8]) -> Self {
        Reader { data, pos: 0, ber: false, depth: 0 }
    }

    pub fn ber(data: &'a [u8]) -> Self {
        Reader { data, pos: 0, ber: true, depth: 0 }
    }

    pub fn is_empty(&self) -> bool {
        self.pos >= self.data.len()
    }

    pub fn peek_tag(&self) -> Option<Tag> {
        let mut p = self.pos;
        parse_tag(self.data, &mut p).ok()
    }

    pub fn read(&mut self) -> Result<Tlv<'a>, Refusal> {
        if self.depth > MAX_DEPTH {
            return Err(M);
        }
        let start = self.pos;
        let mut p = start;
        let tag = parse_tag(self.data, &mut p)?;
        match parse_len(self.data, &mut p, self.ber && tag.constructed)? {
            Some(len) => {
                let end = p.checked_add(len).ok_or(M)?;
                let value = self.data.get(p..end).ok_or(M)?;
                let raw = &self.data[start..end];
                self.pos = end;
                Ok(Tlv { tag, value, raw, ber: self.ber, depth: self.depth })
            }
            None => {
                let mut child = Reader { data: self.data, pos: p, ber: true, depth: self.depth + 1 };
                loop {
                    match self.data.get(child.pos) {
                        None => return Err(M),
                        Some(0) => {
                            if self.data.get(child.pos + 1) != Some(&0) {
                                return Err(M);
                            }
                            break;
                        }
                        Some(_) => {
                            child.read()?;
                        }
                    }
                }
                let value = &self.data[p..child.pos];
                let end = child.pos + 2;
                let raw = &self.data[start..end];
                self.pos = end;
                Ok(Tlv { tag, value, raw, ber: true, depth: self.depth })
            }
        }
    }

    /// Reads the next element and requires the given tag.
    pub fn expect(&mut self, tag: Tag) -> Result<Tlv<'a>, Refusal> {
        let tlv = self.read()?;
        if tlv.tag != tag {
            return Err(M);
        }
        Ok(tlv)
    }

    pub fn expect_universal(&mut self, byte: u8) -> Result<Tlv<'a>, Refusal> {
        self.expect(Tag::universal(byte))
    }

    /// Reads the next element only when it carries the given tag.
    pub fn optional(&mut self, tag: Tag) -> Result<Option<Tlv<'a>>, Refusal> {
        if self.peek_tag() == Some(tag) {
            Ok(Some(self.read()?))
        } else {
            Ok(None)
        }
    }

    /// Requires that nothing is left.
    pub fn finish(&self) -> Result<(), Refusal> {
        if self.is_empty() {
            Ok(())
        } else {
            Err(M)
        }
    }
}

impl<'a> Tlv<'a> {
    /// A reader over the content, one level deeper.
    pub fn reader(&self) -> Result<Reader<'a>, Refusal> {
        if self.depth + 1 > MAX_DEPTH {
            return Err(M);
        }
        Ok(Reader { data: self.value, pos: 0, ber: self.ber, depth: self.depth + 1 })
    }

    fn primitive(&self, byte: u8) -> Result<&'a [u8], Refusal> {
        if !self.tag.is(byte) {
            return Err(M);
        }
        Ok(self.value)
    }

    /// A non-negative INTEGER or ENUMERATED that fits in 64 bits.
    pub fn uint(&self) -> Result<u64, Refusal> {
        if !(self.tag.is(INTEGER) || self.tag.is(ENUMERATED)) {
            return Err(M);
        }
        uint_from_bytes(self.value)
    }

    /// INTEGER content octets, sign included.
    pub fn integer_bytes(&self) -> Result<&'a [u8], Refusal> {
        let v = self.primitive(INTEGER)?;
        if v.is_empty() {
            return Err(M);
        }
        Ok(v)
    }

    pub fn octets(&self) -> Result<&'a [u8], Refusal> {
        self.primitive(OCTET_STRING)
    }

    pub fn oid(&self) -> Result<&'a [u8], Refusal> {
        let v = self.primitive(OID)?;
        if v.is_empty() {
            return Err(M);
        }
        Ok(v)
    }

    /// BIT STRING content without the unused-bits octet, which must be zero.
    pub fn bit_string(&self) -> Result<&'a [u8], Refusal> {
        let v = self.primitive(BIT_STRING)?;
        match v.split_first() {
            Some((0, rest)) => Ok(rest),
            _ => Err(M),
        }
    }

    pub fn null(&self) -> Result<(), Refusal> {
        if self.primitive(NULL)?.is_empty() {
            Ok(())
        } else {
            Err(M)
        }
    }

    /// A BOOLEAN; the second value is true when the encoding is BER-only (true not as 0xFF).
    pub fn boolean_lenient(&self) -> Result<(bool, bool), Refusal> {
        match self.primitive(BOOLEAN)? {
            [0x00] => Ok((false, false)),
            [0xff] => Ok((true, false)),
            [_] => Ok((true, true)),
            _ => Err(M),
        }
    }

    /// The character content of the directory string types used in names.
    pub fn string_bytes(&self) -> Result<&'a [u8], Refusal> {
        let t = self.tag;
        if t.is(UTF8_STRING) || t.is(PRINTABLE_STRING) || t.is(IA5_STRING) || t.is(T61_STRING) {
            Ok(self.value)
        } else {
            Err(M)
        }
    }

    /// OCTET STRING content in BER: primitive, or constructed from primitive segments.
    pub fn octets_ber(&self) -> Result<Cow<'a, [u8]>, Refusal> {
        if self.tag.is(OCTET_STRING) {
            return Ok(Cow::Borrowed(self.value));
        }
        if self.tag != (Tag { class: Class::Universal, constructed: true, number: 4 }) {
            return Err(M);
        }
        let mut out = Vec::new();
        let mut r = self.reader()?;
        while !r.is_empty() {
            let seg = r.read()?;
            let part = seg.octets_ber()?;
            if out.len() + part.len() > MAX_OCTETS {
                return Err(M);
            }
            out.extend_from_slice(&part);
        }
        Ok(Cow::Owned(out))
    }
}

pub(crate) fn uint_from_bytes(v: &[u8]) -> Result<u64, Refusal> {
    match v.first() {
        None => return Err(M),
        Some(b) if b & 0x80 != 0 => return Err(M),
        _ => {}
    }
    let trimmed = match v.iter().position(|&b| b != 0) {
        Some(i) => &v[i..],
        None => return Ok(0),
    };
    if trimmed.len() > 8 {
        return Err(M);
    }
    Ok(trimmed.iter().fold(0u64, |acc, &b| (acc << 8) | b as u64))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_definite_and_high_tags() {
        // [709] EXPLICIT OCTET STRING "ab"
        let data = [0xbf, 0x85, 0x45, 0x04, 0x04, 0x02, b'a', b'b'];
        let mut r = Reader::der(&data);
        let t = r.read().unwrap();
        assert_eq!(t.tag, Tag::context(709, true));
        let inner = t.reader().unwrap().expect_universal(OCTET_STRING).unwrap();
        assert_eq!(inner.value, b"ab");
        assert!(r.finish().is_ok());
    }

    #[test]
    fn refuses_non_minimal_forms_in_der() {
        assert!(Reader::der(&[0x04, 0x81, 0x01, 0x00]).read().is_err()); // long form for a short length
        assert!(Reader::der(&[0x04, 0x82, 0x00, 0x80]).read().is_err()); // leading zero length octet
        assert!(Reader::der(&[0x9f, 0x05, 0x00]).read().is_err()); // high form for a low tag number
        assert!(Reader::der(&[0x9f, 0x80, 0x01, 0x00]).read().is_err()); // padded tag number
        assert!(Reader::der(&[0x30, 0x80, 0x00, 0x00]).read().is_err()); // indefinite length
        assert!(Reader::der(&[0x04, 0x85, 1, 0, 0, 0, 0]).read().is_err()); // length of length > 4
        assert!(Reader::der(&[0x04, 0x05, 0x00]).read().is_err()); // truncated
    }

    #[test]
    fn reads_indefinite_lengths_in_ber() {
        // SEQUENCE (indef) { OCTET STRING (constructed, indef) { "ab", "c" } }
        let data = [0x30, 0x80, 0x24, 0x80, 0x04, 0x02, b'a', b'b', 0x04, 0x01, b'c', 0, 0, 0, 0];
        let mut r = Reader::ber(&data);
        let seq = r.read().unwrap();
        assert!(r.finish().is_ok());
        let mut inner = seq.reader().unwrap();
        let os = inner.read().unwrap();
        assert_eq!(&*os.octets_ber().unwrap(), b"abc");
        assert!(inner.finish().is_ok());
        // A missing end-of-contents marker fails.
        assert!(Reader::ber(&data[..data.len() - 2]).read().is_err());
    }

    #[test]
    fn bounds_nesting() {
        let mut data = Vec::new();
        for _ in 0..64 {
            data.extend_from_slice(&[0x30, 0x80]);
        }
        for _ in 0..64 {
            data.extend_from_slice(&[0, 0]);
        }
        assert!(Reader::ber(&data).read().is_err());
    }

    #[test]
    fn integers_and_booleans() {
        assert_eq!(uint_from_bytes(&[0x00, 0xff]).unwrap(), 255);
        assert_eq!(uint_from_bytes(&[0x00]).unwrap(), 0);
        assert!(uint_from_bytes(&[0x80]).is_err());
        assert!(uint_from_bytes(&[0x01; 9]).is_err());
        let t = Reader::der(&[0x01, 0x01, 0x01]).read().unwrap();
        assert_eq!(t.boolean_lenient().unwrap(), (true, true));
        let t = Reader::der(&[0x01, 0x01, 0xff]).read().unwrap();
        assert_eq!(t.boolean_lenient().unwrap(), (true, false));
    }
}
