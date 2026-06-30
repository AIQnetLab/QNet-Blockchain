// ============================================================================
// Shared transaction type mapping and amount formatting
// Single source of truth — used by SSR page, API routes, and client components
// ============================================================================

// Map raw DB tx_type → display category
// v3.15: Claims from system_rewards_pool show as Transfer
export function mapTxType(type: string | object | undefined, fromAddress?: string): string {
  if (!type) return 'Transfer';

  if (fromAddress === 'system_rewards_pool') return 'Transfer';

  const typeStr = typeof type === 'object' ? Object.keys(type)[0] || '' : String(type);
  const normalized = typeStr.toLowerCase().replace(/_/g, '').replace(/-/g, '').replace(/\s+/g, '');

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

    // Smart Contracts
    contractdeploy: 'Contract',
    contractcall: 'Contract',

    // System
    createaccount: 'System',
    system: 'System',
  };

  return map[normalized] || 'System';
}

// Format nanoQNC → QNC with full precision
// v3.52: Dynamic precision — never lose small amounts, trim trailing zeros
export function formatAmount(amount: number | string | undefined): string {
  if (!amount) return '0 QNC';
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (num === 0 || !Number.isFinite(num)) return '0 QNC';
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
