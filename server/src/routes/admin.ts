import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { requireAdmin } from '../auth.js';
import { BCRYPT_ROUNDS, validatePasswordStrength, clientIp, createRateLimiter } from '../security.js';
import {
  getUsers,
  getUserById,
  createUser,
  deleteUser,
  adminCount,
  getLoginLogs,
  deleteLoginLogs,
  getSettings,
  updateSettings,
  addLoginLog,
} from '../store.js';
import { importBackupStream, prepareBackupFile } from '../backupTransfer.js';
import { BackupDownloads } from '../backupDownloads.js';
import { BackupSizeError } from '../backupLimits.js';
import {
  getSystemInfo,
  triggerSystemUpdate,
  UpdateConfigurationError,
  UpdateConflictError,
} from '../systemUpdate.js';

const router = Router();
const downloads = new BackupDownloads();

function backupOperation(req: Request, res: Response) {
  res.setHeader('Cache-Control', 'no-store');
  res.locals.cancelBodyDeadline?.();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('備份操作超過 24 小時，已中止')), 24 * 60 * 60 * 1000);
  timer.unref();
  const abort = () => { if (!res.writableFinished) controller.abort(); };
  res.once('close', abort);
  req.once('aborted', abort);
  return {
    signal: controller.signal,
    finish: () => {
      clearTimeout(timer);
      res.off('close', abort);
      req.off('aborted', abort);
    },
  };
}

router.use('/backup', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// ── Backup rate limiter ───────────────────────────────────────────────────────
// Export verifies the admin's password — keep attempts low to slow brute force.
const backupRateLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: '備份操作嘗試次數過多，請稍後再試。',
  key: (req) => `admin-backup:${clientIp(req)}:${req.user?.userId ?? '?'}`,
});

// Updating restarts the service; keep repeated password attempts and manual
// restart loops bounded.
const systemUpdateRateLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: '系統更新嘗試次數過多，請稍後再試。',
  key: (req) => `admin-system-update:${clientIp(req)}:${req.user?.userId ?? '?'}`,
});

// ── Admin IP allowlist ────────────────────────────────────────────────────────
// If configured (via the admin settings UI or ENV_ADMIN_IP_ALLOWLIST), only the
// listed source IPs may reach admin endpoints. Empty list = no restriction.
function mergeAdminIpAllowlist(configured: string[]): string[] {
  const fromEnv = (process.env.ENV_ADMIN_IP_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([...configured, ...fromEnv])];
}

router.use(async (req, res, next) => {
  try {
    const settings = await getSettings();
    const allowlist = mergeAdminIpAllowlist(settings.adminIpAllowlist);
    if (allowlist.length === 0) {
      next();
      return;
    }
    const ip = clientIp(req);
    if (!allowlist.includes(ip)) {
      res.status(403).json({ error: '來源 IP 不在管理員允許清單內' });
      return;
    }
    next();
  } catch (err) {
    next(err as Error);
  }
});

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
  if (!password) {
    res.status(400).json({ error: 'Password is required' });
    return;
  }
  const passwordError = validatePasswordStrength(password, username);
  if (passwordError) {
    res.status(400).json({ error: passwordError });
    return;
  }

  const users = await getUsers();
  if (users.find((u) => u.username === username)) {
    res.status(409).json({ error: '帳號已存在' });
    return;
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
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
  void req;
  res.status(403).json({ error: 'Health records are client-side encrypted and cannot be decrypted by admins.' });
});

// Staged backups live under a dot-directory, which `send` refuses by default.
const DOWNLOAD_OPTIONS = { cacheControl: false, dotfiles: 'allow' } as const;

// ── POST /api/admin/backup/export — decrypt + download full backup ───────────
// High-sensitivity: response contains plaintext users (incl. password hashes).
// Requires the admin to re-enter their password, and is audit-logged.
router.post('/backup/export', backupRateLimit, async (req, res, next) => {
  const admin = await getUserById(req.user!.userId);
  if (!admin) {
    res.status(401).json({ error: '管理員帳號不存在' });
    return;
  }
  if (!admin.passwordHash) {
    res.status(400).json({ error: '此帳號尚未設定密碼（僅 Google 登入），請先至帳號設定頁設定密碼後再匯出' });
    return;
  }
  const { password } = req.body as { password?: unknown };
  if (typeof password !== 'string' || password.length === 0) {
    res.status(400).json({ error: '請輸入管理員密碼以確認匯出' });
    return;
  }
  const valid = await bcrypt.compare(password, admin.passwordHash);
  if (!valid) {
    res.status(401).json({ error: '密碼錯誤' });
    return;
  }

  const operation = backupOperation(req, res);
  try {
    const prepared = req.query.prepare === 'true'
      ? await downloads.prepare(admin.id, () => prepareBackupFile({ signal: operation.signal }))
      : { backup: await prepareBackupFile({ signal: operation.signal }), token: null };
    const { backup, token } = prepared;
    addLoginLog({
      userId: admin.id, username: admin.username, isAdmin: true, method: 'password', success: true,
      ip: clientIp(req), timestamp: new Date().toISOString(), action: 'admin-export',
      note: `users=${backup.counts.users} records=${backup.counts.withRecords} logs=${backup.counts.loginLogs}`,
    }).catch(() => undefined);
    if (token) {
      res.json({ downloadUrl: `/api/admin/backup/download/${token}`, filename: backup.filename, bytes: backup.bytes });
    } else {
      await new Promise<void>((resolve, reject) => {
        res.download(backup.file, backup.filename, DOWNLOAD_OPTIONS, (err) => err ? reject(err) : resolve());
      }).finally(backup.cleanup);
    }
  } catch (err) { next(err); }
  finally { operation.finish(); }
});

