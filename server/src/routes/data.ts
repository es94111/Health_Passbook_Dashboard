import { Router } from 'express';
import { requireAuth } from '../auth.js';
import {
  getClientEncryptedRecords,
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
  const envelope = await getClientEncryptedRecords(req.user!.userId);
  res.json({ envelope });
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
