import fs from 'node:fs';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { config } from './config.js';
import { logger } from './logger.js';
import { generateRouter } from './routes/generate.routes.js';
import { pdfRouter } from './routes/pdf.routes.js';
import { templatesRouter } from './routes/templates.routes.js';

const app = express();

app.use(
  helmet({
    contentSecurityPolicy: false, // SPA + blob preview; tighten in production
  }),
);
app.use(express.json({ limit: '8mb' }));
app.use(pinoHttp({ logger }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api', pdfRouter);
app.use('/api', templatesRouter);
app.use('/api', generateRouter);

// Serve the built SPA in production (no-op in dev where Vite serves the app).
if (fs.existsSync(config.webDist)) {
  app.use(express.static(config.webDist));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile('index.html', { root: config.webDist });
  });
}

app.listen(config.port, () => {
  logger.info(`[server] listening on http://localhost:${config.port}`);
});
