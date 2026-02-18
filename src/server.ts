import http from 'node:http';
import { runPipeline } from './pipeline.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const AGENT_API_TOKEN = process.env.AGENT_API_TOKEN || '';
const SCHEDULE_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

let isRunning = false;
let currentRunId: string | null = null;

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function authenticate(req: http.IncomingMessage): boolean {
  if (!AGENT_API_TOKEN) return true; // no token configured = open (dev mode)
  const auth = req.headers.authorization;
  return auth === `Bearer ${AGENT_API_TOKEN}`;
}

async function triggerRun(dryRun: boolean): Promise<string> {
  isRunning = true;
  currentRunId = null;
  try {
    const runId = await runPipeline({ dryRun });
    currentRunId = runId;
    return runId;
  } finally {
    isRunning = false;
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  // CORS headers for frontend
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // GET / or /health
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
    json(res, 200, { status: 'ok', isRunning, currentRunId });
    return;
  }

  // POST /trigger
  if (req.method === 'POST' && url.pathname === '/trigger') {
    if (!authenticate(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }

    if (isRunning) {
      json(res, 409, { error: 'A run is already in progress', currentRunId });
      return;
    }

    const dryRun = url.searchParams.get('dry_run') === 'true';

    // Fire and forget — return 202 immediately
    json(res, 202, { message: 'Run started', dryRun });

    triggerRun(dryRun).catch((err) => {
      console.error(`[server] Pipeline error: ${err instanceof Error ? err.message : err}`);
    });
    return;
  }

  json(res, 404, { error: 'Not found' });
});

export function startServer() {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] Agent HTTP server listening on port ${PORT}`);
  });

  // Schedule runs every 4 hours
  console.log(`[server] Scheduling pipeline every ${SCHEDULE_INTERVAL_MS / 3600000}h`);
  setInterval(() => {
    if (isRunning) {
      console.log('[server] Skipping scheduled run — already running');
      return;
    }
    console.log('[server] Starting scheduled run...');
    triggerRun(false).catch((err) => {
      console.error(`[server] Scheduled run failed: ${err instanceof Error ? err.message : err}`);
    });
  }, SCHEDULE_INTERVAL_MS);
}
