// The token rules of the mobile app's Assets list (utils/tokenSafety.js), compiled from its source: a token named
// after QNet's own coin (a hidden or format character counts as one), its symbol or name as shown (those characters
// replaced by U+FFFD), its short contract id, and the address that destroys the tokens sent to it.
export {
  contractShortId, destroysTokens, tokenLabel, usesReservedName,
} from '../../../../qnet-mobile/src/utils/tokenSafety.js';
