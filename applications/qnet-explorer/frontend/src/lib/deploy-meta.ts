import { sanitizeLogo } from './sanitize-logo';

// QRC-20 metadata parsed from a contract's ContractDeploy `data` JSON
// ({symbol,decimals,logo,qrc20}). Used to render token transfers without a node round-trip.
export interface DeployMeta {
  symbol: string;
  decimals: number;
  logo: string;
}

export function parseDeployMeta(dataStr: string | null): DeployMeta {
  let symbol = '';
  let decimals = 9; // node default
  let logo = '';
  if (dataStr) {
    try {
      const d = JSON.parse(dataStr) as { symbol?: unknown; decimals?: unknown; logo?: unknown };
      if (typeof d.symbol === 'string') symbol = d.symbol;
      if (typeof d.decimals === 'number' && Number.isInteger(d.decimals) && d.decimals >= 0 && d.decimals <= 30) {
        decimals = d.decimals;
      }
      logo = sanitizeLogo(d.logo);
    } catch { /* keep defaults */ }
  }
  return { symbol, decimals, logo };
}
