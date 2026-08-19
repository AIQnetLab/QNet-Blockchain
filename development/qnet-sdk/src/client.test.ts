import {
  formatQNC,
  parseQNC,
  isValidQNetAddress,
  publicKeyHashToAddress,
  computeChecksum,
  buildUnsignedTransfer,
  buildRewardClaimPayload,
  toHex,
  fromHex,
} from './index';

// ─────────────────────────────────────────────────────────────────────────────
// formatQNC / parseQNC
// ─────────────────────────────────────────────────────────────────────────────

describe('formatQNC', () => {
  it('formats whole amounts', () => {
    expect(formatQNC('1000000000')).toBe('1 QNC');
  });
  it('formats fractional amounts', () => {
    expect(formatQNC('1500000000')).toBe('1.5 QNC');
  });
  it('handles zero', () => {
    expect(formatQNC('0')).toBe('0 QNC');
  });
  it('handles large amounts', () => {
    expect(formatQNC('100000000000000000')).toBe('100000000 QNC');
  });
  it('accepts bigint input', () => {
    expect(formatQNC(2_000_000_000n)).toBe('2 QNC');
  });
});

describe('parseQNC', () => {
  it('parses whole amounts', () => {
    expect(parseQNC('1 QNC')).toBe(1_000_000_000n);
  });
  it('parses fractional amounts', () => {
    expect(parseQNC('1.5 QNC')).toBe(1_500_000_000n);
  });
  it('parses without unit suffix', () => {
    expect(parseQNC('2.5')).toBe(2_500_000_000n);
  });
  it('round-trips with formatQNC', () => {
    const original = '123.456789 QNC';
    const parsed   = parseQNC(original);
    expect(formatQNC(parsed)).toBe('123.456789 QNC');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Address utilities
// ─────────────────────────────────────────────────────────────────────────────

describe('publicKeyHashToAddress + isValidQNetAddress', () => {
  it('derives a valid address from a 20-byte public key hash', () => {
    const hash = new Uint8Array(20).fill(0xAB);
    const addr = publicKeyHashToAddress(hash);
    expect(isValidQNetAddress(addr)).toBe(true);
  });

  it('produces unique addresses for different hashes', () => {
    const a1 = publicKeyHashToAddress(new Uint8Array(20).fill(0x01));
    const a2 = publicKeyHashToAddress(new Uint8Array(20).fill(0x02));
    expect(a1).not.toBe(a2);
  });

  it('rejects addresses with wrong length', () => {
    expect(isValidQNetAddress('deadbeef')).toBe(false);
  });

  it('rejects non-hex strings', () => {
    expect(isValidQNetAddress('not-hex-at-all!!')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidQNetAddress('')).toBe(false);
  });

  it('rejects address with wrong version byte', () => {
    // Derive valid address, then flip the first byte
    const hash   = new Uint8Array(20).fill(0x55);
    const addr   = publicKeyHashToAddress(hash);
    const hex    = addr.startsWith('0x') ? addr.slice(2) : addr;
    const tampered = '00' + hex.slice(2); // replace version byte
    expect(isValidQNetAddress(tampered)).toBe(false);
  });

  it('rejects address with corrupted checksum', () => {
    const hash   = new Uint8Array(20).fill(0xCC);
    const addr   = publicKeyHashToAddress(hash);
    const hex    = addr.startsWith('0x') ? addr.slice(2) : addr;
    // Flip last byte of checksum
    const lastByte  = parseInt(hex.slice(-2), 16);
    const flipped   = ((lastByte + 1) & 0xFF).toString(16).padStart(2, '0');
    const corrupted = hex.slice(0, -2) + flipped;
    expect(isValidQNetAddress(corrupted)).toBe(false);
  });
});

describe('computeChecksum', () => {
  it('is deterministic', () => {
    const body = new Uint8Array([0x19, 0xAB, 0xCD, 0xEF]);
    expect(computeChecksum(body)).toEqual(computeChecksum(body));
  });

  it('changes when body changes', () => {
    const a = computeChecksum(new Uint8Array([0x19, 0x01]));
    const b = computeChecksum(new Uint8Array([0x19, 0x02]));
    expect(a).not.toEqual(b);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Wallet — buildUnsignedTransfer / buildRewardClaimPayload
// ─────────────────────────────────────────────────────────────────────────────

describe('buildUnsignedTransfer', () => {
  const validFrom = publicKeyHashToAddress(new Uint8Array(20).fill(0x11));
  const validTo   = publicKeyHashToAddress(new Uint8Array(20).fill(0x22));

  it('throws on invalid sender', () => {
    expect(() => buildUnsignedTransfer({
      from:  'not-an-address',
      to:    validTo,
      value: '1000000000',
      nonce: 0,
    })).toThrow(/Invalid sender/);
  });

  it('throws on invalid recipient', () => {
    expect(() => buildUnsignedTransfer({
      from:  validFrom,
      to:    'bad-address',
      value: '1000000000',
      nonce: 0,
    })).toThrow(/Invalid recipient/);
  });

  it('returns a non-empty signing payload', () => {
    const tx = buildUnsignedTransfer({ from: validFrom, to: validTo, value: '1000000000', nonce: 1 });
    expect(tx.signingPayload.length).toBeGreaterThan(0);
    expect(tx.fee).toBe('100000');
    expect(tx.nonce).toBe(1);
    expect(tx.value).toBe('1000000000');
  });

  it('uses provided custom fee', () => {
    const tx = buildUnsignedTransfer({
      from:  validFrom,
      to:    validTo,
      value: '500000000',
      fee:   '200000',
      nonce: 2,
    });
    expect(tx.fee).toBe('200000');
  });

  it('sets a recent timestamp', () => {
    const before = Math.floor(Date.now() / 1000) - 1;
    const tx     = buildUnsignedTransfer({ from: validFrom, to: validTo, value: '1', nonce: 0 });
    expect(tx.timestamp).toBeGreaterThanOrEqual(before);
  });
});

describe('buildRewardClaimPayload', () => {
  // The node verifies this string verbatim as UTF-8; it is not hex-encoded and it binds the node id.
  it('is the exact message the node verifies', () => {
    const addr    = publicKeyHashToAddress(new Uint8Array(20).fill(0x77));
    const payload = buildRewardClaimPayload('super_node_007', addr);
    expect(payload).toBe(`q1337|claim_rewards:super_node_007:${addr}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Contract argument / payload hex
// ─────────────────────────────────────────────────────────────────────────────

describe('toHex', () => {
  it('encodes bytes without a prefix, two lowercase digits each', () => {
    expect(toHex(new Uint8Array([0x00, 0x0f, 0xa0, 0xff]))).toBe('000fa0ff');
  });

  it('encodes empty arguments as an empty string', () => {
    expect(toHex(new Uint8Array())).toBe('');
  });
});

describe('fromHex', () => {
  it('decodes a payload back to the same bytes', () => {
    const bytes = new Uint8Array([1, 2, 3, 250]);
    expect(Array.from(fromHex(toHex(bytes)))).toEqual([1, 2, 3, 250]);
  });

  it('accepts a 0x prefix', () => {
    expect(Array.from(fromHex('0x0102'))).toEqual([1, 2]);
  });

  it('rejects a non-hex or odd-length payload', () => {
    expect(() => fromHex('0102030')).toThrow();
    expect(() => fromHex('zz')).toThrow();
  });
});
