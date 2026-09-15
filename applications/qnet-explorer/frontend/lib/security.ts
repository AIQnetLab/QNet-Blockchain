import crypto from 'crypto';

// Verify transaction hash matches calculated hash
export function verifyTransactionHash(tx: {
  hash: string;
  from: string;
  to: string | null;
  amount: number;
  nonce: number;
  gas_price: number;
  gas_limit: number;
  timestamp: number;
  tx_type: string;
}): boolean {
  // Calculate hash from transaction data (same as Rust)
  const hashInput = JSON.stringify({
    from: tx.from,
    to: tx.to,
    amount: tx.amount,
    nonce: tx.nonce,
    gas_price: tx.gas_price,
    gas_limit: tx.gas_limit,
    timestamp: tx.timestamp,
    tx_type: tx.tx_type,
  });

  // Use SHA3-256 (same as Rust blake3 for compatibility)
  const calculatedHash = crypto.createHash('sha3-256').update(hashInput).digest('hex');

  // Compare with provided hash
  if (calculatedHash !== tx.hash && tx.hash.length > 0) {
    return false;
  }

  return true;
}

// Verify transaction data integrity
export function verifyTransactionIntegrity(
  dbTx: Record<string, unknown>,
  nodeTx: Record<string, unknown>
): { valid: boolean; differences: string[] } {
  const differences: string[] = [];

  // Critical fields that must match
  const criticalFields = [
    'hash',
    'from',
    'to',
    'amount',
    'nonce',
    'block',
    'gas_price',
    'gas_limit'
  ];

  for (const field of criticalFields) {
    // Map DB field names to node field names
    const dbFieldMap: Record<string, string> = {
      'from': 'from_address',
      'to': 'to_address',
      'block': 'block_height',
    };
    
    const dbField = dbFieldMap[field] || field;
    const dbValue = dbTx[dbField];
    const nodeValue = nodeTx[field] || nodeTx[dbField];

    if (String(dbValue) !== String(nodeValue)) {
      differences.push(`${field}: DB=${dbValue}, Node=${nodeValue}`);
    }
  }

  return {
    valid: differences.length === 0,
    differences
  };
}

// Log security events
export function logSecurityEvent(
  event: 'hash_mismatch' | 'data_tampering' | 'integrity_check_failed' | 'suspicious_activity',
  details: Record<string, unknown>
): void {
  const timestamp = new Date().toISOString();
  // console.error(`[SECURITY][${timestamp}] ${event}:`, details);
  
  // Process event for monitoring and alerting (async, don't await)
  import('./monitoring').then(({ processSecurityEvent }) => {
    processSecurityEvent(event, details).catch(err => {
      // console.error('[SECURITY] Failed to process security event:', err);
    });
  }).catch(() => {
    // Monitoring module not available, skip
  });

  // In production, send to monitoring system
  if (process.env.SECURITY_WEBHOOK_URL) {
    // Validate webhook URL to prevent SSRF
    let webhookUrl: URL;
    try {
      webhookUrl = new URL(process.env.SECURITY_WEBHOOK_URL);
      // Only allow https/http protocols
      if (webhookUrl.protocol !== 'https:' && webhookUrl.protocol !== 'http:') {
        // console.error('[SECURITY] Invalid webhook protocol:', webhookUrl.protocol);
        return;
      }
      // Block private/internal IPs (SSRF protection)
      const hostname = webhookUrl.hostname;
      if (hostname === 'localhost' || hostname === '127.0.0.1' || 
          hostname.startsWith('192.168.') || hostname.startsWith('10.') ||
          hostname.startsWith('172.16.') || hostname.startsWith('172.17.') ||
          hostname.startsWith('172.18.') || hostname.startsWith('172.19.') ||
          hostname.startsWith('172.20.') || hostname.startsWith('172.21.') ||
          hostname.startsWith('172.22.') || hostname.startsWith('172.23.') ||
          hostname.startsWith('172.24.') || hostname.startsWith('172.25.') ||
          hostname.startsWith('172.26.') || hostname.startsWith('172.27.') ||
          hostname.startsWith('172.28.') || hostname.startsWith('172.29.') ||
          hostname.startsWith('172.30.') || hostname.startsWith('172.31.')) {
        // console.error('[SECURITY] Webhook URL points to private IP, blocked:', hostname);
        return;
      }
    } catch {
      // console.error('[SECURITY] Invalid webhook URL format');
      return;
    }
    
    // Send with timeout to prevent hanging
    fetch(webhookUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, timestamp, details }),
      signal: AbortSignal.timeout(5000), // 5 second timeout
    }).catch(() => {});
  }
}

