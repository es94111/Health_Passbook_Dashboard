import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { requireAuth } from '../auth.js';
import {
  getUserById,
  getUserByGoogleId,
  updateUser,
  updateUserPreferences,
  deleteUser,
  getLoginLogs,
  deleteLoginLogs,
  adminCount,
  toPublicProfile,
  type UserPreferences,
} from '../store.js';

const googleClient = new OAuth2Client();
const router = Router();

// All account routes require authentication
router.use(requireAuth);

// ── GET /api/auth/me (extended) ───────────────────────────────────────────────
// Returns full user profile from DB (not just JWT payload)
router.get('/me', async (req, res) => {
  const user = await getUserById(req.user!.userId);
  if (!user) {
    res.status(404).json({ error: '使用者不存在' });
    return;
  }
  res.json(toPublicProfile(user));
});

// ── PUT /api/account/preferences ──────────────────────────────────────────────
// Accepts a partial preferences patch; merges, validates and persists server-side.
router.put('/preferences', async (req, res) => {
  const body = req.body as Partial<UserPreferences> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    res.status(400).json({ error: '無效的偏好設定格式' });
    return;
  }
  const updated = await updateUserPreferences(req.user!.userId, body);
  if (!updated) {
    res.status(404).json({ error: '使用者不存在' });
    return;
  }
  res.json(updated);
});

// ── PUT /api/account/theme ────────────────────────────────────────────────────
router.put('/theme', async (req, res) => {
  const { themeMode } = req.body as { themeMode?: unknown };
  if (!['light', 'dark', 'system'].includes(themeMode as string)) {
    res.status(400).json({ error: 'themeMode 必須為 light / dark / system' });
    return;
  }
  await updateUser(req.user!.userId, { themeMode: themeMode as 'light' | 'dark' | 'system' });
  res.json({ themeMode });
});

// ── PUT /api/account/display-name ────────────────────────────────────────────
router.put('/display-name', async (req, res) => {
  const { displayName } = req.body as { displayName?: unknown };
  if (typeof displayName !== 'string' || displayName.trim().length === 0) {
    res.status(400).json({ error: '顯示名稱不可空白' });
    return;
  }
  if (displayName.trim().length > 50) {
    res.status(400).json({ error: '顯示名稱最多 50 個字元' });
    return;
  }
  const updated = await updateUser(req.user!.userId, { displayName: displayName.trim() });
  res.json({ displayName: updated?.displayName });
});

// ── GET /api/account/login-logs ───────────────────────────────────────────────
router.get('/login-logs', async (req, res) => {
  const logs = await getLoginLogs(req.user!.userId, 100);
  res.json(logs);
});

// ── DELETE /api/account/login-logs ───────────────────────────────────────────
router.delete('/login-logs', async (req, res) => {
  const { ids } = req.body as { ids?: unknown };
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
    res.status(400).json({ error: 'ids 必須為字串陣列' });
    return;
  }
  // Users can only delete their own successful logs
  const userLogs = await getLoginLogs(req.user!.userId, 100);
  const ownIds = new Set(userLogs.map((l) => l.id));
  const allowed = (ids as string[]).filter((id) => ownIds.has(id));
  const deleted = await deleteLoginLogs(allowed);
  res.json({ deleted });
});

// ── POST /api/account/link-google ─────────────────────────────────────────────
router.post('/link-google', async (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    res.status(501).json({ error: '伺服器未設定 GOOGLE_CLIENT_ID，無法使用 Google 綁定' });
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

  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: clientId });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email) throw new Error('無效的 Google token payload');
    if (!payload.email_verified) throw new Error('Google 帳號的電子郵件尚未驗證');
    googleId = payload.sub;
    email = payload.email;
    picture = payload.picture;
  } catch (err) {
    console.error('[account] Google token 驗證失敗：', err);
    res.status(401).json({ error: 'Google 憑證驗證失敗，請重試' });
    return;
  }

  // Check if this Google account is already bound to another user
  const existing = await getUserByGoogleId(googleId);
  if (existing && existing.id !== req.user!.userId) {
    res.status(409).json({ error: '此 Google 帳號已綁定其他使用者' });
    return;
  }

  await updateUser(req.user!.userId, {
    googleId,
    googleEmail: email,
    ...(picture ? { avatarUrl: picture } : {}),
  });

  res.json({ googleEmail: email, avatarUrl: picture ?? null });
});

