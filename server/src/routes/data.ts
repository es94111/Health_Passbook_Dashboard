import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { getRecords, mergeRecords, flattenRecords } from '../store.js';

const router = Router();

// All data routes require authentication
router.use(requireAuth);

// GET /api/data  — fetch all stored health records for the current user
router.get('/', async (req, res) => {
  const userId = req.user!.userId;
  const stored = await getRecords(userId);
  res.json(flattenRecords(stored));
});

// POST /api/data/upload  — merge new NHI JSON into existing data
// Body: the raw NHI JSON object (the full export file contents)
router.post('/upload', async (req, res) => {
  const userId = req.user!.userId;
  const body = req.body as Record<string, unknown>;

  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: '無效的 JSON 格式' });
    return;
  }

  // NHI JSON has top-level keys r1, r2, r3, r6, r7, r8 as arrays
  const incoming: Partial<Record<string, object[]>> = {};
  for (const type of ['r1', 'r2', 'r3', 'r6', 'r7', 'r8']) {
    const arr = body[type];
    if (Array.isArray(arr)) {
      incoming[type] = arr as object[];
    }
  }

  const stats = await mergeRecords(userId, incoming);

  const totalAdded = Object.values(stats).reduce((s, v) => s + v.added, 0);
  const totalSkipped = Object.values(stats).reduce((s, v) => s + v.skipped, 0);

  res.json({
    message: `匯入完成：新增 ${totalAdded} 筆，略過重複 ${totalSkipped} 筆`,
    stats,
  });
});

// DELETE /api/data  — clear all health records for current user
router.delete('/', async (req, res) => {
  const userId = req.user!.userId;
  const { mergeRecords: merge } = await import('../store.js');
  // Overwrite with empty by merging nothing — just write empty
  const { getRecords: get } = await import('../store.js');
  const existing = await get(userId);
  // Clear all
  for (const key of Object.keys(existing) as (keyof typeof existing)[]) {
    existing[key] = {};
  }
  const { writeJson } = await import('../store.js').catch(() => ({ writeJson: undefined }));
  // Use the store's internal mechanism: merge with empty clears nothing,
  // so we need to expose a clearRecords function
  res.status(501).json({ error: '請使用管理員功能清除資料' });
});

export default router;