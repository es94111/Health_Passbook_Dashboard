import type { Request, Response, NextFunction } from 'express';
import net from 'node:net';

/**
 * Only trust X-Forwarded-For when the deployment sits behind a reverse proxy
 * that overwrites the header (TRUST_PROXY=true). Without this, a client can
 * forge the header and rotate its apparent IP to defeat rate limiting and
 * forge login-log IPs.
 */
const TRUST_PROXY = (process.env.TRUST_PROXY ?? '').toLowerCase() === 'true';

/** True for a syntactically valid IPv4/IPv6 address. */
function isValidIp(ip: string): boolean {
  return ip !== 'unknown' && net.isIP(ip) !== 0;
}

export const PASSWORD_MIN_LENGTH = 12;
export const BCRYPT_ROUNDS = 12;

const WEAK_PASSWORDS = new Set([
  'password',
  'password123',
  '123456789012',
  'qwerty123456',
  'admin123456',
]);

export function validatePasswordStrength(password: string, username?: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }

  const lower = password.toLowerCase();
  if (WEAK_PASSWORDS.has(lower)) {
    return 'Password is too common';
  }

  if (username && username.length >= 3 && lower.includes(username.toLowerCase())) {
    return 'Password must not contain the username';
  }

  const classes = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /\d/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ].filter(Boolean).length;

  if (classes < 3) {
    return 'Password must include at least three of: lowercase, uppercase, number, symbol';
  }

  return null;
}

interface RateLimitOptions {
  windowMs: number;
  max: number;
  message?: string;
  key: (req: Request) => string;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
// Expired buckets are pruned periodically so the Map can't grow unbounded.
// unref() keeps the timer from holding the process open on shutdown.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 60_000).unref();

export function clientIp(req: Request): string {
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const first = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0];
      const ip = first.trim();
      if (isValidIp(ip)) return ip;
    }
  }
  const addr = req.socket?.remoteAddress;
  return addr && isValidIp(addr) ? addr : 'unknown';
}

export function createRateLimiter(options: RateLimitOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    // Cap the key length so a client can't grow the buckets Map with huge keys
    // (e.g. a multi-MB username echoed into the key).
    const key = options.key(req).slice(0, 256);
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }

    bucket.count += 1;
    if (bucket.count > options.max) {
      const retryAfterSeconds = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(429).json({ error: options.message ?? 'Too many attempts. Please try again later.' });
      return;
    }

    next();
  };
}
