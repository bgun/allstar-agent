import { config } from './config.js';
import {
  createRun,
  updateRun,
  logEvent,
  upsertListings,
  getUngradedListings,
  getActiveCriteria,
  getDisagreements,
  getAgreements,
} from './db.js';
import { searchEbay } from './scrapers/ebay.js';
import { searchCraigslist } from './scrapers/craigslist.js';
import { gradeInBatches } from './grader.js';
import type { ScrapedListing } from './scrapers/types.js';

function ts(): string {
  return new Date().toISOString();
}

export async function runPipeline(opts: { dryRun: boolean }): Promise<string> {
  console.log(`[${ts()}] Allstar Agent starting...`);
  console.log(`[${ts()}] Dry run: ${opts.dryRun}`);
  console.log(`[${ts()}] Search query: "${config.SEARCH_QUERY}"`);
  console.log(`[${ts()}] Craigslist enabled: ${config.CRAIGSLIST_ENABLED}`);

  // Step 1: Load active grading criteria
  console.log(`[${ts()}] Loading active grading criteria...`);
  const criteria = await getActiveCriteria();
  console.log(`[${ts()}] Using prompt version: ${criteria.version}`);

  // Step 2: Create agent run
  const runId = await createRun(criteria.version);
  console.log(`[${ts()}] Created run: ${runId}`);

  try {
    const allListings: ScrapedListing[] = [];

    // Step 3: Run eBay scraper
    console.log(`[${ts()}] Starting eBay scrape...`);
    await logEvent(runId, 'scrape_started', null, { source: 'ebay', query: config.SEARCH_QUERY });

    const ebayResult = await searchEbay(config.SEARCH_QUERY);
    console.log(`[${ts()}] eBay: found ${ebayResult.items.length} listings`);
    await logEvent(runId, 'scrape_completed', null, {
      source: 'ebay',
      count: ebayResult.items.length,
      url: ebayResult.url,
    });
    allListings.push(...ebayResult.items);

    // Step 4: Run Craigslist scraper if enabled
    if (config.CRAIGSLIST_ENABLED) {
      console.log(`[${ts()}] Starting Craigslist scrape...`);
      await logEvent(runId, 'scrape_started', null, {
        source: 'craigslist',
        query: config.SEARCH_QUERY,
      });

      const clResult = await searchCraigslist(config.SEARCH_QUERY, {
        city: config.CRAIGSLIST_CITY,
        lat: parseFloat(config.CRAIGSLIST_LAT),
        lon: parseFloat(config.CRAIGSLIST_LON),
        search_distance: parseInt(config.CRAIGSLIST_DISTANCE, 10),
      });

      console.log(`[${ts()}] Craigslist: found ${clResult.items.length} listings`);
      await logEvent(runId, 'scrape_completed', null, {
        source: 'craigslist',
        count: clResult.items.length,
        url: clResult.url,
      });
      allListings.push(...clResult.items);
    }

    // Step 5: Upsert all scraped listings
    console.log(`[${ts()}] Upserting ${allListings.length} listings...`);
    const stored = await upsertListings(allListings);
    console.log(`[${ts()}] Stored ${stored.length} listings`);
    await logEvent(runId, 'listings_stored', null, { count: stored.length });

    await updateRun(runId, { listings_scraped: allListings.length });

    // Step 6: Fetch ungraded listings
    console.log(`[${ts()}] Fetching ungraded listings for prompt version "${criteria.version}"...`);
    const ungraded = await getUngradedListings(criteria.version);
    console.log(`[${ts()}] Found ${ungraded.length} ungraded listings`);

    if (ungraded.length === 0) {
      console.log(`[${ts()}] No ungraded listings — skipping grading`);
      await updateRun(runId, {
        status: 'completed',
        finished_at: new Date().toISOString(),
        listings_graded: 0,
        listings_failed: 0,
        average_score: null,
      });
      await logEvent(runId, 'run_completed', null, {
        listings_scraped: allListings.length,
        listings_graded: 0,
        listings_failed: 0,
      });
      console.log(`[${ts()}] Run completed (no grading needed)`);
      return runId;
    }

    // Step 7: Load feedback for prompt context
    console.log(`[${ts()}] Loading feedback history...`);
    const disagreements = await getDisagreements(20);
    const agreements = await getAgreements(5);
    console.log(
      `[${ts()}] Loaded ${disagreements.length} disagreements, ${agreements.length} agreements`
    );

    // Step 8: Grade in batches
    console.log(`[${ts()}] Starting grading (batch_size=${config.GRADING_BATCH_SIZE}, concurrency=${config.GRADING_CONCURRENCY})...`);
    const stats = await gradeInBatches(
      ungraded,
      criteria.criteria_prompt,
      disagreements,
      agreements,
      {
        batchSize: config.GRADING_BATCH_SIZE,
        concurrency: config.GRADING_CONCURRENCY,
        dryRun: opts.dryRun,
        runId,
        promptVersion: criteria.version,
      }
    );

    console.log(`[${ts()}] Grading complete: ${stats.graded} graded, ${stats.failed} failed, avg score ${stats.averageScore}`);

    // Step 9: Finalize run
    await updateRun(runId, {
      status: 'completed',
      finished_at: new Date().toISOString(),
      listings_graded: stats.graded,
      listings_failed: stats.failed,
      average_score: stats.averageScore,
    });

    await logEvent(runId, 'run_completed', null, {
      listings_scraped: allListings.length,
      listings_graded: stats.graded,
      listings_failed: stats.failed,
      average_score: stats.averageScore,
    });

    console.log(`[${ts()}] Run ${runId} completed successfully`);
    return runId;
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : String(error);
    console.error(`[${ts()}] Run failed: ${errMessage}`);

    try {
      await updateRun(runId, {
        status: 'failed',
        finished_at: new Date().toISOString(),
        error_message: errMessage,
      });
      await logEvent(runId, 'run_failed', null, { error: errMessage });
    } catch (logError) {
      console.error(`[${ts()}] Failed to log run failure:`, logError);
    }

    throw error;
  }
}
