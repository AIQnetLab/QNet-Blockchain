// Types of applications/qnet-wallet/tools/crypto-bundle/src/lightclient.js (the account-proof fold), which build.mjs
// compiles into the SDK.
export interface ProvenAccount {
  address: string;
  balance: string;
  nonce: string;
  lastClaimedEpoch?: string;
  isNode?: boolean;
}

export function verifyAccountProof(
  account: ProvenAccount, proof: Array<{ sibling: string; is_right: boolean }>, stateRoot: string,
): boolean;
