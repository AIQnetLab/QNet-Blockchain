import {
  formatQNC,
  parseQNC,
  isValidQNetAddress,
  publicKeyHashToAddress,
  computeChecksum,
  buildUnsignedTransfer,
  buildRewardClaimPayload,
  encodeCalldata,
  decodeUint64,
  decodeBool,
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
  it('produces a hex string containing the address', () => {
    const addr    = publicKeyHashToAddress(new Uint8Array(20).fill(0x77));
    const payload = buildRewardClaimPayload(addr);
    const decoded = Buffer.from(payload, 'hex').toString('utf8');
    expect(decoded).toBe(`CLAIM_REWARDS:${addr}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Contract calldata encoding / decoding
// ─────────────────────────────────────────────────────────────────────────────

describe('encodeCalldata', () => {
  it('encodes the selector as the first 4 bytes', () => {
    const data = encodeCalldata(1, []);
    expect(data).toBe('0x00000001');
  });

  it('encodes a uint64 argument correctly', () => {
    const data = encodeCalldata(2, [{ type: 'uint64', value: 256n }]);
    // selector 0x00000002 + 8-byte 256 = 0x0000000000000100
    expect(data).toBe('0x000000020000000000000100');
  });

  it('encodes a bool true', () => {
    const data = encodeCalldata(3, [{ type: 'bool', value: true }]);
    expect(data.endsWith('01')).toBe(true);
  });

  it('encodes a bool false', () => {
    const data = encodeCalldata(3, [{ type: 'bool', value: false }]);
    expect(data.endsWith('00')).toBe(true);
  });

  it('handles multiple mixed arguments', () => {
    const addr = publicKeyHashToAddress(new Uint8Array(20).fill(0xAA));
    const data = encodeCalldata(1, [
      { type: 'address', value: addr },
      { type: 'uint64',  value: 1_000_000_000n },
    ]);
    expect(data.startsWith('0x00000001')).toBe(true);
    expect(data.length).toBeGreaterThan(10);
  });
});

describe('decodeUint64', () => {
  it('decodes a known value', () => {
    expect(decodeUint64('0000000000000001')).toBe(1n);
    expect(decodeUint64('0000000000000064')).toBe(100n);
  });

  it('handles 0x prefix', () => {
    expect(decodeUint64('0x0000000000000005')).toBe(5n);
  });
});

describe('decodeBool', () => {
  it('decodes true', () => {
    expect(decodeBool('0x01')).toBe(true);
  });
  it('decodes false', () => {
    expect(decodeBool('0x00')).toBe(false);
  });
});