router.get('/backup/download/:token', async (req, res, next) => {
  const download = downloads.acquire(req.params.token, req.user!.userId);
  if (!download) {
    res.status(404).json({ error: '備份下載不存在或已過期，請重新匯出' });
    return;
  }
  const operation = backupOperation(req, res);
  const abort = () => res.destroy();
  operation.signal.addEventListener('abort', abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      res.download(download.backup.file, download.backup.filename, DOWNLOAD_OPTIONS, (err) => err ? reject(err) : resolve());
    });
  } catch (err) { next(err); }
  finally {
    operation.signal.removeEventListener('abort', abort);
    operation.finish();
    download.release();
  }
});

// ── POST /api/admin/backup/import — validate + fully replace current data ────
// Destructive restore; requires ?confirm=true (UI two-step confirmation) and is
// audit-logged. Client-encrypted health records are restored verbatim, so the
// users' own vault passphrases keep working (key migration is implicit).
router.post('/backup/import', backupRateLimit, async (req, res) => {
  if (req.query.confirm !== 'true') {
    res.status(400).json({ error: '缺少 confirm=true，未經二次確認不得還原' });
    return;
  }
  if (!req.is('application/json') || (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')) {
    res.status(415).json({ error: '請直接上傳未壓縮的 JSON 備份檔' });
    return;
  }
  const operation = backupOperation(req, res);
  try {
    const stats = await importBackupStream(req, {
      signal: operation.signal,
      ...(req.headers['content-length'] === undefined ? {} : { contentLength: Number(req.headers['content-length']) }),
    });
    res.json({
      message: `資料已完整還原：${stats.users} 位使用者、${stats.recordsRestored} 份紀錄、${stats.loginLogs} 筆登入記錄`,
      stats,
    });
  } catch (err) {
    // Close rejected uploads after the response, rather than draining up to 20 GB.
    if (!req.complete) res.setHeader('Connection', 'close');
    if (err instanceof BackupSizeError) {
      res.status(err.status).json({ error: err.message, code: err.code, limitBytes: err.limitBytes });
      return;
    }
    res.status(400).json({ error: (err as Error).message });
  } finally { operation.finish(); }
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

// ── GET /api/admin/system — version + Watchtower update status ───────────────
router.get('/system', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await getSystemInfo());
});

// ── POST /api/admin/system/update — trigger a Watchtower image update ────────
// The admin must re-enter their password; the attempt is audit-logged and rate
// limited. The Watchtower token never leaves the server.
router.post('/system/update', systemUpdateRateLimit, async (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  const admin = await getUserById(req.user!.userId);
  if (!admin) {
    res.status(401).json({ error: '管理員帳號不存在' });
    return;
  }
  if (!admin.passwordHash) {
    res.status(400).json({ error: '此帳號尚未設定密碼（僅 Google 登入），請先至帳號設定頁設定密碼後再更新系統' });
    return;
  }
  const { password } = req.body as { password?: unknown };
  if (typeof password !== 'string' || password.length === 0) {
    res.status(400).json({ error: '請輸入管理員密碼以確認更新' });
    return;
  }
  const valid = await bcrypt.compare(password, admin.passwordHash);
  if (!valid) {
    res.status(401).json({ error: '密碼錯誤' });
    return;
  }

  try {
    const result = await triggerSystemUpdate({ username: admin.username });
    addLoginLog({
      userId: admin.id,
      username: admin.username,
      isAdmin: true,
      method: 'password',
      success: result.update.state !== 'failed',
      ip: clientIp(req),
      timestamp: new Date().toISOString(),
      action: 'admin-system-update',
      ...(result.update.state === 'failed'
        ? { failReason: result.message }
        : { note: `watchtower=${result.update.state}` }),
    }).catch(() => undefined);

    if (result.update.state === 'failed') {
      res.status(502).json({ error: result.message, update: result.update });
      return;
    }
    res.status(202).json(result);
  } catch (err) {
    if (err instanceof UpdateConfigurationError) {
      res.status(503).json({ error: err.message });
      return;
    }
    if (err instanceof UpdateConflictError) {
      res.status(409).json({ error: err.message });
      return;
    }
    next(err as Error);
  }
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
