import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { loadMasterKey } from './crypto.js';
import authRouter from './routes/auth.js';
import dataRouter from './routes/data.js';
import adminRouter from './routes/admin.js';

// Load or auto-generate encryption key, then start the HTTP server
(async () => {
  await loadMasterKey();

  const app = express();
  const PORT = process.env.PORT ?? 3001;

  app.use(cors({
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    credentials: true,
  }));
  app.use(express.json({ limit: '50mb' })); // NHI JSON files can be large

  app.use('/api/auth', authRouter);
  app.use('/api/data', dataRouter);
  app.use('/api/admin', adminRouter);

  // Health check
  app.get('/api/ping', (_req, res) => res.json({ ok: true }));

  // Global error handler — ensures every error returns JSON, never empty body
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    // Handle Express body-parser errors (e.g. JSON too large, malformed JSON)
    const status = (err as { status?: number; statusCode?: number }).status
      ?? (err as { statusCode?: number }).statusCode
      ?? 500;
    res.status(status).json({ error: err.message ?? '伺服器錯誤' });
  });

  app.listen(PORT, () => {
    console.log(`健康存摺伺服器啟動：http://localhost:${PORT}`);
  });
})().catch((err: Error) => {
  console.error('[startup] 致命錯誤，伺服器無法啟動：', err);
  process.exit(1);
});