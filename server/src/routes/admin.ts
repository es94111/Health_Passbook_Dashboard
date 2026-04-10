import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { requireAdmin } from '../auth.js';
import {
  getUsers,
  getUserById,
  createUser,
  deleteUser,
  adminCount,
  getRecords,
  flattenRecords,
  getLoginLogs,
  deleteLoginLogs,
  getSettings,
  updateSettings,
} from '../store.js';

const router = Router();

// All admin routes require admin role
router.use(requireAdmin);

// ── GET /api/admin/users ──────────────────────────────────────────────────────
router.get('/users', async (_req, res) => {
  const users = await getUsers();
  // Never expose passwordHash or encryptionSalt
  const safe = users.map(({ id, username, displayName, isAdmin, createdAt, googleEmail, googleId, passwordHash }) => ({
    id,
    username,
    displayName: displayName ?? null,
    isAdmin,
    createdAt,
    googleEmail: googleEmail ?? null,
    hasGoogle: Boolean(googleId),
    hasPassword: Boolean(passwordHash),
  }));
  res.json(safe);
});

// ── POST /api/admin/users — admin creates a new account (bypasses registration restrictions)
router.post('/users', async (req, res) => {
  const { username, password, isAdmin: makeAdmin } = req.body as {
    username?: string;
    password?: string;
    isAdmin?: boolean;
  };

  if (!username || username.length < 3 || username.length > 32) {
    res.status(400).json({ error: '帳號長度需在 3-32 字元之間' });
    return;
  }
  if (!password || password.length < 6) {
    res.status(400).json({ error: '密碼至少 6 個字元' });
    return;
  }

  const users = await getUsers();
  if (users.find((u) => u.username === username)) {
    res.status(409).json({ error: '帳號已存在' });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const newUser = {
    id: crypto.randomUUID(),
    username,
    passwordHash,
    isAdmin: Boolean(makeAdmin),
    createdAt: new Date().toISOString(),
  };

  await createUser(newUser);
  res.status(201).json({
    id: newUser.id,
    username: newUser.username,
    isAdmin: newUser.isAdmin,
    createdAt: newUser.createdAt,
  });
});

// ── DELETE /api/admin/users/:id ───────────────────────────────────────────────
router.delete('/users/:id', async (req, res) => {
  const { id } = req.params;

  // Admin panel cannot self-delete — use account settings instead
  if (id === req.user!.userId) {
    res.status(400).json({ error: '請至帳號設定頁刪除自己的帳號' });
    return;
  }

  const target = await getUserById(id);
  if (!target) {
    res.status(404).json({ error: '使用者不存在' });
    return;
  }

  // Prevent deleting the last admin
  if (target.isAdmin && (await adminCount()) <= 1) {
    res.status(400).json({ error: '無法刪除最後一位管理員' });
    return;
  }

  const deleted = await deleteUser(id);
  if (!deleted) {
    res.status(404).json({ error: '使用者不存在' });
    return;
  }

  // Purge their login logs
  const logs = await getLoginLogs(id, 1000);
  if (logs.length > 0) await deleteLoginLogs(logs.map((l) => l.id));

  res.json({ message: '使用者已刪除' });
});

// ── GET /api/admin/users/:id/data  — view a specific user's health data
router.get('/users/:id/data', async (req, res) => {
  const { id } = req.params;
  const stored = await getRecords(id);
  res.json(flattenRecords(stored));
});

// ── GET /api/admin/settings ───────────────────────────────────────────────────
router.get('/settings', async (_req, res) => {
  const settings = await getSettings();
  res.json(settings);
});

// ── PUT /api/admin/settings ───────────────────────────────────────────────────
router.put('/settings', async (req, res) => {
  const { publicRegistration, allowedRegistrationEmails, adminIpAllowlist } = req.body as {
    publicRegistration?: boolean;
    allowedRegistrationEmails?: string[];
    adminIpAllowlist?: string[];
  };

  const patch: Parameters<typeof updateSettings>[0] = {};

  if (typeof publicRegistration === 'boolean') patch.publicRegistration = publicRegistration;
  if (Array.isArray(allowedRegistrationEmails)) {
    patch.allowedRegistrationEmails = allowedRegistrationEmails.map((e) => String(e).trim()).filter(Boolean);
  }
  if (Array.isArray(adminIpAllowlist)) {
    patch.adminIpAllowlist = adminIpAllowlist.map((ip) => String(ip).trim()).filter(Boolean);
  }

  const updated = await updateSettings(patch);
  res.json(updated);
});

// ── GET /api/admin/login-logs — all users' logs (success + failure), max 500
router.get('/login-logs', async (_req, res) => {
  const logs = await getLoginLogs(undefined, 500);
  res.json(logs);
});

// ── DELETE /api/admin/login-logs — batch delete
router.delete('/login-logs', async (req, res) => {
  const { ids } = req.body as { ids?: unknown };
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
    res.status(400).json({ error: 'ids 必須為字串陣列' });
    return;
  }
  const deleted = await deleteLoginLogs(ids as string[]);
  res.json({ deleted });
});

export default router;
