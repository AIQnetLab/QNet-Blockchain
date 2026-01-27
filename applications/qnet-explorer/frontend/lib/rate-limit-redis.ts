// Redis-based rate limiter for distributed systems
// Falls back to in-memory rate limiter if Redis is unavailable

import { rateLimit as memoryRateLimit, getClientIdentifier } from './rate-limit';

let redisClient: any = null;
let redisAvailable = false;

// Initialize Redis client
async function initRedis(): Promise<void> {
  if (redisClient) return;
  
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.log('[RateLimit] Redis not configured, using in-memory rate limiter');
    return;
  }
  
  try {
    // Try to import redis client
    const redis = await import('ioredis');
    
    redisClient = new redis.Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => {
        if (times > 3) {
          return null; // Stop retrying
        }
        return Math.min(times * 50, 2000);
      },
      connectTimeout: 2000,
      lazyConnect: true,
    });
    
    redisClient.on('error', (err: Error) => {
      // console.error('[RateLimit] Redis error:', err);
      redisAvailable = false;
    });
    
    redisClient.on('connect', () => {
      console.log('[RateLimit] Redis connected');
      redisAvailable = true;
    });
    
    redisClient.on('ready', () => {
      console.log('[RateLimit] Redis ready');
      redisAvailable = true;
    });
    
    await redisClient.connect();
    redisAvailable = true;
  } catch (err) {
    console.warn('[RateLimit] Failed to initialize Redis, using in-memory rate limiter:', err);
    redisAvailable = false;
  }
}

// Initialize on module load
if (process.env.REDIS_URL) {
  initRedis().catch(err => {
    console.warn('[RateLimit] Redis initialization failed:', err);
  });
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: number;
}

// Redis-based rate limiting
async function rateLimitRedis(
  identifier: string,
  maxRequests: number,
  windowMs: number
): Promise<RateLimitResult> {
  if (!redisClient || !redisAvailable) {
    // Fallback to in-memory rate limiter
    return memoryRateLimit(identifier, maxRequests, windowMs);
  }
  
  try {
    const key = `ratelimit:${identifier}`;
    const now = Date.now();
    const windowStart = now - windowMs;
    
    // Use Redis pipeline for atomic operations
    const pipeline = redisClient.pipeline();
    
    // Remove old entries (outside window)
    pipeline.zremrangebyscore(key, 0, windowStart);
    
    // Count current requests in window
    pipeline.zcard(key);
    
    // Add current request
    pipeline.zadd(key, now, `${now}-${Math.random()}`);
    
    // Set expiration
    pipeline.expire(key, Math.ceil(windowMs / 1000));
    
    const results = await pipeline.exec();
    
    if (!results || results.length < 2) {
      throw new Error('Redis pipeline failed');
    }
    
    const currentCount = results[1][1] as number;
    const resetTime = now + windowMs;
    
    if (currentCount >= maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        resetTime,
      };
    }
    
    return {
      allowed: true,
      remaining: maxRequests - currentCount - 1,
      resetTime,
    };
  } catch (err) {
    console.warn('[RateLimit] Redis error, falling back to in-memory:', err);
    redisAvailable = false;
    return memoryRateLimit(identifier, maxRequests, windowMs);
  }
}

// Main rate limit function (Redis with fallback)
export async function rateLimit(
  identifier: string,
  maxRequests: number,
  windowMs: number
): Promise<RateLimitResult> {
  // Validate inputs
  if (!identifier || typeof identifier !== 'string') {
    return { allowed: false, remaining: 0, resetTime: Date.now() + windowMs };
  }
  if (!Number.isInteger(maxRequests) || maxRequests < 1) {
    return { allowed: false, remaining: 0, resetTime: Date.now() + windowMs };
  }
  
  // Use Redis if available, otherwise fallback to memory
  if (redisAvailable && redisClient) {
    return rateLimitRedis(identifier, maxRequests, windowMs);
  }
  
  return memoryRateLimit(identifier, maxRequests, windowMs);
}

// Get rate limit stats from Redis
export async function getRateLimitStats(): Promise<{
  redisAvailable: boolean;
  activeKeys: number;
}> {
  if (!redisClient || !redisAvailable) {
    return {
      redisAvailable: false,
      activeKeys: 0,
    };
  }
  
  try {
    const keys = await redisClient.keys('ratelimit:*');
    return {
      redisAvailable: true,
      activeKeys: keys.length,
    };
  } catch (err) {
    console.warn('[RateLimit] Failed to get stats:', err);
    return {
      redisAvailable: false,
      activeKeys: 0,
    };
  }
}

// Close Redis connection
export async function closeRedis(): Promise<void> {
  if (redisClient) {
    try {
      await redisClient.quit();
      redisClient = null;
      redisAvailable = false;
    } catch (err) {
      // console.error('[RateLimit] Error closing Redis:', err);
    }
  }
}

// Re-export getClientIdentifier for convenience
export { getClientIdentifier };

