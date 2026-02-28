// Must execute before any other module that uses crypto.subtle.
// react-native-quick-crypto.install() sets:
//   global.crypto = QuickCrypto  (provides crypto.subtle via OpenSSL JSI)
//   global.Buffer = Buffer        (react-native-buffer)
// react-native-quick-base64 is required by install() internally.
const QuickCrypto = require('react-native-quick-crypto');
QuickCrypto.install();

// TextEncoder / TextDecoder polyfill.
// Hermes < 0.14 and some RN 0.81 builds do not expose these as globals.
// Buffer (installed above by QuickCrypto.install()) is always available.
if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = class TextEncoder {
    constructor() { this.encoding = 'utf-8'; }
    encode(input) {
      const buf = global.Buffer.from(input == null ? '' : String(input), 'utf8');
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
  };
}

if (typeof global.TextDecoder === 'undefined') {
  global.TextDecoder = class TextDecoder {
    constructor(encoding) { this.encoding = encoding || 'utf-8'; }
    decode(input) {
      if (input == null) return '';
      const buf = input instanceof ArrayBuffer
        ? global.Buffer.from(input)
        : global.Buffer.from(input.buffer || input, input.byteOffset || 0, input.byteLength !== undefined ? input.byteLength : undefined);
      return buf.toString('utf8');
    }
  };
}
