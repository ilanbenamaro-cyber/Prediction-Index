// lib/market-deps.mjs — the SINGLE wiring of I/O deps for the authoritative
// serveMarket() path. Extracted so every caller of the verified serve (the
// /api/market route handler AND the 2c.3 detail Server Component) injects the
// EXACT same implementations — no duplicated-and-drifted DEPS object. serveMarket
// stays pure of I/O; this is the one place the real cache + Polymarket + compute
// implementations are bound. SERVER-ONLY (pulls lib/cache.mjs's service-role client).
import { readCache, writeRecord, touchProbe } from './cache.mjs';
import { computeMarketRecord, probeLifecycle } from './compute.mjs';
import { writeTransitionHistory } from './market-history.mjs';

export const DEPS = {
  readCache, writeRecord, touchProbe, computeMarketRecord, probeLifecycle, writeTransitionHistory,
};
