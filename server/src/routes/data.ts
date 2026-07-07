import { Router } from 'express';
import { requireAuth } from '../auth.js';
import {
  getHealthDataForClient,
  getLegacyRecordsForClientEncryption,
  saveClientEncryptedRecords,
  type ClientEncryptedRecords,
} from '../store.js';

const router = Router();

router.use(requireAuth);

interface UploadBody {
  envelope?: ClientEncryptedRecords;
  stats?: Record<string, { added: number; skipped: number }>;
}

router.get('/', async (req, res) => {
  const data = await getHealthDataForClient(req.user!.userId);
  res.json(data);
});

router.get('/legacy', async (req, res) => {
  const records = await getLegacyRecordsForClientEncryption(req.user!.userId);
  res.json({ records });
});

router.post('/upload', async (req, res) => {
  const { envelope, stats } = req.body as UploadBody;
  if (!envelope) {
    res.status(400).json({ error: 'Missing encrypted health records envelope' });
    return;
  }

  await saveClientEncryptedRecords(req.user!.userId, envelope);
  const safeStats = stats ?? {};
  const totalAdded = Object.values(safeStats).reduce((s, v) => s + Number(v.added ?? 0), 0);
  const totalSkipped = Object.values(safeStats).reduce((s, v) => s + Number(v.skipped ?? 0), 0);

  res.json({
    message: `Encrypted health data saved. Added ${totalAdded}, skipped ${totalSkipped}.`,
    stats: safeStats,
  });
});

export default router;
