import axios from 'axios';
import { config } from '../config.js';
import type { ScrapedListing } from './types.js';

const SANDBOX_BASE = 'https://api.sandbox.ebay.com';
const PRODUCTION_BASE = 'https://api.ebay.com';

interface EbayPreferences {
  category_id?: string;
  condition_ids?: string[];
  excluded_keywords?: string[];
  buying_options?: string[];
  sort?: string;
  max_price?: string;
  brand_type_oem?: boolean;
  origin_us?: boolean;
}

const DEFAULT_PREFERENCES: Required<EbayPreferences> = {
  category_id: '33710',
  condition_ids: ['3000'],
  excluded_keywords: ['parting out', 'whole car', 'complete vehicle'],
  buying_options: ['FIXED_PRICE', 'BEST_OFFER', 'AUCTION'],
  sort: 'newlyListed',
  max_price: '500',
  brand_type_oem: true,
  origin_us: true,
};

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

export function getBaseUrl(): string {
  const isSandbox = config.EBAY_APP_ID.includes('SBX');
  return isSandbox ? SANDBOX_BASE : PRODUCTION_BASE;
}

export async function getOAuthToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const baseUrl = getBaseUrl();
  const credentials = Buffer.from(
    `${config.EBAY_APP_ID}:${config.EBAY_CERT_ID}`
  ).toString('base64');

  const { data } = await axios.post(
    `${baseUrl}/identity/v1/oauth2/token`,
    'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${credentials}`,
      },
    }
  );

  cachedToken = data.access_token as string;
  tokenExpiresAt = Date.now() + (data.expires_in - 300) * 1000;
  return cachedToken;
}

function buildFilterString(prefs: EbayPreferences): string | undefined {
  const filters: string[] = [];

  if (prefs.condition_ids?.length) {
    filters.push(`conditionIds:{${prefs.condition_ids.join('|')}}`);
  }
  if (prefs.buying_options?.length) {
    filters.push(`buyingOptions:{${prefs.buying_options.join('|')}}`);
  }
  if (prefs.max_price) {
    filters.push(`price:[..${prefs.max_price}],priceCurrency:USD`);
  }

  return filters.length ? filters.join(',') : undefined;
}

function buildQuery(baseQuery: string, prefs: EbayPreferences): string {
  let q = baseQuery;

  if (!/headlight/i.test(q)) {
    q = `${q} headlight`;
  }

  if (prefs.excluded_keywords?.length) {
    const exclusions = prefs.excluded_keywords
      .map((kw) => `-"${kw}"`)
      .join(' ');
    q = `${q} ${exclusions}`;
  }

  return q;
}

function buildAspectFilter(prefs: EbayPreferences): string | undefined {
  if (!prefs.category_id) return undefined;

  const aspects: string[] = [];
  if (prefs.brand_type_oem) {
    aspects.push('Brand Type:{Genuine OEM}');
  }
  if (prefs.origin_us) {
    aspects.push('Country/Region of Manufacture:{United States}');
  }

  if (!aspects.length) return undefined;
  return `categoryId:${prefs.category_id},${aspects.join(',')}`;
}

interface PriceObject {
  value?: string;
  currency?: string;
}

function formatPriceUsd(priceObj: PriceObject | undefined): string | null {
  if (!priceObj?.value) return null;
  const dollars = Math.round(parseFloat(priceObj.value));
  return `$${dollars}`;
}

interface EbaySearchResult {
  items: ScrapedListing[];
  url: string;
}

export async function searchEbay(
  query: string,
  preferences: EbayPreferences = {}
): Promise<EbaySearchResult> {
  const prefs: Required<EbayPreferences> = {
    ...DEFAULT_PREFERENCES,
    ...preferences,
  };
  const token = await getOAuthToken();
  const baseUrl = getBaseUrl();

  const params: Record<string, string | number> = {
    q: buildQuery(query, prefs),
    limit: 100,
    sort: prefs.sort || 'newlyListed',
  };

  if (prefs.category_id) {
    params.category_ids = prefs.category_id;
  }

  const filter = buildFilterString(prefs);
  if (filter) {
    params.filter = filter;
  }

  const aspectFilter = buildAspectFilter(prefs);
  if (aspectFilter) {
    params.aspect_filter = aspectFilter;
  }

  const url = `${baseUrl}/buy/browse/v1/item_summary/search`;

  const { data } = await axios.get(url, {
    params,
    headers: {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
    },
  });

  const constructedUrl = axios.getUri({ url, params });

  if (!data.itemSummaries) {
    return { items: [], url: constructedUrl };
  }

  const items: ScrapedListing[] = data.itemSummaries.map(
    (item: Record<string, unknown>) => {
      const price = item.price as PriceObject | undefined;
      const image = item.image as { imageUrl?: string } | undefined;
      const itemLocation = item.itemLocation as {
        city?: string;
        stateOrProvince?: string;
      } | undefined;
      const seller = item.seller as { username?: string } | undefined;

      return {
        title: item.title as string,
        price: formatPriceUsd(price),
        price_cents: price?.value
          ? Math.round(parseFloat(price.value) * 100)
          : null,
        link: item.itemWebUrl as string | null,
        image: image?.imageUrl || null,
        source: 'ebay' as const,
        external_id: item.itemId as string,
        condition: (item.condition as string) || null,
        listing_date: (item.itemCreationDate as string) || null,
        location: itemLocation
          ? [itemLocation.city, itemLocation.stateOrProvince]
              .filter(Boolean)
              .join(', ')
          : null,
        seller_name: seller?.username || null,
        description: (item.shortDescription as string) || null,
        raw_data: item as Record<string, unknown>,
      };
    }
  );

  return { items, url: constructedUrl };
}

export function parseEbayItemId(url: string): string {
  // Handles: ebay.com/itm/123456, ebay.com/itm/some-title/123456, etc.
  const match = url.match(/ebay\.com\/itm\/(?:[^/]+\/)?(\d+)/);
  if (!match) throw new Error(`Could not parse eBay item ID from URL: ${url}`);
  return match[1]!;
}

export async function fetchEbayItem(itemId: string): Promise<ScrapedListing> {
  const token = await getOAuthToken();
  const baseUrl = getBaseUrl();

  // eBay Browse API expects the legacy item ID in the format v1|{id}|0
  // Pipes must be URL-encoded as %7C in the path
  const encodedItemId = `v1%7C${itemId}%7C0`;

  const { data: item } = await axios.get(
    `${baseUrl}/buy/browse/v1/item/${encodedItemId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      },
    }
  );

  const price = item.price as PriceObject | undefined;
  const image = item.image as { imageUrl?: string } | undefined;
  const itemLocation = item.itemLocation as {
    city?: string;
    stateOrProvince?: string;
  } | undefined;
  const seller = item.seller as { username?: string } | undefined;

  return {
    title: item.title as string,
    price: formatPriceUsd(price),
    price_cents: price?.value
      ? Math.round(parseFloat(price.value) * 100)
      : null,
    link: item.itemWebUrl as string | null,
    image: image?.imageUrl || null,
    source: 'ebay' as const,
    external_id: item.itemId as string,
    condition: (item.condition as string) || null,
    listing_date: (item.itemCreationDate as string) || null,
    location: itemLocation
      ? [itemLocation.city, itemLocation.stateOrProvince]
          .filter(Boolean)
          .join(', ')
      : null,
    seller_name: seller?.username || null,
    description: (item.shortDescription as string) || (item.description as string) || null,
    raw_data: item as Record<string, unknown>,
  };
}
