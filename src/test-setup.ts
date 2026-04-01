// Stub required env vars so config.ts doesn't throw at import time during tests.
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'test-service-role-key';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'test-anthropic-key';
process.env.EBAY_APP_ID = process.env.EBAY_APP_ID ?? 'test-ebay-app-id';
process.env.EBAY_CERT_ID = process.env.EBAY_CERT_ID ?? 'test-ebay-cert-id';
