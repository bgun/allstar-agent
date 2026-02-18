import http from 'node:http';
import { runPipeline } from './pipeline.js';
import { parseEbayItemId, fetchEbayItem } from './scrapers/ebay.js';
import { fetchCraigslistItem } from './scrapers/craigslist.js';
import {
  createRun,
  updateRun,
  logEvent,
  upsertListings,
  getActiveCriteria,
  getDisagreements,
  getAgreements,
  insertGrade,
  getListingStats,
} from './db.js';
import {
  buildSystemPrompt,
  gradeListing,
} from './grader.js';
import type { ScrapedListing } from './scrapers/types.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const AGENT_API_TOKEN = process.env.AGENT_API_TOKEN || '';

let isRunning = false;
let currentRunId: string | null = null;
let currentAbortController: AbortController | null = null;

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function authenticate(req: http.IncomingMessage): boolean {
  if (!AGENT_API_TOKEN) return true; // no token configured = open (dev mode)
  const auth = req.headers.authorization;
  return auth === `Bearer ${AGENT_API_TOKEN}`;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

async function triggerRun(dryRun: boolean, triggeredBy?: string): Promise<string> {
  isRunning = true;
  currentRunId = null;
  currentAbortController = new AbortController();
  try {
    const runId = await runPipeline({ dryRun, triggeredBy, abortSignal: currentAbortController.signal });
    currentRunId = runId;
    return runId;
  } finally {
    isRunning = false;
    currentAbortController = null;
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

    // Read body for triggered_by, then fire and forget
    readBody(req).then((body) => {
      let triggeredBy: string | undefined;
      try {
        const parsed = JSON.parse(body) as { triggered_by?: string };
        triggeredBy = parsed.triggered_by || undefined;
      } catch {
        // No body or invalid JSON is fine — triggered_by is optional
      }

      json(res, 202, { message: 'Run started', dryRun });

      triggerRun(dryRun, triggeredBy).catch((err) => {
        console.error(`[server] Pipeline error: ${err instanceof Error ? err.message : err}`);
      });
    });
    return;
  }

  // POST /grade-url
  if (req.method === 'POST' && url.pathname === '/grade-url') {
    if (!authenticate(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }

    readBody(req).then(async (body) => {
      try {
        const { url: listingUrl, triggered_by: triggeredBy } = JSON.parse(body) as { url?: string; triggered_by?: string };
        if (!listingUrl || typeof listingUrl !== 'string') {
          json(res, 400, { error: 'Missing or invalid "url" field' });
          return;
        }

        // Detect source from URL
        let source: 'ebay' | 'craigslist';
        if (/ebay\.com/i.test(listingUrl)) {
          source = 'ebay';
        } else if (/craigslist\.org/i.test(listingUrl)) {
          source = 'craigslist';
        } else {
          json(res, 400, { error: 'URL must be from ebay.com or craigslist.org' });
          return;
        }

        // Scrape the single item
        let scraped: ScrapedListing;
        if (source === 'ebay') {
          const itemId = parseEbayItemId(listingUrl);
          scraped = await fetchEbayItem(itemId);
        } else {
          scraped = await fetchCraigslistItem(listingUrl);
        }

        // Upsert listing to DB
        const stored = await upsertListings([scraped]);
        if (stored.length === 0) {
          json(res, 500, { error: 'Failed to store listing' });
          return;
        }
        const listingId = stored[0]!.id;

        // Load criteria + feedback
        const criteria = await getActiveCriteria();
        const disagreements = await getDisagreements(20);
        const agreements = await getAgreements(5);
        const systemPrompt = buildSystemPrompt(criteria.criteria_prompt, disagreements, agreements);

        // Create a mini run
        const runId = await createRun(criteria.version, triggeredBy || undefined);
        await logEvent(runId, 'grade_started', listingId, {
          title: scraped.title,
          source,
          manual: true,
        });

        // Grade the listing
        const listing = {
          id: listingId,
          title: scraped.title,
          price: scraped.price,
          price_cents: scraped.price_cents,
          link: scraped.link,
          image: scraped.image,
          source: scraped.source,
          external_id: scraped.external_id,
          condition: scraped.condition,
          listing_date: scraped.listing_date,
          location: scraped.location,
          seller_name: scraped.seller_name,
          description: scraped.description,
        };

        const result = await gradeListing(listing, systemPrompt, false);

        // Insert grade
        await insertGrade({
          listing_id: listingId,
          prompt_version: criteria.version,
          score: result.score,
          grade: result.grade,
          rationale: result.rationale,
          flags: result.flags,
          model: 'claude-sonnet-4-5-20250929',
        });

        await logEvent(runId, 'grade_completed', listingId, {
          score: result.score,
          grade: result.grade,
        });

        // Finalize run
        await updateRun(runId, {
          status: 'completed',
          finished_at: new Date().toISOString(),
          listings_scraped: 1,
          listings_graded: 1,
          listings_failed: 0,
          average_score: result.score,
        });

        await logEvent(runId, 'run_completed', null, {
          listings_scraped: 1,
          listings_graded: 1,
          listings_failed: 0,
          average_score: result.score,
          manual: true,
          triggered_by: triggeredBy || null,
        });

        json(res, 200, {
          listing_id: listingId,
          run_id: runId,
          title: scraped.title,
          price: scraped.price,
          image: scraped.image,
          source,
          link: scraped.link,
          grade: result.grade,
          score: result.score,
          rationale: result.rationale,
          flags: result.flags,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[grade-url] Error: ${msg}`);
        json(res, 500, { error: msg });
      }
    });
    return;
  }

  // POST /stop
  if (req.method === 'POST' && url.pathname === '/stop') {
    if (!authenticate(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }

    if (!isRunning || !currentAbortController) {
      json(res, 409, { error: 'No run is currently in progress' });
      return;
    }

    currentAbortController.abort();
    json(res, 200, { message: 'Stop signal sent' });
    return;
  }

  // GET /stats
  if (req.method === 'GET' && url.pathname === '/stats') {
    if (!authenticate(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }

    (async () => {
      try {
        const criteria = await getActiveCriteria();
        const stats = await getListingStats(criteria.version);
        json(res, 200, { ...stats, prompt_version: criteria.version });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        json(res, 500, { error: msg });
      }
    })();
    return;
  }

  // GET /system-prompt
  if (req.method === 'GET' && url.pathname === '/system-prompt') {
    if (!authenticate(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }

    (async () => {
      try {
        const criteria = await getActiveCriteria();
        const disagreements = await getDisagreements(20);
        const agreements = await getAgreements(5);
        const systemPrompt = buildSystemPrompt(criteria.criteria_prompt, disagreements, agreements);
        json(res, 200, { prompt: systemPrompt, version: criteria.version });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        json(res, 500, { error: msg });
      }
    })();
    return;
  }

  json(res, 404, { error: 'Not found' });
});

export function startServer() {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] Agent HTTP server listening on port ${PORT}`);
    console.log(`[server] Runs are manual-only — use POST /trigger to start`);
  });
}
