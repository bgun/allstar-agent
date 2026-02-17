export interface ScrapedListing {
  title: string;
  price: string | null;
  price_cents: number | null;
  link: string | null;
  image: string | null;
  source: 'ebay' | 'craigslist';
  external_id: string;
  condition: string | null;
  listing_date: string | null;
  location: string | null;
  seller_name: string | null;
  description: string | null;
  raw_data: Record<string, unknown>;
}
