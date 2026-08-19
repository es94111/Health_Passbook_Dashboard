import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import {
  createUser,
  getUserByUsername,
  getUserByGoogleId,
  getUserById,
  updateUser,
  userCount,
  addLoginLog,
  updateLogCountry,
  canSelfRegister,
  toPublicProfile,
} from '../store.js';
import { signToken, setSessionCookie, clearSessionCookie, requireAuth } from '../auth.js';
import {
  BCRYPT_ROUNDS,
  validatePasswordStrength,
  createRateLimiter,
  clientIp,
} from '../security.js';

const googleClient = new OAuth2Client();
const router = Router();
const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

const authRateLimit = createRateLimiter({
  windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
  max: 20,
  message: 'Too many authentication attempts. Please wait and try again.',
  key: (req) => `auth:${clientIp(req)}`,
});

const passwordLoginRateLimit = createRateLimiter({
  windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
  max: 8,
  message: 'Too many login attempts for this account. Please wait and try again.',
  key: (req) => {
    const username = typeof req.body?.username === 'string' ? req.body.username.toLowerCase().trim() : '';
    return `login:${clientIp(req)}:${username}`;
  },
});

// ── IP helpers ────────────────────────────────────────────────────────────────
// Real client IP is resolved by the shared clientIp() in security.ts, which only
// trusts X-Forwarded-For when TRUST_PROXY=true (see there).

function isPrivateIp(ip: string): boolean {
  let addr = ip;
  // Normalize IPv4-mapped IPv6 (::ffff:1.2.3.4) so the IPv4 rules below apply.
  if (addr.startsWith('::ffff:') && addr.includes('.')) {
    addr = addr.slice('::ffff:'.length);
  }
  if (addr === 'unknown' || addr === '::1' || addr === '0.0.0.0') return true;

  if (!addr.includes(':')) {
    const octets = addr.split('.').map(Number);
    if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return true;
    const [a, b] = octets;
    if (a === 10) return true;                          // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
    if (a === 192 && b === 168) return true;            // 192.168.0.0/16
    if (a === 127) return true;                         // loopback
    if (a === 169 && b === 254) return true;            // link-local
    return false;
  }

  const lower = addr.toLowerCase();
  // IPv6 loopback / link-local (fe80::/10) / unique-local (fc00::/7)
  return (
    lower.startsWith('fe8') ||
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb') ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower === '::' ||
    lower.startsWith('::1')
  );
}

/** Async IP → country lookup. Silently ignores errors. Updates log entry in place. */
async function lookupCountry(logId: string, ip: string): Promise<void> {
  if (isPrivateIp(ip)) {
    await updateLogCountry(logId, 'LOCAL');
    return;
  }
  try {
    const res = await fetch(`https://ip-api.com/json/${ip}?fields=country`);
    if (res.ok) {
      const data = await res.json() as { country?: string };
      if (data.country) await updateLogCountry(logId, data.country);
    }
  } catch {
    // Network unavailable or rate limited — leave country undefined
  }
}

// ── GET /api/auth/config — public, tells frontend which features are enabled ──
router.get('/config', (_req, res) => {
  res.json({
    googleClientId: process.env.GOOGLE_CLIENT_ID ?? null,
  });
});

