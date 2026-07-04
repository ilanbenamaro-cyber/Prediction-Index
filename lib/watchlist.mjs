// lib/watchlist.mjs — watchlist CRUD for the (2c) frontend. CLIENT-SAFE.
//
// Unlike lib/cache.mjs / lib/compute.mjs (SERVER-ONLY: service-role key, never
// import into client code), this module holds NO secrets and constructs NO client.
// Every function takes the caller's ALREADY-AUTHENTICATED supabase-js client (anon
// key + the user's session), so all ops run as the `authenticated` role.
//
// Access control is the Supabase RLS firewall proven in
// scripts/verify-phase2b-isolation.mjs — this module ONLY issues the operations and
// surfaces the DB's decision as typed errors. It NEVER pre-checks permissions (no
// RLS duplication) and NEVER uses the service-role key. A user physically cannot
// touch another user's/org's rows: the DB rejects (42501), the policies filter
// reads/deletes to 0 rows, and `with check` rejects forged owner ids.
//
// Adds are idempotent (upsert/ignore-duplicates). `user_id`/`added_by` are passed
// explicitly = the session user; RLS `with check (… = auth.uid())` still rejects any
// forged id, so the explicit pass is convenience, not the guard.

/** Base error; `code` carries the Postgres SQLSTATE when one applies. */
export class WatchlistError extends Error {
  constructor(message, code) { super(message); this.name = 'WatchlistError'; this.code = code; }
}
/** No active Supabase session on the injected client. */
export class NotAuthenticatedError extends WatchlistError {
  constructor() { super('not authenticated: the supabase client has no active session', 'no_session'); this.name = 'NotAuthenticatedError'; }
}
/** market_id has no row in `markets` (FK 23503) — compute it first, then retry (2c). */
export class MarketNotInCatalogError extends WatchlistError {
  constructor(marketId) {
    super(`market "${marketId}" is not in the catalog yet — compute it first (GET /api/market?id=${encodeURIComponent(marketId)}) then retry`, '23503');
    this.name = 'MarketNotInCatalogError'; this.marketId = marketId;
  }
}
/** RLS rejected the write (42501): not the owner / not an org member. */
export class NotPermittedError extends WatchlistError {
  constructor(message = 'operation not permitted (RLS)') { super(message, '42501'); this.name = 'NotPermittedError'; }
}

/** Map a supabase/PostgREST error to a typed WatchlistError and throw it. */
function throwMapped(error, ctx = {}) {
  if (error.code === '23503') throw new MarketNotInCatalogError(ctx.marketId);
  if (error.code === '42501') throw new NotPermittedError();
  throw new WatchlistError(error.message, error.code);
}

/** Resolve the signed-in user's id, VERIFIED against the Supabase Auth server.
 *  Uses getUser() (a live token-verification call), NOT getSession() — getSession only reads the
 *  cookie and trusts it unverified, which (a) Supabase warns is insecure and (b) is a real gap here:
 *  the returned uid both gates auth (NotAuthenticatedError below) and becomes the user_id/added_by on
 *  the write, so it must be a cryptographically-verified identity, not a cookie value. Fails CLOSED —
 *  any error or missing user (invalid/expired token, or the auth server unreachable) → not
 *  authenticated (at least as strict as before). The RLS `with check (… = auth.uid())` is still the
 *  ultimate DB-level guard; this makes the pre-RLS identity honest too. */
async function currentUid(sb) {
  const { data, error } = await sb.auth.getUser();
  if (error || !data?.user) throw new NotAuthenticatedError();
  return data.user.id;
}

/** Add a market to the caller's PERSONAL watchlist (idempotent). */
export async function addPersonal(sb, marketId) {
  const uid = await currentUid(sb);
  const { error } = await sb.from('personal_watchlist')
    .upsert({ user_id: uid, market_id: marketId }, { onConflict: 'user_id,market_id', ignoreDuplicates: true });
  if (error) throwMapped(error, { marketId });
}

/** Remove a market from the caller's PERSONAL watchlist. Returns { removed }. */
export async function removePersonal(sb, marketId) {
  const uid = await currentUid(sb);
  const { data, error } = await sb.from('personal_watchlist')
    .delete().eq('user_id', uid).eq('market_id', marketId).select();
  if (error) throwMapped(error, { marketId });
  return { removed: data?.length ?? 0 };
}

/** Add a market to an ORG's shared watchlist (idempotent), attributing added_by=self. */
export async function addOrg(sb, orgId, marketId) {
  const uid = await currentUid(sb);
  const { error } = await sb.from('org_watchlist')
    .upsert({ org_id: orgId, market_id: marketId, added_by: uid }, { onConflict: 'org_id,market_id', ignoreDuplicates: true });
  if (error) throwMapped(error, { marketId });
}

/** Remove a market from an ORG's shared watchlist. Returns { removed }. */
export async function removeOrg(sb, orgId, marketId) {
  await currentUid(sb); // require an authenticated session
  const { data, error } = await sb.from('org_watchlist')
    .delete().eq('org_id', orgId).eq('market_id', marketId).select();
  if (error) throwMapped(error, { marketId });
  return { removed: data?.length ?? 0 };
}

/** List every market the caller can see = personal ∪ their orgs' shared lists.
 *  Rows: { scope: 'personal'|'org', org_id, market_id, created_at } (RLS-scoped
 *  via the security_invoker my_visible_watchlist view). */
export async function listVisible(sb) {
  const { data, error } = await sb.from('my_visible_watchlist')
    .select('scope, org_id, market_id, created_at');
  if (error) throwMapped(error);
  return data ?? [];
}
