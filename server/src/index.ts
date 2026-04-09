import express from 'express';
import cors from 'cors';
import authRouter from './routes/auth.js';
import dataRouter from './routes/data.js';
import adminRouter from './routes/admin.js';

const app = express();
const PORT = process.env.PORT ?? 3001;

app.use(cors({ origin: 'http://localhost:5173', credentials: true }));
app.use(express.json({ limit: '50mb' })); // NHI JSON files can be large

app.use('/api/auth', authRouter);
app.use('/api/data', dataRouter);
app.use('/api/admin', adminRouter);

// Health check
app.get('/api/ping', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`健康存摺伺服器啟動：http://localhost:${PORT}`);
});