// ── POST /api/auth/register ───────────────────────────────────────────────────
router.post('/register', authRateLimit, async (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };

  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    res.status(400).json({ error: '請輸入帳號和密碼' });
    return;
  }
  if (username.length < 3 || username.length > 32) {
    res.status(400).json({ error: '帳號長度需在 3-32 字元之間' });
    return;
  }
  const passwordError = validatePasswordStrength(password, username);
  if (passwordError) {
    res.status(400).json({ error: passwordError });
    return;
  }

  // Registration control — check settings unless this is the very first user
  const allowed = await canSelfRegister(null);
  if (!allowed) {
    res.status(403).json({ error: '目前不開放公開註冊，請聯繫管理員' });
    return;
  }

  const existing = await getUserByUsername(username);
  if (existing) {
    res.status(409).json({ error: '帳號已存在' });
    return;
  }

  const count = await userCount();
  const isAdmin = count === 0; // first registered user becomes admin

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = {
    id: crypto.randomUUID(),
    username,
    passwordHash,
    isAdmin,
    createdAt: new Date().toISOString(),
  };

  await createUser(user);

  const token = signToken({ userId: user.id, username, isAdmin });
  setSessionCookie(res, token);
  res.json({ username, isAdmin });
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post('/login', passwordLoginRateLimit, async (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  const ip = clientIp(req);

  // Type/length validation BEFORE any logging — a huge or non-string username
  // would otherwise bloat the login-logs file on every attempt.
  if (typeof username !== 'string' || username.trim().length === 0 || username.length > 64) {
    res.status(400).json({ error: '請輸入有效帳號' });
    return;
  }
  if (typeof password !== 'string' || password.length === 0) {
    res.status(400).json({ error: '請輸入帳號和密碼' });
    return;
  }

  const user = await getUserByUsername(username);
  if (!user) {
    res.status(401).json({ error: '帳號或密碼錯誤' });
    return;
  }

  // Google-only accounts have no password — reject password login attempts.
  // Use the same generic error as a wrong password so account existence (and
  // whether the account is Google-only) isn't revealed.
  if (!user.passwordHash) {
    res.status(401).json({ error: '帳號或密碼錯誤' });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    // Log failed attempt
    addLoginLog({
      userId: user.id,
      username,
      isAdmin: user.isAdmin,
      method: 'password',
      success: false,
      failReason: '密碼錯誤',
      ip,
      timestamp: new Date().toISOString(),
    }).catch(() => undefined);

    res.status(401).json({ error: '帳號或密碼錯誤' });
    return;
  }

  // Log successful login (async — don't block response)
  addLoginLog({
    userId: user.id,
    username: user.username,
    isAdmin: user.isAdmin,
    method: 'password',
    success: true,
    ip,
    timestamp: new Date().toISOString(),
  }).then((log) => lookupCountry(log.id, ip)).catch(() => undefined);

  const token = signToken({ userId: user.id, username: user.username, isAdmin: user.isAdmin });
  setSessionCookie(res, token);
  res.json({ username: user.username, isAdmin: user.isAdmin });
});

// ── POST /api/auth/google — verify Google ID token, auto-create account if needed
router.post('/google', authRateLimit, async (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    res.status(501).json({ error: '伺服器未設定 GOOGLE_CLIENT_ID，無法使用 Google 登入' });
    return;
  }

  const { credential } = req.body as { credential?: string };
  if (!credential || typeof credential !== 'string') {
    res.status(400).json({ error: '缺少 Google credential' });
    return;
  }

  let googleId: string;
  let email: string;
  let picture: string | undefined;
  const ip = clientIp(req);

  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: clientId });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email) {
      throw new Error('無效的 Google token payload');
    }
    if (!payload.email_verified) {
      throw new Error('Google 帳號的電子郵件尚未驗證');
    }
    googleId = payload.sub;
    email = payload.email;
    picture = payload.picture;
  } catch (err) {
    console.error('[auth] Google token 驗證失敗：', err);
    res.status(401).json({ error: 'Google 憑證驗證失敗，請重試' });
    return;
  }

  // Find existing user by googleId
  let user = await getUserByGoogleId(googleId);

  if (!user) {
    // Check registration policy
    const allowed = await canSelfRegister(email);
    if (!allowed) {
      res.status(403).json({ error: '目前不開放公開註冊，請聯繫管理員' });
      return;
    }

    // Auto-register: derive a safe username from email local-part
    const base = email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 28);
    let username = base;
    let suffix = 1;
    while (await getUserByUsername(username)) {
      username = `${base}_${suffix++}`;
    }

    const count = await userCount();
    const newUser = {
      id: crypto.randomUUID(),
      username,
      passwordHash: '', // Google-only account — password login disabled
      isAdmin: count === 0,
      createdAt: new Date().toISOString(),
      googleId,
      googleEmail: email,
      avatarUrl: picture,
    };

    await createUser(newUser);
    user = await getUserByGoogleId(googleId);
    if (!user) {
      console.error('[auth] createUser 成功但無法讀回使用者資料，Google ID：', googleId);
      res.status(500).json({ error: '建立帳號失敗，請重試' });
      return;
    }
    console.log(`[auth] Google SSO 自動建立帳號：${username} (${email})`);
  } else {
    // Update avatar if changed
    if (picture && picture !== user.avatarUrl) {
      await updateUser(user.id, { avatarUrl: picture });
    }
  }

  // Log successful login
  addLoginLog({
    userId: user.id,
    username: user.username,
    isAdmin: user.isAdmin,
    method: 'google',
    success: true,
    ip,
    timestamp: new Date().toISOString(),
  }).then((log) => lookupCountry(log.id, ip)).catch(() => undefined);

  const token = signToken({ userId: user.id, username: user.username, isAdmin: user.isAdmin });
  setSessionCookie(res, token);
  res.json({ username: user.username, isAdmin: user.isAdmin });
});

router.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ── GET /api/auth/me — full profile from DB (not just JWT payload) ────────────
router.get('/me', requireAuth, async (req, res) => {
  const user = await getUserById(req.user!.userId);
  if (!user) {
    res.status(404).json({ error: '使用者不存在' });
    return;
  }
  res.json(toPublicProfile(user));
});

export default router;
