// Monitoring and alerting system for security events
// Note: This module is imported by security.ts, so we avoid circular dependency

export interface SecurityAlert {
  event: 'hash_mismatch' | 'data_tampering' | 'integrity_check_failed' | 'suspicious_activity';
  timestamp: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  details: Record<string, unknown>;
  count: number;
}

// In-memory alert store (for production, use Redis or database)
const alertStore = new Map<string, SecurityAlert>();
const MAX_ALERTS = 1000; // Prevent memory leak

// Alert thresholds
const ALERT_THRESHOLDS = {
  hash_mismatch: { severity: 'high' as const, threshold: 1 },
  data_tampering: { severity: 'critical' as const, threshold: 1 },
  integrity_check_failed: { severity: 'high' as const, threshold: 5 },
  suspicious_activity: { severity: 'medium' as const, threshold: 10 },
};

// Alert aggregation window (5 minutes)
const ALERT_WINDOW_MS = 5 * 60 * 1000;

// Clean up old alerts
setInterval(() => {
  const now = Date.now();
  for (const [key, alert] of alertStore.entries()) {
    const alertTime = new Date(alert.timestamp).getTime();
    if (now - alertTime > ALERT_WINDOW_MS) {
      alertStore.delete(key);
    }
  }
  
  // If still too large, remove oldest
  if (alertStore.size > MAX_ALERTS) {
    const entries = Array.from(alertStore.entries())
      .sort((a, b) => new Date(a[1].timestamp).getTime() - new Date(b[1].timestamp).getTime());
    const toRemove = alertStore.size - MAX_ALERTS;
    for (let i = 0; i < toRemove; i++) {
      alertStore.delete(entries[i][0]);
    }
  }
}, 60 * 1000); // Cleanup every minute

// Generate alert key for aggregation
function getAlertKey(
  event: SecurityAlert['event'],
  details: Record<string, unknown>
): string {
  // Create key from event type and critical details
  const criticalFields: string[] = ['hash', 'address', 'ip'];
  const keyParts: string[] = [event];
  
  for (const field of criticalFields) {
    if (details[field]) {
      keyParts.push(`${field}:${String(details[field])}`);
    }
  }
  
  return keyParts.join('|');
}

// Send alert to monitoring system
async function sendAlert(alert: SecurityAlert): Promise<void> {
  // Send to webhook if configured
  if (process.env.SECURITY_WEBHOOK_URL) {
    try {
      const webhookUrl = new URL(process.env.SECURITY_WEBHOOK_URL);
      if (webhookUrl.protocol !== 'https:' && webhookUrl.protocol !== 'http:') {
        return;
      }
      
      // Block private IPs
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
        return;
      }
      
      await fetch(webhookUrl.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alert: {
            event: alert.event,
            severity: alert.severity,
            timestamp: alert.timestamp,
            count: alert.count,
            details: alert.details,
          },
        }),
        signal: AbortSignal.timeout(5000),
      }).catch(err => {
        // console.error('[Monitoring] Failed to send alert to webhook:', err);
      });
    } catch {
      // Invalid webhook URL, skip
    }
  }
  
  // Email alerts disabled
}

// Process security event and generate alerts
// Note: This function does NOT call logSecurityEvent to avoid circular dependency
// logSecurityEvent should be called separately before calling this function
export async function processSecurityEvent(
  event: SecurityAlert['event'],
  details: Record<string, unknown>
): Promise<void> {
  // Get alert configuration
  const config = ALERT_THRESHOLDS[event];
  if (!config) {
    return;
  }
  
  // Generate alert key for aggregation
  const alertKey = getAlertKey(event, details);
  
  // Get or create alert
  let alert = alertStore.get(alertKey);
  const now = new Date().toISOString();
  
  if (!alert) {
    alert = {
      event,
      timestamp: now,
      severity: config.severity,
      details,
      count: 1,
    };
    alertStore.set(alertKey, alert);
  } else {
    // Update existing alert
    alert.count++;
    alert.timestamp = now;
    // Merge details
    alert.details = { ...alert.details, ...details };
  }
  
  // Check if threshold exceeded
  if (alert.count >= config.threshold) {
    await sendAlert(alert);
    
    // Reset count after alert sent (to prevent spam)
    alert.count = 0;
  }
}

// Get recent alerts
export function getRecentAlerts(limit: number = 50): SecurityAlert[] {
  const alerts = Array.from(alertStore.values())
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit);
  
  return alerts;
}

// Get alert statistics
export function getAlertStats(): {
  total: number;
  bySeverity: Record<string, number>;
  byEvent: Record<string, number>;
} {
  const alerts = Array.from(alertStore.values());
  
  const bySeverity: Record<string, number> = {};
  const byEvent: Record<string, number> = {};
  
  for (const alert of alerts) {
    bySeverity[alert.severity] = (bySeverity[alert.severity] || 0) + 1;
    byEvent[alert.event] = (byEvent[alert.event] || 0) + 1;
  }
  
  return {
    total: alerts.length,
    bySeverity,
    byEvent,
  };
}

// Health check endpoint data
export function getMonitoringHealth(): {
  status: 'healthy' | 'degraded' | 'unhealthy';
  alerts: number;
  criticalAlerts: number;
  lastAlert?: string;
} {
  const alerts = Array.from(alertStore.values());
  const criticalAlerts = alerts.filter(a => a.severity === 'critical').length;
  const lastAlert = alerts.length > 0 
    ? alerts.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0].timestamp
    : undefined;
  
  let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
  if (criticalAlerts > 0) {
    status = 'unhealthy';
  } else if (alerts.length > 100) {
    status = 'degraded';
  }
  
  return {
    status,
    alerts: alerts.length,
    criticalAlerts,
    lastAlert,
  };
}

