import axios from 'axios';
import type { ScrapedListing } from './types.js';

interface CraigslistOptions {
  city?: string;
  lat?: number;
  lon?: number;
  search_distance?: number;
}

interface CraigslistSearchResult {
  items: ScrapedListing[];
  url: string;
}

type RawItem = (string | number | unknown[])[];

export async function searchCraigslist(
  query: string,
  opts: CraigslistOptions = {}
): Promise<CraigslistSearchResult> {
  const city = opts.city || 'denver';
  const lat = opts.lat || 39.6654;
  const lon = opts.lon || -105.1062;
  const search_distance = opts.search_distance || 1000;

  const apiUrl = 'https://sapi.craigslist.org/web/v8/postings/search/full';

  const params = {
    batch: '11-0-360-0-0',
    cc: 'US',
    lang: 'en',
    searchPath: 'pta',
    query,
    lat: String(lat),
    lon: String(lon),
    search_distance: String(search_distance),
  };

  const browseUrl = `https://${city}.craigslist.org/search/${city}-co/pta?query=${encodeURIComponent(query)}&lat=${lat}&lon=${lon}&search_distance=${search_distance}`;

  const { data } = await axios.get(apiUrl, {
    params,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });

  const decode = (data?.data?.decode as Record<string, unknown>) || {};
  const items = (data?.data?.items as RawItem[]) || [];
  const minPostedDate = (decode.minPostedDate as number) || 0;
  const minPostingId = (decode.minPostingId as number) || 0;
  const locations = (decode.locations as unknown[][]) || [];
  const locDescriptions = (decode.locationDescriptions as string[]) || [];
  const neighborhoods = (decode.neighborhoods as string[]) || [];

  const results: ScrapedListing[] = items.slice(0, 100).map((item) => {
    const postingId = minPostingId + (item[0] as number);
    const postedTs = minPostedDate + (item[1] as number);
    const title = item[item.length - 1] as string;
    const priceNum = item[3] as number;
    const locStr = (item[4] as string) || '';

    const locParts = locStr.split('~');
    const areaParts = (locParts[0] || '').split(':');
    const areaIdx = parseInt(areaParts[0] || '0') || 0;
    const area = locations[areaIdx];
    const areaName = (area?.[1] as string) || city;
    const subArea = (area?.[2] as string) || null;
    const neighIdx = parseInt(areaParts[1] || '0') || 0;
    const neighName =
      neighIdx > 0 && neighIdx < neighborhoods.length
        ? neighborhoods[neighIdx]
        : null;

    let linkSlug: string | null = null;
    let imageUrl: string | null = null;
    let priceStr: string | null = null;

    for (const field of item) {
      if (!Array.isArray(field)) continue;

      if (field[0] === 6 && field.length >= 2) {
        linkSlug = field[1] as string;
      } else if (field[0] === 4 && field.length >= 2) {
        const imgId = field[1];
        if (typeof imgId === 'string') {
          const cleanId = imgId.startsWith('3:') ? imgId.slice(2) : imgId;
          imageUrl = `https://images.craigslist.org/${cleanId}_600x450.jpg`;
        }
      } else if (field[0] === 10 && field.length >= 2) {
        priceStr = field[1] as string;
      }
    }

    const urlBase = subArea
      ? `https://${areaName}.craigslist.org/${subArea}/pts/d`
      : `https://${areaName}.craigslist.org/pts/d`;

    const link = linkSlug
      ? `${urlBase}/${linkSlug}/${postingId}.html`
      : null;

    const locationText =
      neighName || locDescriptions[areaIdx] || areaName || null;

    return {
      title,
      price: priceStr || (priceNum ? `$${priceNum}` : null),
      price_cents: priceNum ? priceNum * 100 : null,
      link,
      image: imageUrl,
      source: 'craigslist' as const,
      external_id: String(postingId),
      condition: null,
      listing_date: new Date(postedTs * 1000).toISOString(),
      location: locationText,
      seller_name: null,
      description: null,
      raw_data: {
        posting_id: postingId,
        posted_ts: postedTs,
        raw_item: item,
      },
    };
  });

  return { items: results, url: browseUrl };
}
