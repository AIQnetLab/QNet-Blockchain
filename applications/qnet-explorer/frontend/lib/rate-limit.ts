// Simple in-memory rate limiter
// For production, use Redis-based rate limiting

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();
const MAX_STORE_SIZE = 10000; // Maximum entries to prevent memory leak

// Clean up old entries every 1 minute (more frequent cleanup)
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, entry] of rateLimitStore.entries()) {
    if (entry.resetTime < now) {
      rateLimitStore.delete(key);
      cleaned++;
    }
  }
  // If store is still too large, remove oldest entries
  if (rateLimitStore.size > MAX_STORE_SIZE) {
    const entries = Array.from(rateLimitStore.entries())
      .sort((a, b) => a[1].resetTime - b[1].resetTime);
    const toRemove = rateLimitStore.size - MAX_STORE_SIZE;
    for (let i = 0; i < toRemove; i++) {
      rateLimitStore.delete(entries[i][0]);
    }
  }
}, 60 * 1000); // 1 minute

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: number;
}

export function rateLimit(
  identifier: string,
  maxRequests: number,
  windowMs: number
): RateLimitResult {
  // Validate inputs
  if (!identifier || typeof identifier !== 'string') {
    return { allowed: false, remaining: 0, resetTime: Date.now() + windowMs };
  }
  if (!Number.isInteger(maxRequests) || maxRequests < 1) {
    return { allowed: false, remaining: 0, resetTime: Date.now() + windowMs };
  }
  
  // Prevent memory leak: limit store size
  if (rateLimitStore.size >= MAX_STORE_SIZE && !rateLimitStore.has(identifier)) {
    // Store is full and this is a new identifier - reject to prevent memory leak
    return { allowed: false, remaining: 0, resetTime: Date.now() + windowMs };
  }
  
  const now = Date.now();
  const key = identifier;
  
  let entry = rateLimitStore.get(key);
  
  if (!entry || entry.resetTime < now) {
    // Create new window
    entry = {
      count: 1,
      resetTime: now + windowMs
    };
    rateLimitStore.set(key, entry);
    return {
      allowed: true,
      remaining: maxRequests - 1,
      resetTime: entry.resetTime
    };
  }
  
  // Increment count
  entry.count++;
  
  if (entry.count > maxRequests) {
    return {
      allowed: false,
      remaining: 0,
      resetTime: entry.resetTime
    };
  }
  
  rateLimitStore.set(key, entry);
  return {
    allowed: true,
    remaining: maxRequests - entry.count,
    resetTime: entry.resetTime
  };
}

// Get client IP from request with validation
export function getClientIdentifier(request: Request): string {
  // Try to get real IP from headers (if behind proxy)
  // Note: x-forwarded-for can be spoofed, but in production should be validated by reverse proxy
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    // Take first IP and validate format
    const firstIp = forwarded.split(',')[0].trim();
    // Basic IP validation (IPv4 or IPv6)
    if (/^[0-9a-fA-F:.]+$/.test(firstIp) && firstIp.length <= 45) {
      return firstIp;
    }
  }
  
  const realIp = request.headers.get('x-real-ip');
  if (realIp) {
    // Validate IP format
    if (/^[0-9a-fA-F:.]+$/.test(realIp) && realIp.length <= 45) {
      return realIp;
    }
  }
  
  // Fallback: use a session-based identifier if available
  // In production, this should be handled by reverse proxy with proper IP extraction
  return 'unknown';
}

