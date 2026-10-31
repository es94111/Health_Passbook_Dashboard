import { Router, type Request, type Response, type NextFunction } from 'express';
import { EncryptedDataError } from '../clientEncryption.js';
import { requireAuth } from '../auth.js';
import {
  getHealthDataForClient,
  getLegacyRecordsForClientEncryption,
  saveClientEncryptedRecords,
  saveEncryptedAttachment,
  getEncryptedAttachment,
  type ClientEncryptedRecords,
} from '../store.js';

const router = Router();

router.use(requireAuth);
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

interface UploadBody {
  envelope?: ClientEncryptedRecords;
  stats?: unknown;
  expectedRevision?: string | null;
}

interface ImportCounts { added: number; updated: number; skipped: number }

function sanitizeStats(value: unknown): Record<string, ImportCounts> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const entries = Object.entries(value).slice(0, 32).filter(([key, counts]) =>
    /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(key) && typeof counts === 'object' && counts !== null && !Array.isArray(counts),
  );
  return Object.fromEntries(entries.map(([key, counts]) => {
    const count = (field: keyof ImportCounts): number => {
      const n = (counts as Record<string, unknown>)[field];
      return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : 0;
    };
    return [key, { added: count('added'), updated: count('updated'), skipped: count('skipped') }];
  }));
}

router.get('/', async (req, res) => {
  const data = await getHealthDataForClient(req.user!.userId);
  res.json(data);
});

router.get('/legacy', async (req, res) => {
  const records = await getLegacyRecordsForClientEncryption(req.user!.userId);
  res.json({ records });
});

router.put('/attachments/:id', async (req, res) => {
  const { envelope } = (req.body ?? {}) as { envelope: ClientEncryptedRecords };
  await saveEncryptedAttachment(req.user!.userId, req.params.id, envelope);
  res.json({ message: 'Encrypted attachment saved.' });
});

router.get('/attachments/:id', async (req, res) => {
  const envelope = await getEncryptedAttachment(req.user!.userId, req.params.id);
  if (!envelope) {
    res.status(404).json({ error: 'Encrypted attachment not found' });
    return;
  }
  res.json({ envelope });
});

router.post('/upload', async (req, res) => {
  const { envelope, stats, expectedRevision } = (req.body ?? {}) as UploadBody;
  if (!envelope) {
    res.status(400).json({ error: 'Missing encrypted health records envelope' });
    return;
  }

  await saveClientEncryptedRecords(req.user!.userId, envelope, expectedRevision);
  const safeStats = sanitizeStats(stats);
  const total = (field: keyof ImportCounts): number => Object.values(safeStats)
    .reduce((sum, counts) => Math.min(Number.MAX_SAFE_INTEGER, sum + counts[field]), 0);

  res.json({
    message: `Encrypted health data saved. Added ${total('added')}, updated ${total('updated')}, skipped ${total('skipped')}.`,
    stats: safeStats,
  });
});

router.use((err: Error, _req: Request, res: Response, next: NextFunction) => {
  if (!(err instanceof EncryptedDataError)) {
    next(err);
    return;
  }
  res.status(err.status).json({ error: err.status >= 500 ? 'Encrypted data could not be read' : err.message });
});

export default router;
