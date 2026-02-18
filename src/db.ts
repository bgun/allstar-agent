import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from './config.js';
import type { ScrapedListing } from './scrapers/types.js';

// ---------- Types ----------

export interface StoredListing {
  id: string;
  url: string;
}

export interface Listing {
  id: string;
  title: string;
  price: string | null;
  price_cents: number | null;
  link: string | null;
  image: string | null;
  source: string;
  external_id: string;
  condition: string | null;
  listing_date: string | null;
  location: string | null;
  seller_name: string | null;
  description: string | null;
}

export interface GradeRow {
  listing_id: string;
  prompt_version: string;
  score: number;
  grade: string;
  rationale: string;
  flags: string[];
  model: string;
}

export interface Feedback {
  listing_title: string;
  score: number;
  grade: string;
  adjusted_score?: number;
  notes?: string;
}

export interface GradingCriteria {
  version: string;
  criteria_prompt: string;
}

// ---------- Client ----------

const supabase: SupabaseClient = createClient(
  config.SUPABASE_URL,
  config.SUPABASE_SERVICE_ROLE_KEY
);

// ---------- Run management ----------

export async function createRun(promptVersion: string, triggeredBy?: string): Promise<string> {
  const { data, error } = await supabase
    .from('agent_runs')
    .insert({
      status: 'running',
      prompt_version: promptVersion,
      started_at: new Date().toISOString(),
      triggered_by: triggeredBy || null,
    })
    .select('id')
    .single();

  if (error) throw new Error(`Failed to create run: ${error.message}`);
  return data.id as string;
}

export async function updateRun(
  runId: string,
  updates: Record<string, unknown>
): Promise<void> {
  const { error } = await supabase
    .from('agent_runs')
    .update(updates)
    .eq('id', runId);

  if (error) throw new Error(`Failed to update run ${runId}: ${error.message}`);
}

// ---------- Events ----------

export async function logEvent(
  runId: string,
  eventType: string,
  listingId: string | null,
  payload: Record<string, unknown>
): Promise<void> {
  const { error } = await supabase.from('agent_events').insert({
    run_id: runId,
    event_type: eventType,
    listing_id: listingId,
    payload,
  });

  if (error) {
    console.error(`Failed to log event ${eventType}: ${error.message}`);
  }
}

// ---------- Listings ----------

export interface DedupeResult {
  unique: ScrapedListing[];
  duplicatesSkipped: number;
}

export async function deduplicateListings(
  listings: ScrapedListing[]
): Promise<DedupeResult> {
  if (listings.length === 0) return { unique: listings, duplicatesSkipped: 0 };

  // Collect external_ids to check against DB
  const externalIds = listings
    .map((l) => l.external_id)
    .filter((id): id is string => !!id);

  if (externalIds.length === 0) return { unique: listings, duplicatesSkipped: 0 };

  // Query existing listings by external_id + source
  const { data: existing, error } = await supabase
    .from('listings')
    .select('external_id, source')
    .in('external_id', externalIds);

  if (error) {
    console.warn(`Failed to check duplicates: ${error.message}`);
    return { unique: listings, duplicatesSkipped: 0 };
  }

  const existingSet = new Set(
    (existing ?? []).map((row: { external_id: string; source: string }) => `${row.source}:${row.external_id}`)
  );

  const unique = listings.filter(
    (l) => !l.external_id || !existingSet.has(`${l.source}:${l.external_id}`)
  );

  return {
    unique,
    duplicatesSkipped: listings.length - unique.length,
  };
}

export async function upsertListings(
  listings: ScrapedListing[]
): Promise<StoredListing[]> {
  if (listings.length === 0) return [];

  const rows = listings
    .filter((l) => l.link)
    .map((l) => ({
      url: l.link,
      source: l.source,
      external_id: l.external_id || null,
      title: l.title,
      price_cents: l.price_cents || null,
      price_text: l.price || null,
      location: l.location || null,
      seller_name: l.seller_name || null,
      image_urls: l.image ? [l.image] : null,
      condition: l.condition || null,
      listing_date: l.listing_date || null,
      description: l.description || null,
      raw_data: l.raw_data || null,
      scraped_at: new Date().toISOString(),
    }));

  const { data, error } = await supabase
    .from('listings')
    .upsert(rows, { onConflict: 'url', ignoreDuplicates: false })
    .select('id, url');

  if (error) throw new Error(`Failed to upsert listings: ${error.message}`);
  return (data ?? []) as StoredListing[];
}

// ---------- Ungraded listings ----------

