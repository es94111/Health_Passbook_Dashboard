import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import { loadMasterKey } from './crypto.js';
import authRouter from './routes/auth.js';
import dataRouter from './routes/data.js';
import adminRouter from './routes/admin.js';
import { accountRouter } from './routes/account.js';

// Load or auto-generate encryption key, then start the HTTP server
(async () => {
  await loadMasterKey();

  const app = express();
  const PORT = process.env.PORT ?? 3001;

  // In production (Docker) the SPA is served by Express itself — same origin,
  // no CORS needed. CORS_ORIGIN lets you explicitly allowlist external origins
  // (e.g. a separate CDN front-end). In dev, default to the Vite dev server.
  const corsOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim())
    : ['http://localhost:5173', 'http://127.0.0.1:5173'];
  app.use(cors({ origin: corsOrigins, credentials: true }));
  app.use(express.json({ limit: '50mb' })); // NHI JSON files can be large

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
        "img-src 'self' data: https:",
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
  app.use(express.static(PUBLIC));
  // Express 5: bare '*' is no longer a valid route pattern; '/{*splat}' matches all paths incl. '/'
  app.get('/{*splat}', (_req, res, next) => {
    const indexFile = path.join(PUBLIC, 'index.html');
    res.sendFile(indexFile, (err) => { if (err) next(); });
  });

  // Global error handler — ensures every error returns JSON, never empty body
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    // Handle Express body-parser errors (e.g. JSON too large, malformed JSON)
    const status = (err as { status?: number; statusCode?: number }).status
      ?? (err as { statusCode?: number }).statusCode
      ?? 500;
    // Never leak internal error details (file paths, key formats, stack traces)
    // to clients in production — log them server-side instead.
    const message =
      process.env.NODE_ENV === 'production'
        ? '伺服器錯誤'
        : err.message ?? '伺服器錯誤';
    res.status(status).json({ error: message });
  });

  app.listen(PORT, () => {
    console.log(`健康存摺伺服器啟動：http://localhost:${PORT}`);
  });
})().catch((err: Error) => {
  console.error('[startup] 致命錯誤，伺服器無法啟動：', err);
  process.exit(1);
});
