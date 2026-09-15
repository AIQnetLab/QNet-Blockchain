// ============================================================================
// Shared transaction type mapping and amount formatting
// Single source of truth — used by SSR page, API routes, and client components
// ============================================================================

// Extract the QRC-20/contract method name from a ContractCall's `data`
// payload. `data` is a JSON string {"method": "...", "args": [...]}. Returns ''
// when there is no decodable method. Exported so the tx detail page can decode
// transfers without re-implementing the parse.
export function extractContractMethod(data: unknown): string {
  if (!data) return '';
  let obj: unknown = data;
  if (typeof data === 'string') {
    try { obj = JSON.parse(data); } catch { return ''; }
  }
  if (typeof obj !== 'object' || obj === null) return '';
  const method = (obj as { method?: unknown }).method;
  return typeof method === 'string' ? method : '';
}

// Map raw DB tx_type → display category
// v3.15: Claims from system_rewards_pool show as Transfer
// A ContractCall carries a `data` JSON with a method name; pass it as `data` so
// this can split the single "Contract" label into:
//   ContractDeploy            -> "Deploy"
//   ContractCall (transfer/transferFrom) -> "Token Transfer"
//   ContractCall (other)      -> "Contract Call"
export function mapTxType(
  type: string | object | undefined,
  fromAddress?: string,
  data?: unknown
): string {
  if (!type) return 'Transfer';

  if (fromAddress === 'system_rewards_pool') return 'Transfer';

  const typeStr = typeof type === 'object' ? Object.keys(type)[0] || '' : String(type);
  const normalized = typeStr.toLowerCase().replace(/_/g, '').replace(/-/g, '').replace(/\s+/g, '');

  // Smart-contract types: split the old single "Contract" bucket.
  if (normalized === 'contractdeploy') return 'Deploy';
  if (normalized === 'contractcall') {
    const method = extractContractMethod(data);
    if (method === 'transfer' || method === 'transferFrom') return 'Token Transfer';
    return 'Contract Call';
  }

  const map: Record<string, string> = {
    // User transactions
    transfer: 'Transfer',
    batchtransfers: 'Transfer',
    swap: 'Swap',

    // Node lifecycle
    nodeactivation: 'Activation',
    batchnodeactivations: 'Activation',
    noderegistration: 'Registration',
    registration: 'Registration',

    // Rewards
    rewarddistribution: 'Reward',
    batchrewardclaims: 'Reward',
    systemreward: 'Reward',
    systemrewards: 'Reward',
    systememission: 'Reward',
    emission: 'Reward',
    reward: 'Reward',

    // Heartbeat (super-node liveness attestation)
    heartbeatcommitment: 'Heartbeat',
    heartbeat: 'Heartbeat',

    // Light eligibility (ping/bitmap attestations)
    lightnodeeligibilitybitmap: 'Light Eligibility',
    bitmapcommitment: 'Light Eligibility',
    pingattestation: 'Light Eligibility',
    pingcommitmentwithsampling: 'Light Eligibility',

    // Smart Contracts (contractdeploy / contractcall handled above so the
    // method-aware Deploy / Token Transfer / Contract Call split applies)

    // System
    createaccount: 'System',
    system: 'System',
  };

  return map[normalized] || 'System';
}

// Format nanoQNC → QNC with full precision
// v3.52: Dynamic precision — never lose small amounts, trim trailing zeros
export function formatAmount(amount: number | string | undefined): string {
  // Zero-value txs (Heartbeat, Registration, Activation, light attestations, system) carry no QNC:
  // render a bare "0" with NO unit — the render sink also drops the coin icon (unit present iff value).
  if (!amount) return '0';
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (num === 0 || !Number.isFinite(num)) return '0';
  const qnc = num / 1e9;

  if (qnc >= 0.01) {
    return qnc.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }) + ' QNC';
  }

  const fixed = qnc.toFixed(9);
  const trimmed = fixed.replace(/\.?0+$/, '');
  const [intPart, decPart] = trimmed.split('.');
  const intFormatted = Number(intPart).toLocaleString('en-US');
  return decPart ? intFormatted + '.' + decPart + ' QNC' : intFormatted + ' QNC';
}
