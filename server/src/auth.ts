import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getUserById } from './store.js';

if (!process.env.JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET is required in production. Generate one with: openssl rand -hex 32');
  }
  console.warn('[auth] JWT_SECRET is not set. Using an insecure development default.');
  console.warn('[auth] Generate one with: openssl rand -hex 32');
}

const JWT_SECRET = process.env.JWT_SECRET ?? 'nhi-dashboard-secret-change-in-prod';
const JWT_EXPIRES_IN = (process.env.JWT_EXPIRES_IN ?? '12h') as jwt.SignOptions['expiresIn'];
const SESSION_COOKIE_NAME = 'nhi_session';
const SESSION_COOKIE_MAX_AGE_MS = Number(process.env.SESSION_COOKIE_MAX_AGE_MS) || 12 * 60 * 60 * 1000;

if (Buffer.byteLength(JWT_SECRET, 'utf-8') < 32) {
  const message = 'JWT_SECRET must be at least 32 bytes';
  if (process.env.NODE_ENV === 'production') {
    throw new Error(message);
  }
  console.warn(`[auth] ${message}`);
}

export interface JwtPayload {
  userId: string;
  username: string;
  isAdmin: boolean;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256', expiresIn: JWT_EXPIRES_IN });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as JwtPayload;
}

function cookieSecure(): boolean {
  if (process.env.SESSION_COOKIE_SECURE) {
    return process.env.SESSION_COOKIE_SECURE === 'true';
  }
  return process.env.NODE_ENV === 'production';
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  const pair = raw
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  if (!pair) return null;
  try {
    return decodeURIComponent(pair.slice(name.length + 1));
  } catch {
    // Malformed percent-encoding — treat as no cookie rather than a 500.
    return null;
  }
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: 'lax',
    maxAge: SESSION_COOKIE_MAX_AGE_MS,
    path: '/',
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: 'lax',
    path: '/',
  });
}

async function authenticateRequest(req: Request, res: Response): Promise<boolean> {
  const token = readCookie(req, SESSION_COOKIE_NAME);

  if (!token) {
    res.status(401).json({ error: 'Missing session' });
    return false;
  }

  try {
    const payload = verifyToken(token);
    const user = await getUserById(payload.userId);
    if (!user) {
      res.status(401).json({ error: 'Token user no longer exists' });
      return false;
    }
    req.user = { userId: user.id, username: user.username, isAdmin: user.isAdmin };
    return true;
  } catch {
    res.status(401).json({ error: 'Token is invalid or expired' });
    return false;
  }
}

// Express middleware: attaches req.user or returns 401.
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (await authenticateRequest(req, res)) {
    next();
  }
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!(await authenticateRequest(req, res))) {
    return;
  }
  if (!req.user?.isAdmin) {
    res.status(403).json({ error: 'Admin permission required' });
    return;
  }
  next();
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}
