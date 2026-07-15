// app/api/search/route.ts — Zone 3 search: proxy Polymarket's public gamma search
// server-side. Why a proxy (not a direct browser→gamma fetch): avoids browser CORS
// fragility, keeps the gamma URL/response shape out of the client, and normalizes the
// heavy event payload down to the few fields the overlay needs. Read-only, public data,
// no secrets, no auth — but it IS behind the app's middleware like every other route.
import { marketShapeFromMarkets } from '@/core/fetch.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GAMMA_SEARCH = 'https://gamma-api.polymarket.com/public-search';
const MIN_Q = 2;
const LIMIT = 8;

interface GammaTag { label?: string; forceShow?: boolean }
interface GammaEvent {
  slug?: string;
  title?: string;
  closed?: boolean;
  active?: boolean;
  volume?: number;
  markets?: Array<{ question?: string }>;
  tags?: GammaTag[];
}
export type MarketType = 'binary' | 'survival' | 'bucket_pmf' | 'directional_touch' | 'categorical' | 'unsupported';
export interface SearchResult {
  slug: string;
  title: string;
  closed: boolean;
  active: boolean;
  volume: number | null;
  type: MarketType | null; // classified server-side from markets[] (Enh 5 — distinguish before add)
  category: string | null; // first forceShow tag label (e.g. "Bitcoin")
}

/** Fine market shape from the search payload's markets[], or null if unclassifiable.
 *  Reuses the SAME classifier the compute pipeline routes on — no drift. */
function classify(markets: Array<{ question?: string }> | undefined): MarketType | null {
  if (!Array.isArray(markets) || markets.length === 0) return null;
  try {
    return marketShapeFromMarkets(markets) as MarketType;
  } catch {
    return null; // a leg with no parseable question etc. — don't guess
  }
}

/** First operator-promoted tag label, the result's category chip. */
function category(tags: GammaTag[] | undefined): string | null {
  const t = (tags ?? []).find((x) => x.forceShow && x.label) ?? (tags ?? [])[0];
  return t?.label ?? null;
}

export async function GET(req: Request): Promise<Response> {
  const q = (new URL(req.url).searchParams.get('q') ?? '').trim();
  if (q.length < MIN_Q) return json({ results: [] });

  let events: GammaEvent[] = [];
  try {
    const res = await fetch(`${GAMMA_SEARCH}?q=${encodeURIComponent(q)}&limit_per_type=${LIMIT}`, {
      signal: AbortSignal.timeout(6000),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return json({ results: [], error: `gamma ${res.status}` }, 502);
    const data: unknown = await res.json();
    const ev = (data as { events?: unknown })?.events;
    events = Array.isArray(ev) ? (ev as GammaEvent[]) : [];
  } catch {
    // upstream timeout / network — surface, don't pretend success
    return json({ results: [], error: 'search upstream unavailable' }, 502);
  }

  const results: SearchResult[] = events
    .map((e) => ({
      slug: e.slug ?? '',
      title: e.title ?? '',
      closed: !!e.closed,
      active: !!e.active,
      volume: typeof e.volume === 'number' ? e.volume : null,
      type: classify(e.markets),
      category: category(e.tags),
    }))
    .filter((r) => r.slug && r.title)
    .slice(0, LIMIT);

  return json({ results });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
