import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { createUser, getUserByUsername, getUserByGoogleId, userCount } from '../store.js';
import { signToken, requireAuth } from '../auth.js';

const googleClient = new OAuth2Client();

const router = Router();

// GET /api/auth/config  — public endpoint, tells the frontend which features are enabled
router.get('/config', (_req, res) => {
  res.json({
    googleClientId: process.env.GOOGLE_CLIENT_ID ?? null,
  });
});

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };

  if (!username || !password) {
    res.status(400).json({ error: '請輸入帳號和密碼' });
    return;
  }
  if (username.length < 3 || username.length > 32) {
    res.status(400).json({ error: '帳號長度需在 3-32 字元之間' });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ error: '密碼至少 6 個字元' });
    return;
  }

  const existing = await getUserByUsername(username);
  if (existing) {
    res.status(409).json({ error: '帳號已存在' });
    return;
  }

  const count = await userCount();
  const isAdmin = count === 0; // first registered user becomes admin

  const passwordHash = await bcrypt.hash(password, 10);
  const user = {
    id: crypto.randomUUID(),
    username,
    passwordHash,
    isAdmin,
    createdAt: new Date().toISOString(),
  };

  await createUser(user);

  const token = signToken({ userId: user.id, username, isAdmin });
  res.json({ token, username, isAdmin });
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };

  if (!username || !password) {
    res.status(400).json({ error: '請輸入帳號和密碼' });
    return;
  }

  const user = await getUserByUsername(username);
  if (!user) {
    res.status(401).json({ error: '帳號或密碼錯誤' });
    return;
  }

  // Google-only accounts have no password — reject password login attempts
  if (!user.passwordHash) {
    res.status(401).json({ error: '此帳號僅支援 Google 登入' });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: '帳號或密碼錯誤' });
    return;
  }

  const token = signToken({ userId: user.id, username: user.username, isAdmin: user.isAdmin });
  res.json({ token, username: user.username, isAdmin: user.isAdmin });
});

// POST /api/auth/google  — verify Google ID token, auto-create account if needed
router.post('/google', async (req, res) => {
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
  } catch (err) {
    console.error('[auth] Google token 驗證失敗：', err);
    res.status(401).json({ error: 'Google 憑證驗證失敗，請重試' });
    return;
  }

  // Find existing user by googleId
  let user = await getUserByGoogleId(googleId);

  if (!user) {
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
    };

    await createUser(newUser);
    user = await getUserByGoogleId(googleId);
    if (!user) {
      // Should never happen — createUser succeeded, but defensive guard avoids returning
      // a user object with an empty encryptionSalt that would brick the account
      console.error('[auth] createUser 成功但無法讀回使用者資料，Google ID：', googleId);
      res.status(500).json({ error: '建立帳號失敗，請重試' });
      return;
    }
    console.log(`[auth] Google SSO 自動建立帳號：${username} (${email})`);
  }

  const token = signToken({ userId: user.id, username: user.username, isAdmin: user.isAdmin });
  res.json({ token, username: user.username, isAdmin: user.isAdmin });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  res.json(req.user);
});

export default router;