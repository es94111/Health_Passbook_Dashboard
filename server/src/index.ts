import express, { type Request, type Response, type NextFunction } from 'express';
import compression from 'compression';
import cors from 'cors';
import path from 'path';
import { loadMasterKey } from './crypto.js';
import authRouter from './routes/auth.js';
import dataRouter from './routes/data.js';
import adminRouter from './routes/admin.js';
import { accountRouter } from './routes/account.js';
import { createServer } from 'node:http';
import { BackupSizeError } from './backupLimits.js';

export function createApp() {
  const app = express();

  // In production (Docker) the SPA is served by Express itself — same origin,
  // no CORS needed. CORS_ORIGIN lets you explicitly allowlist external origins
  // (e.g. a separate CDN front-end). In dev, default to the Vite dev server.
  const corsOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim())
    : ['http://localhost:5173', 'http://127.0.0.1:5173'];
  app.use(cors({ origin: corsOrigins, credentials: true }));
  // Compress text assets/JSON. Encrypted payloads (`/api/data`) and backup
  // streams (`/api/admin/backup`) are already incompressible, so skip them to
  // avoid wasting CPU on every record read/write.
  app.use(compression({
    threshold: 1024,
    filter: (req, res) => {
      // Inside a mounted router req.path is relative; use the original URL.
      if (/^\/api\/(?:data|admin\/backup)(?:\/|$)/i.test(req.originalUrl.split('?')[0])) return false;
      return compression.filter(req, res);
    },
  }));
  app.use((req, res, next) => {
    // Ordinary request bodies retain a five-minute absolute deadline. Only an
    // authenticated backup operation may replace it with its 24-hour deadline.
    const timer = setTimeout(() => {
      if (req.complete) return;
      if (res.headersSent) res.destroy();
      else {
        res.setHeader('Connection', 'close');
        res.status(408).json({ error: '上傳逾時' });
      }
    }, 5 * 60 * 1000);
    timer.unref();
    const cancel = () => clearTimeout(timer);
    res.locals.cancelBodyDeadline = cancel;
    req.once('end', cancel);
    res.once('close', cancel);
    next();
  });
  const parseJson = express.json({ limit: '50mb' });
  app.use((req, res, next) => {
    // Authenticate/admin-allowlist first; the import route consumes raw bytes
    // with backpressure, never a 20 GB express.json/JSON.parse allocation.
    if (/^\/api\/admin\/backup\/import\/?$/i.test(req.path)) next();
    else parseJson(req, res, next);
  });

  // Requests without a JSON body (no Content-Type header) leave req.body
  // undefined; a literal `null` body also parses to null. Normalize both to {}
  // so handlers never crash on destructuring.
  app.use((req, _res, next) => {
    if (req.body === undefined || req.body === null) req.body = {};
    next();
  });

  // Basic security headers. CSP allows Google Sign-In (gsi) and Google Fonts —
  // keep in sync with the external resources in dashboard/index.html.
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self' https://accounts.google.com",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data: blob: https:",
        "connect-src 'self' https://accounts.google.com",
        "frame-src https://accounts.google.com",
        "frame-ancestors 'none'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; '),
    );
    if (process.env.NODE_ENV === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });

  app.use('/api/auth', authRouter);
  app.use('/api/data', dataRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/account', accountRouter);

  // Health check
  app.get('/api/ping', (_req, res) => res.json({ ok: true }));

  // Serve dashboard SPA in production (docker / npm start)
  // In dev the Vite dev server handles this via proxy — only activate when public/ exists
  const PUBLIC = path.join(process.cwd(), 'public');
  app.use(express.static(PUBLIC, {
    index: false,
    setHeaders: (res, filePath) => {
      // Vite emits content-hashed files under /assets — safe to cache forever.
      if (/[/\\]assets[/\\]/.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }));
  // Express 5: bare '*' is no longer a valid route pattern; '/{*splat}' matches all paths incl. '/'
  app.get('/{*splat}', (_req, res, next) => {
    const indexFile = path.join(PUBLIC, 'index.html');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexFile, (err) => { if (err) next(); });
  });

  // Global error handler — ensures every error returns JSON, never empty body
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    // Handle Express body-parser errors (e.g. JSON too large, malformed JSON)
    const status = (err as { status?: number; statusCode?: number }).status
      ?? (err as { statusCode?: number }).statusCode
      ?? 500;
    // Body-parser errors can carry the entire submitted body; never log it.
    console.error('[server] Request failed', { name: err.name, status });
    if (res.headersSent) { res.destroy(); return; }
    if (err instanceof BackupSizeError) {
      res.status(err.status).json({ error: err.message, code: err.code, limitBytes: err.limitBytes });
      return;
    }
    // Never expose internal file paths, key formats, or stack traces to production clients.
    const message =
      process.env.NODE_ENV === 'production'
        ? '伺服器錯誤'
        : err.message ?? '伺服器錯誤';
    res.status(status).json({ error: message });
  });

  return app;
}

export function createHttpServer() {
  // Per-request deadlines above replace Node's global five-minute body timer;
  // header parsing remains bounded independently of backup upload duration.
  return createServer({ requestTimeout: 0, headersTimeout: 60_000 }, createApp());
}

if (require.main === module) {
  (async () => {
    await loadMasterKey();
    const PORT = process.env.PORT ?? 3001;
    createHttpServer().listen(PORT, () => {
      console.log(`健康存摺伺服器啟動：http://localhost:${PORT}`);
    });
  })().catch((err: Error) => {
    console.error('[startup] 致命錯誤，伺服器無法啟動：', err);
    process.exit(1);
  });
}