export async function getUngradedListings(
  promptVersion: string
): Promise<Listing[]> {
  const { data, error } = await supabase.rpc('get_ungraded_listings', {
    p_prompt_version: promptVersion,
  });

  if (error) {
    // Fallback: manual query if RPC doesn't exist
    console.warn(
      `RPC get_ungraded_listings not found, using manual query: ${error.message}`
    );
    return getUngradedListingsFallback(promptVersion);
  }

  return (data ?? []) as Listing[];
}

async function getUngradedListingsFallback(
  promptVersion: string
): Promise<Listing[]> {
  // Get all listing IDs that already have a grade for this prompt version
  const { data: gradedData, error: gradedError } = await supabase
    .from('grades')
    .select('listing_id')
    .eq('prompt_version', promptVersion);

  if (gradedError)
    throw new Error(`Failed to fetch graded listings: ${gradedError.message}`);

  const gradedIds = (gradedData ?? []).map(
    (g: { listing_id: string }) => g.listing_id
  );

  // Get all listings not in the graded set
  let query = supabase
    .from('listings')
    .select(
      'id, title, price_text, price_cents, url, image_urls, source, external_id, condition, listing_date, location, seller_name, description'
    );

  if (gradedIds.length > 0) {
    query = query.not('id', 'in', `(${gradedIds.join(',')})`);
  }

  const { data, error } = await query;

  if (error)
    throw new Error(`Failed to fetch ungraded listings: ${error.message}`);

  return (data ?? []).map((row) => ({
    id: row.id,
    title: row.title,
    price: row.price_text,
    price_cents: row.price_cents,
    link: row.url,
    image: row.image_urls?.[0] || null,
    source: row.source,
    external_id: row.external_id,
    condition: row.condition,
    listing_date: row.listing_date,
    location: row.location,
    seller_name: row.seller_name,
    description: row.description,
  })) as Listing[];
}

// ---------- Grading criteria ----------

export async function getActiveCriteria(): Promise<GradingCriteria> {
  const { data, error } = await supabase
    .from('grading_criteria')
    .select('version, criteria_prompt')
    .eq('is_active', true)
    .limit(1)
    .single();

  if (error)
    throw new Error(`Failed to fetch active grading criteria: ${error.message}`);
  return data as GradingCriteria;
}

// ---------- Feedback ----------

export async function getDisagreements(limit: number): Promise<Feedback[]> {
  const { data, error } = await supabase
    .from('buyer_feedback')
    .select(
      `
      adjusted_score,
      notes,
      grades!grade_id (
        score,
        grade_letter,
        listings!listing_id (
          title
        )
      )
    `
    )
    .eq('verdict', 'disagree')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.warn(`Failed to fetch disagreements: ${error.message}`);
    return [];
  }

  return (data ?? []).map((row: Record<string, unknown>) => {
    const grade = row.grades as Record<string, unknown>;
    const listing = grade.listings as Record<string, unknown>;
    return {
      listing_title: listing.title as string,
      score: grade.score as number,
      grade: grade.grade_letter as string,
      adjusted_score: row.adjusted_score as number | undefined,
      notes: row.notes as string | undefined,
    };
  });
}

export async function getAgreements(limit: number): Promise<Feedback[]> {
  const { data, error } = await supabase
    .from('buyer_feedback')
    .select(
      `
      grades!grade_id (
        score,
        grade_letter,
        listings!listing_id (
          title
        )
      )
    `
    )
    .eq('verdict', 'agree')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.warn(`Failed to fetch agreements: ${error.message}`);
    return [];
  }

  return (data ?? []).map((row: Record<string, unknown>) => {
    const grade = row.grades as Record<string, unknown>;
    const listing = grade.listings as Record<string, unknown>;
    return {
      listing_title: listing.title as string,
      score: grade.score as number,
      grade: grade.grade_letter as string,
    };
  });
}

// ---------- Grades ----------

export async function insertGrade(grade: GradeRow): Promise<void> {
  const { error } = await supabase.from('grades').insert({
    listing_id: grade.listing_id,
    score: grade.score,
    grade_letter: grade.grade,
    rationale: grade.rationale,
    flags: grade.flags,
    model_used: grade.model,
    prompt_version: grade.prompt_version,
    graded_at: new Date().toISOString(),
  });

  if (error) throw new Error(`Failed to insert grade: ${error.message}`);
}

// ---------- Stats ----------

export async function getListingStats(promptVersion: string): Promise<{
  total: number;
  graded: number;
  ungraded: number;
}> {
  const [totalRes, gradedRes] = await Promise.all([
    supabase.from('listings').select('id', { count: 'exact', head: true }),
    supabase
      .from('grades')
      .select('id', { count: 'exact', head: true })
      .eq('prompt_version', promptVersion),
  ]);

  const total = totalRes.count ?? 0;
  const graded = gradedRes.count ?? 0;

  return { total, graded, ungraded: total - graded };
}
