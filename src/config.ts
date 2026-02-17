function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  // Required env vars
  SUPABASE_URL: requireEnv('SUPABASE_URL'),
  SUPABASE_SERVICE_ROLE_KEY: requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
  ANTHROPIC_API_KEY: requireEnv('ANTHROPIC_API_KEY'),
  EBAY_APP_ID: requireEnv('EBAY_APP_ID'),
  EBAY_CERT_ID: requireEnv('EBAY_CERT_ID'),

  // Hardcoded settings
  SEARCH_QUERY: 'headlight',
  CRAIGSLIST_ENABLED: false,
  CRAIGSLIST_CITY: 'newyork',
  CRAIGSLIST_LAT: '40.6782',
  CRAIGSLIST_LON: '-73.9442',
  CRAIGSLIST_DISTANCE: '100',
  GRADING_BATCH_SIZE: 10,
  GRADING_CONCURRENCY: 3,

  // CLI flags
  DRY_RUN: process.argv.includes('--dry-run'),
} as const;
