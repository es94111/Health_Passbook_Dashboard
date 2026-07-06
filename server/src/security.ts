import type { Request, Response, NextFunction } from 'express';

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

export function clientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0];
    return first.trim();
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

export function createRateLimiter(options: RateLimitOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const key = options.key(req);
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
