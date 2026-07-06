'use server';
// app/(app)/actions.ts — Zone 3 mutations: the compute-then-add flow + remove.
//
// Server actions run server-side with the right identity for each step: the COMPUTE
// uses the service-role DEPS (writeRecord — never exposed to the client); the ADD/REMOVE
// use the cookie-bound user client so RLS is the guard (lib/watchlist surfaces the DB's
// decision as typed errors). After a mutation, revalidatePath('/', 'layout') re-renders
// the LAYOUT segment — where the watchlist rail (a Server Component) lives — so the new
// or removed market appears without a full reload or a client-state layer.
import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { headers } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { serveMarket, MARKET_ID_RE } from '@/lib/serve-market.mjs';
import { DEPS } from '@/lib/market-deps.mjs';
import { readCache, writeRecord } from '@/lib/cache.mjs';
import { computeMarketRecord } from '@/lib/compute.mjs';
import { addPersonal, addOrg, removePersonal, removeOrg, MarketNotInCatalogError } from '@/lib/watchlist.mjs';
import { readBackfillStatus, needsBackfill } from '@/lib/market-history.mjs';
import { triggerBackfill } from '@/lib/trigger-backfill.mjs';

export interface ActionResult {
  ok: boolean;
  slug?: string;
  error?: string;
}

const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/**
 * Compute-then-add. The ordering is load-bearing: serveMarket() runs the verified
 * pipeline which, on a miss/recompute, populates `markets` (+ `market_snapshots`) via
 * writeRecord — so the watchlist FK is satisfied when the add runs. orgId null = personal.
 */
export async function addMarket(slug: string, orgId: string | null): Promise<ActionResult> {
  const id = (slug ?? '').trim();
  if (!id) return { ok: false, error: 'no market selected' };

  // 1. compute (catalog side-effect). Non-200 = not a usable ladder / upstream / etc.
  const { status, body } = (await serveMarket({ id, deps: DEPS })) as { status: number; body: { error?: string } };
  if (status !== 200) {
    const why = status === 404 ? 'not a supported threshold-ladder market' : (body?.error ?? `compute failed (${status})`);
    return { ok: false, error: why };
  }

  // 2. add as the signed-in user (RLS enforces). Idempotent.
  const supabase = await createClient();
  try {
    if (orgId) await addOrg(supabase, orgId, id);
    else await addPersonal(supabase, id);
  } catch (e) {
    // With compute sequenced first this should NOT fire — if it does, it's a real
    // inconsistency, not the happy path. Surface it; never swallow.
    if (e instanceof MarketNotInCatalogError) {
      return { ok: false, error: 'computed, but the catalog row is missing — please retry' };
    }
    return { ok: false, error: msg(e, 'could not add to watchlist') };
  }

  revalidatePath('/', 'layout'); // rail (layout-level Server Component) re-renders

  // 3. Backfill market_history from CLOB price history — fire-and-forget AFTER the response
  // flushes (the user already sees the market). The dedicated /api/backfill route ACKs 202 and
  // owns the (minutes-long) rebuild in its own budget, so this trigger returns fast.
  //
  // UPGRADE PATH (browse → Add): since the browse-history change, viewing a market already
  // triggers its backfill, so a browsed-then-added market is usually already 'done'/'pending' by
  // the time it's added. Gate on needsBackfill so we DON'T re-fetch (and don't duplicate rows) in
  // that case — the browse data is reused as-is. A FRESH market never viewed (status null) still
  // triggers here, so "add a fresh market" is unchanged; a 'failed' status re-fires (self-heal).
  const bfStatus = await readBackfillStatus(id).catch(() => null);
  if (needsBackfill(bfStatus)) {
    // Capture the request host/proto NOW (request scope), not inside the after() callback: Next 15
    // does allow headers() inside after() for a Server Function, but reading request data before the
    // deferred callback is the documented-robust pattern (and lets triggerBackfill be unit-tested
    // without a request context). See https://nextjs.org/docs/app/api-reference/functions/after.
    const h = await headers();
    const host = h.get('host');
    const proto = h.get('x-forwarded-proto') ?? (host?.startsWith('localhost') ? 'http' : 'https');
    after(() => triggerBackfill(id, host, proto));
  }
  return { ok: true, slug: id };
}

/** Remove a market from the rail. orgId null = personal; otherwise the org's shared list. */
export async function removeMarket(marketId: string, orgId: string | null): Promise<ActionResult> {
  const id = (marketId ?? '').trim();
  if (!id) return { ok: false, error: 'no market specified' };

  const supabase = await createClient();
  try {
    if (orgId) await removeOrg(supabase, orgId, id);
    else await removePersonal(supabase, id);
  } catch (e) {
    return { ok: false, error: msg(e, 'could not remove from watchlist') };
  }

  revalidatePath('/', 'layout');
  return { ok: true, slug: id };
}

/**
 * Force a FRESH compute for one market, bypassing the cache TTL. computeMarketRecord
 * always re-fetches (it doesn't consult the TTL — that's serveMarket's job), so calling
 * it directly + writeRecord stores a new snapshot with as-of = now. revalidatePath('/',
 * 'page') re-renders ONLY the detail page segment — NOT the layout — so the rail is not
 * re-fetched (per the scope-the-revalidation constraint).
 *
 * Verifies the caller the same way lib/watchlist.mjs's currentUid does (a live
 * getUser() token check, fail-closed) BEFORE any work — this action has no RLS to fall
 * back on (it calls computeMarketRecord/writeRecord directly, not through addPersonal/
 * addOrg), so the auth check has to live here.
 */
export async function refreshMarket(slug: string): Promise<ActionResult> {
  const id = (slug ?? '').trim();
  if (!id) return { ok: false, error: 'no market selected' };
  if (!MARKET_ID_RE.test(id)) return { ok: false, error: 'invalid market id' };

  const supabase = await createClient();
  const { data, error: authError } = await supabase.auth.getUser();
  if (authError || !data?.user) return { ok: false, error: 'not authenticated' };

  try {
    const { snapshot } = await readCache(id); // prior, for the RESOLVED freeze path
    const prior = snapshot?.record ?? null;
    const { record, lifecycle, config } = await computeMarketRecord({ id, prior });
    await writeRecord(id, record, lifecycle, config);
  } catch (e) {
    return { ok: false, error: msg(e, 'could not refresh market') };
  }
  revalidatePath('/', 'page'); // detail only — rail (layout) untouched
  return { ok: true, slug: id };
}