// ── POST /api/account/unlink-google ──────────────────────────────────────────
router.post('/unlink-google', async (req, res) => {
  const user = await getUserById(req.user!.userId);
  if (!user) {
    res.status(404).json({ error: '使用者不存在' });
    return;
  }
  if (!user.googleId) {
    res.status(400).json({ error: '尚未綁定 Google 帳號' });
    return;
  }
  // Google-only accounts (no password) cannot unlink — would lose all access
  if (!user.passwordHash) {
    res.status(400).json({ error: '此帳號僅支援 Google 登入，解除綁定前請先設定密碼' });
    return;
  }
  await updateUser(req.user!.userId, { googleId: undefined, googleEmail: undefined, avatarUrl: undefined });
  res.json({ message: 'Google 帳號已解除綁定' });
});

// ── POST /api/account/delete ──────────────────────────────────────────────────
router.post('/delete', async (req, res) => {
  const { password } = req.body as { password?: string };
  const user = await getUserById(req.user!.userId);
  if (!user) {
    res.status(404).json({ error: '使用者不存在' });
    return;
  }

  // Last admin cannot delete themselves
  if (user.isAdmin && (await adminCount()) <= 1) {
    res.status(400).json({ error: '您是唯一管理員，無法刪除帳號。請先指派其他管理員後再操作。' });
    return;
  }

  // Password accounts must verify password
  if (user.passwordHash) {
    if (!password) {
      res.status(400).json({ error: '請輸入密碼以確認刪除' });
      return;
    }
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      res.status(401).json({ error: '密碼錯誤' });
      return;
    }
  }

  await deleteUser(user.id);
  // Also purge their login logs
  const logs = await getLoginLogs(user.id, 1000);
  if (logs.length > 0) {
    await deleteLoginLogs(logs.map((l) => l.id));
  }

  res.json({ message: '帳號已永久刪除' });
});

// ── POST /api/account/set-password ───────────────────────────────────────────
// Allows Google-only accounts to set a password (enables unlink + backup login)
router.post('/set-password', async (req, res) => {
  const { newPassword } = req.body as { newPassword?: string };
  if (!newPassword || newPassword.length < 6) {
    res.status(400).json({ error: '密碼至少 6 個字元' });
    return;
  }
  const user = await getUserById(req.user!.userId);
  if (!user) {
    res.status(404).json({ error: '使用者不存在' });
    return;
  }
  if (user.passwordHash) {
    res.status(400).json({ error: '已設定密碼，請使用修改密碼功能' });
    return;
  }
  const hash = await bcrypt.hash(newPassword, 10);
  await updateUser(req.user!.userId, { passwordHash: hash });
  res.json({ message: '密碼已設定' });
});

// ── PUT /api/account/password ─────────────────────────────────────────────────
router.put('/password', async (req, res) => {
  const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword?: string };
  const user = await getUserById(req.user!.userId);
  if (!user) {
    res.status(404).json({ error: '使用者不存在' });
    return;
  }
  if (!user.passwordHash) {
    res.status(400).json({ error: '尚未設定密碼，請使用設定密碼功能' });
    return;
  }
  if (!currentPassword) {
    res.status(400).json({ error: '請輸入目前密碼' });
    return;
  }
  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: '目前密碼錯誤' });
    return;
  }
  if (!newPassword || newPassword.length < 6) {
    res.status(400).json({ error: '新密碼至少 6 個字元' });
    return;
  }
  const hash = await bcrypt.hash(newPassword, 10);
  await updateUser(req.user!.userId, { passwordHash: hash });
  res.json({ message: '密碼已更新' });
});

export { router as accountRouter };

// Helper export used by auth routes to get extended profile
export { getUserById };
