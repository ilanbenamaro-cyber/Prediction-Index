# Architectural decisions — the "why"

Durable record of decisions and what each one constrains. One entry per decision.
Newest at top. If you're about to change one of these, read the entry first.

---

## LEDGER design system — rules not cards, text not badges, signal not decoration
**Decided (2026-07-07, operator-approved proposal then implemented):** the product's visual language
moved from rounded-card/pill-badge "SaaS dashboard" to an institutional-terminal system. Display-only:
no data, derivation, or chart-architecture change (458/458, parity 4/4, 0 console errors on all 5
market types, production build). The durable rules a future UI change must respect:
- **The split signal bar is the signature element** — 3px, RELIABILITY top half / LIQUIDITY bottom
  half, tier-coloured, on every rail row and every detail headline band. It is rendered as an
  absolutely-positioned `::before` with a two-stop `linear-gradient`, driven by the `--sig-rel`/
  `--sig-liq` custom props (rail rows set them inline; detail views via the shared
  `signalBarStyle()` in `ConfidenceBasis.tsx`). **Never border-left** — a border enters the box
  model and shifts the flex layout. STALE fades the bar to 40% (aged data = attenuated signal);
  RESOLVED sets both segments `--text-faint` (no live signal). A single-colour bar was explicitly
  rejected: it would visually re-collapse the reliability/liquidity split (migration 0010).
- **Colour = meaning, strictly:** signal tiers are `--c-high #4cc38a` / `--c-med = --accent-amber
  #d08a3e` (ONE amber) / `--c-low #e5484d`; **blue (`--accent-blue`) means interactive/link/OPEN and
  is banned from data values** (hero numbers are `--text`); **`--tier1` teal is a chart data series
  only** (the median line), never a UI tag colour.
- **0 border-radius everywhere** — `--radius`/`--radius-sm` resolve to 0 but the VARS STAY (dozens
  of consumers incl. the auth pages); never reintroduce a literal radius on a surface/chip/button.
  Circle dots (50%) are geometry, not decoration, and keep literal values.
- **Typography:** Archivo (next/font/google, `--font-archivo` → `--font-sans`) for market titles +
  narrative prose ONLY; IBM Plex Mono is the dominant voice — every numeric value, label, table,
  axis, and piece of chrome. Numbers inline in narrative sentences deliberately stay in the prose
  font (a mid-sentence font switch reads ransom-note). Both fonts load via next/font — never a CDN
  `<link>` (don't mix mechanisms).
- **Sections are hairline-ruled ledgers, not cards:** `.detail-section` carries `border-top`; every
  metric grid is ONE bordered **field strip** whose cells divide by collapsed hairlines (the -1px
  margin technique in `.detail-analytics`/`.acard`) — never per-cell background/border. The
  threshold table sits flush (2px header rule). Trust/basis reasons are glyph-marked TEXT lines
  (✓ green / ✗ red / · muted caveat — FIX 3 semantics preserved per-reason), not pill chips.
- **Charts render ~2.4x their 480 viewBox** — stroke widths and font sizes in chart CSS/constants
  are calibrated for that scale (series 1.1 / median 1.6, axis 7px, ticks 6px, grid 0.10 opacity,
  categorical rowH 17). Any new chart must account for the multiplier or it draws cartoon-weight.
  Geometry stayed untouched (`touch-rangebar.mjs` / `chart-hover.mjs` are test-locked).
- **Render order rule re-affirmed:** every detail view is headline → TRUST band → content sections.
  The touch view violated this (trust below the barrier-range chart) and was fixed (`99028ec`) —
  don't re-bury the trust band under a full-height section in any future view.
**Constrains:** the rail's confidence dots, volume-tint gradient, and pill classes are GONE — the
signal bar + plain text carry that information; rail rows keep `data-reliability`/`data-liquidity`
attrs for audits. One lifted clock in `WatchlistRows` drives both freshness text and bar fade.
Merged `--no-ff` `e9badfd` (branch `feat/ui-design-overhaul`, 10 commits), pushed.

## Hard-stop resolutions: monoScore carve-out, LOW-tier window naming, PM TERMINAL → PREDICTION INDEX
**Decided (2026-07-07):** the four HARD-STOP items carried from the perfection pass (H1-H4) are
resolved — 3 code fixes + 1 documented deferral, each individually test-gated.
- **H1 — `core/confidence.js` monoScore honors R2's own immateriality carve-out.** R2's TIER logic
  already treats a sub-`MATERIAL_ADJUSTMENT` (0.5%) isotonic tweak as immaterial noise (tier stays
  'high' regardless of `rawViolations` count), but the SCORE formula penalized the same adjustment's
  magnitude/count unconditionally — a tier=high market could carry an unexplained, violations-
  penalized reliability score (as low as ~0.6-0.8) with no reason string accounting for the gap.
  `monoScore` now short-circuits to 1 (pre-adjustment) whenever `maxAdjustment < MATERIAL_ADJUSTMENT`,
  mirroring R2's branch exactly. **Threshold value and tier logic untouched — only the score
  formula's guard changed.** SpaceX unaffected: `rawViolations===0` there (confirmed via its
  reliability reasons being the empty-list fallback, not a violation-count reason) so
  `maxAdjustment===0` too — old formula `(1-0/4)*(1-0/0.1)=1` and the new guard
  `maxAdjustment<0.005→1` agree; Gate 2's byte-identical deep-equal confirms this structurally.
- **H2 — `windowedVolumeSignal`'s LOW-tier reason names the qualifying window.** The MEDIUM-tier fix
  (`250e4af`) named whichever window ACTUALLY crossed its threshold instead of whichever field was
  merely present — but that commit's own message explicitly left LOW "already self-consistent,
  untouched." It wasn't: LOW still named by presence (`v24 != null ? '24h' : '7d'`), so a
  present-but-exactly-zero 24h figure beside a real (if sub-threshold) 7d number reported the
  misleading "thin 24h volume ($0)" instead of the more representative week-long figure. **The MEDIUM
  pattern (checking which window crosses ITS OWN threshold) can't apply verbatim to LOW — by
  definition nothing crosses a threshold there** (that's what makes it LOW); the closest faithful
  analog implemented: prefer 24h only when it's genuinely informative (present AND nonzero), else
  fall back to 7d when present, else 24h. This preserves the pre-existing US-recession regression
  case (`v24=$478`, real nonzero → still reports 24h) while fixing the actual misleading-zero case.
  No threshold or tier logic touched; reason strings aren't in the raw_inputs hash path, and SpaceX
  carries no windowed liquidity data at all (resolved markets omit it) → parity unaffected either way.
- **H3 — DEFERRED, documented only.** `core/touch-record.js boundLabel` hardcodes `$` in both its
  finite-value and out-of-range branches; a %-unit touch market would render `"$5%"`-style labels.
  No live %-unit touch market currently exists → zero current impact. A TODO comment at the exact
  line + a gotchas.md entry ("touch-record boundLabel hardcodes $…") record the deferral; fix when
  the percent-bucket pattern (`unit_prefix`-aware formatting) is ported to this builder.
- **H4 — brand string normalized.** `components/zones/CommandBar.tsx`'s header still read
  "PM TERMINAL" (split `<span className="num">PM</span> TERMINAL`) after the Prediction-Index
  rebrand — every other surface (login/signup pages, `app/layout.tsx` metadata, loading/backfill
  copy) already used "Prediction Index". Matched the EXACT `<span className="num">PREDICTION
  INDEX</span>` pattern the login/signup pages had already established (one unsplit accent span),
  rather than inventing a new split — the 2-letter-ticker + wordmark pattern ("PM"+"TERMINAL")
  doesn't carry over cleanly to the longer brand name. Browser-verified 0 console errors.
**Constrains:** any future confidence-score change must re-check whether R2's tier branches and the
score formula still agree (the H1 class of bug — a tier carve-out with no matching score carve-out).
Any future window-naming logic added to a NEW confidence signal should default to "prefer the
informative/present window, not merely the first-checked field" from the start. **458/458 (+4 over
the 454 baseline: 2 from H1, 2 from H2); parity 4/4 byte-identical unaffected by any of the four.**
Merged to main (`--no-ff` `b805f17`; branch `fix/hardstops-h1h2h3h4`), pushed.

## Touch strikes dedup to the CURRENT BOARD — tradeable wins, else latest closedTime
**Decided (2026-07-06):** one gamma touch event can carry duplicate (side, level) legs with
contradictory settlements — a leg that touches settles Yes EARLY (closedTime = touch date) and the
board re-lists a fresh strike at the same level measuring from its re-listing (observed live on
`si-hit-jun-2026`: "hit (HIGH) $110" both Yes-in-January and No-at-window-end). Ingesting every leg
produced duplicate table rows live and a self-contradictory settlement narrative on the
resolved-no-prior path. **Rule:** `core/fetch.js dedupTouchLegs` (pure, unit-tested) keeps ONE leg per
(side, level): a still-tradeable leg wins; among closed legs the latest `closedTime` wins; ties go to
later gamma order. Applied inside `fetchTouchMeta`, so live pricing, the lifecycle probe, backfill
reconstruction, and `buildMinimalResolvedRecord` all inherit it.
**Why "current board":** the re-listed strike is what Polymarket's own UI presents as the market's
final state; mixing observation windows asserts contradictions no user can act on. The superseded
strike's early-touch information is genuinely lost from our record — accepted (we report the board,
not a synthesized union). **Constrains:** raw_inputs for a dup-carrying touch market now exclude
superseded strikes (fewer rows, different hash than a pre-fix compute — correct, it's different
observed data). History rows backfilled BEFORE the fix carry the dups — purge + re-backfill per
market (si-hit rebuilt 2026-07-06). SpaceX is survival → parity untouched. `closed_time` is parsed
per-leg in fetchTouchMeta, additive.

## Cron snapshot_hour "15/19 vs documented 2/18" — NOT a bug; the dev DB has no cron
**Decided/diagnosed (2026-07-06, closes the carried open item):** `vercel.json` correctly schedules
`/api/snapshot` at `0 2 * * *` + `0 18 * * *`, and the route stamps `snapshot_hour` via
`new Date(startedAt).getUTCHours()` — both verified correct. The observed 15/19 rows came from the
DEV database (`.env.local` → dxoyxjxc…), where there IS no Vercel cron: every `source='cron'` row
there is a MANUAL bearer-invoked run fired during work sessions (~11am/3pm ET → 15/19 UTC). The
h0-cron rows predate migration 0009's hour stamping. **Constrains:** never "fix" vercel.json or the
hour stamping off dev-DB observations; the real check — prod `market_history` rows landing at hours
2/18 — is an OPERATOR item (prod creds are not in the dev env). `prefersCapture` is hour-agnostic
either way, so nothing breaks regardless.

## Serve/display hardening decisions (perfection pass, 2026-07-06)
One entry for the smaller settled rules from the audit pass; each is enforced by tests:
- **An unknown/delisted slug is 404, not 502** (`statusFor`): "Gamma API returned no events" means
  the market doesn't exist at the source — "not found", not "upstream failure". Real upstream errors
  (429/503/network, explicit `→ NNN`) stay 502.
- **Market ids are format-validated at the trust boundary** (`MARKET_ID_RE` in serve-market.mjs,
  applied in `serveMarket` + `refreshMarket`): rejects query-injection characters before the slug
  reaches the gamma URL; `refreshMarket` also now verifies the caller via `getUser()` fail-closed
  (it writes via service-role directly, so it cannot lean on RLS).
- **A RESOLVED market never speaks in live-market voice**: the four narrative builders take a
  `resolvedLabel` and swap to a settlement-first sentence (dropping tradability/consensus clauses);
  touch + categorical views gained the RESOLVED banner the other views had; the days-to-expiry
  subtitle segment is suppressed once resolved. All display-side — stored narratives untouched.
- **The post-jump velocity window is clipped to its label** (`deriveVelocity`): slope window =
  `max(jump day, last 7d)`, so the "7d" card never regresses over up to 21 post-jump days.
- **Display normalization beats stored history**: `platformLabel()` renders 'prediction index' for
  records frozen before the rebrand; `titleFromSlug` strips gamma's trailing 13+-digit uniquifiers;
  binary NO% complements YES only when the quotes are consistent (a real overround stays visible);
  basis chips mark `moderate …`/`market resolved …` reasons as caveats (·), never failures (✗).

## Resolved-no-prior 409 fix EXTENDED to all 5 shapes — survival/bucket_pmf/directional_touch/categorical
**Decided (2026-07-06):** the binary-only fix below (see the immediately-following entry) is now extended
to the 4 remaining shapes. **This SUPERSEDES that entry's "Constrains: BINARY-ONLY" line** — every shape
now builds a minimal record from settled `outcomePrices` instead of 409ing on RESOLVED+no-prior.
- **`buildMinimalResolvedRecord` is now a SHAPE-DISPATCHING function** — `buildMinimalResolvedRecord(shape,
  meta, id, lifecycle?)` — called uniformly from `computeMarketRecord`'s survival branch plus
  `computeBucketPmfRecord`/`computeTouchRecord`/`computeCategoricalRecord`'s RESOLVED-no-prior branches.
  `CLOSED_PENDING`-no-prior still 409s everywhere (no settled outcome exists to build from — genuinely
  no data, not a gap).
- **The reuse pattern (the load-bearing design choice):** each shape constructs a `live`-shaped object
  from the settled prices — the SAME shape each shape's own `fetchXSnapshot` produces — then feeds it
  through the SAME builder the OPEN path already uses (`buildSnapshotRecord`/`buildTouchRecord`/
  `buildCategoricalRecord`). This is the EXACT pattern `lib/backfill-record.mjs` already uses (a
  `live`-shaped object built from CLOB price HISTORY, not live quotes, fed through the same core
  builders) — so isotonic adjustment, quantile crossings, de-vig, and entropy are REUSED, not
  re-derived by hand. Bucket_pmf specifically reuses `core/bucket.js buildPmfLadder` fed `{lo,hi,prob}`
  with the settled 0/1 in place of a live PMF — de-vig is then a no-op (exactly one leg is 1).
- **A shared `resolvedConfidence()`** (reliability high / liquidity low, valid enum tiers) replaces every
  shape's live-scored confidence post-hoc — the live scorer would otherwise emit a misleading "tight
  spread"/"deep book" default reason for a market with no live book at all.
- **A single unparseable leg is DROPPED, never fabricated.** When EVERY leg of a non-binary shape is
  unparseable, the record genuinely cannot be built — `raw_inputs` has a SCHEMA-WIDE `minItems:1`
  (independent of `kind`; see [[gotchas]] "raw_inputs minItems:1 is schema-wide…") — so that remains an
  honest 409, never a faked record. (Binary never hits this: it always emits exactly 2 raw_inputs rows,
  YES+NO, with a `'0'` fallback midpoint.)
- **Diagnostic finding (flagged, NOT fixed — out of scope):** the reported Bitcoin market
  (`what-price-will-bitcoin-hit-june-29-july-5-2026`) classifies as **`survival`** via the existing
  `classifyMarketShape`/`ladderShapeFromMarkets`, but is ACTUALLY a two-sided "reach $X / dip to $X"
  structure — the classifier's `TOUCH_RE` only recognizes WTI/Silver's literal `"(HIGH)"/"(LOW)"` wording,
  not this market's phrasing, so it falls through to the generic `$`-threshold `'survival'` branch. Its
  settled per-rung outcomes are genuinely NON-MONOTONIC as a one-directional ladder (Yes at $58/$62
  sandwiched among No at 46–56 and 64–74) — the SAME isotonic-adjustment step already trusted for noisy
  LIVE quotes handles this without a crash (never new/invented math), but a naive settlement-range label
  ("lastYes"–"firstNo") would read BACKWARDS ("settled in $62–$46") for this pathological case; a new
  `ladderSettlementLabel` detects the inversion and falls back to an honest non-specific statement instead
  of asserting a wrong-looking range. **The UI's OWN `MarketDetailView.resolvedBand` has the identical
  un-fixed backwards-label bug** (it's independent of `derived.narrative`, computed straight from
  `lifecycle.resolved_outcome` in the view) — this session did NOT touch that UI code; it's flagged here
  for whoever eventually fixes the classifier or the view.
**Constrains:** never fix the classifier gap or the UI's `resolvedBand` bug as a side-effect of an
unrelated change — either is a real, separately-scoped fix (the classifier touches `classifyMarketShape`,
used everywhere including the OPEN path, and needs its own parity/regression pass). NEVER invent a `tier`
outside the enum, in ANY new minimal-record builder. SpaceX has a prior → never hits any of these paths →
**parity 4/4 byte-identical.** 21 new tests (3-6 per shape). Additive: only the 4 shapes' RESOLVED-no-prior
branches + `computeMarketRecord`'s survival branch changed.

## Resolved markets with NO prior now build a minimal record from settled outcomePrices (binary) — 409 removed
**Decided (2026-07-06):** browsing a RESOLVED market the product never captured while OPEN threw a 409
("no prior record to freeze") from `computeBinaryRecord`. That was OUR gap, not a Polymarket limitation:
gamma DOES serve resolved markets (`closed:true` + `umaResolutionStatus:'resolved'` + settled
`outcomePrices`). **This SUPERSEDES the "just 409 — don't fake a record" stance in the entry below (its
3rd bullet) FOR BINARY markets** — because the settled `outcomePrices` (YES/NO → "1"/"0") ARE the FINAL
prices, real observed data, so the record is reconstructed honestly, not faked.
- **`lib/compute.mjs buildMinimalResolvedRecord(meta, id, lifecycle?)`** builds a valid `kind:'binary'`
  record from the settled prices: `probability` = the YES settle, a REAL re-verifiable `raw_sha256` over the
  **UNCHANGED** `canonicalizeRawInputs` recipe (threshold 1=YES / 0=NO, mirroring the live binary fetcher;
  `midpoint_source:'resolved_settlement'` stays OUT of the canonicalizer so the frozen hash recipe is
  byte-stable), `freshness.final`, and `snapshot.lifecycle.resolved_outcome` (from the existing
  `classifyLifecycle` — the outcome whose price settled to 1). It reuses `buildBinaryRecord` for a
  schema-correct skeleton, then overrides confidence + narrative.
- **Confidence uses VALID enum tiers, NOT a literal `'RESOLVED'` tier.** The schema locks
  `confidence.*.tier` to `enum:["high","medium","low"]` (see [[gotchas]] "A 'minimal' resolved record…"),
  so the naive `tier:'RESOLVED'` FAILS `validateRecord`. The settled-honest choice: reliability **high**
  (the outcome is FINAL, not an estimate) + liquidity **low** (you can no longer transact) — set explicitly,
  not via the live scorer (which would report a misleading "tight spread" on a market with no book).
- **The record caches** (`writeRecord` → `market_snapshots` RESOLVED/`is_final`), so future browses
  `SERVE_FINAL` from cache; the browse-history backfill trigger populates the trend chart. Browser-verified
  on `net-quarterly-earnings-nongaap-eps-02-11-2026-0pt27` (Cloudflare NET, resolved YES): loads with the
  RESOLVED banner + 100% + "final", absent from the rail, cached, history backfilled, 0 app console errors.
**Constrains:** [SUPERSEDED by the entry above — no longer BINARY-ONLY] it's the reported shape AND the only
kind whose schema branch permits a truly minimal derived block (`{kind, probability, confidence,
total_volume, freshness}`). `CLOSED_PENDING`-no-prior still 409s (trading ended, UMA unconfirmed → no
settled outcome to build from). NEVER invent a `tier` outside the enum. SpaceX has a prior → never hits this
path → **parity 4/4 byte-identical.**

## Resolved markets are NOT searchable (gamma limitation) but browse fine by direct URL — INTENTIONAL, no code change
**[UPDATED 2026-07-06 — the 3rd bullet's "just 409 / don't fake a record" is SUPERSEDED FOR BINARY by the
entry above: a resolved BINARY market with no prior now builds a real record from settled outcomePrices. The
search limitation (bullet 1) + cached-browse behavior (bullet 2) still hold; the 409 now only applies to
CLOSED_PENDING and to non-binary resolved-no-prior markets.]**
**Decided (2026-07-06):** investigating "let me search for and view a RESOLVED market that isn't in my
watchlist" — the diagnosis is **Case A, a Polymarket gamma limitation, not a product bug.**
- **Search returns only ACTIVE markets.** `app/api/search/route.ts` proxies gamma `public-search`, and that
  endpoint returns only `closed:false active:true` events (verified live: `?q=spacex` returns 8 events, all
  active; the resolved `spacex-ipo-closing-market-cap-above` is absent). Our route does NOT filter on
  closed/active — it passes them through, and `MarketSearch.tsx` would even render a `state-resolved` dot if
  gamma returned one. So there is nothing to "fix" in our code: gamma simply doesn't surface resolved events.
- **A resolved market DOES load by direct `?m=<slug>` URL — regardless of watchlist status.** `serveMarket`
  has ZERO watchlist dependency (it reads the cache by single id; the `.in('market_id', ids)` firewall is on
  the RAIL scan read, not the detail serve). A cached RESOLVED record → `decideBeforeProbe` → `SERVE_FINAL`
  (monotonic, no probe, 0 Polymarket calls) → 200, and the detail renders the RESOLVED state cards (settlement
  outcome, final median, "final · no further updates"), NOT live P(>X). Browser-verified on SpaceX (watchlisted
  resolved): RESOLVED banner "settled in $2–2.2T", 0 console errors. Watchlist status only affects (a) rail
  membership and (b) the browse-history backfill trigger, which for a resolved market is a fire-and-forget,
  failure-tolerant CLOB-history reconstruction — never blocks the serve.
- **A resolved market the system NEVER cached while OPEN cannot be served — clean 409, not a crash.**
  `computeMarketRecord` on a non-OPEN market with `prior=null` throws `code 409` ("is RESOLVED with no prior
  record to freeze"); `statusFor` maps it to 409 (verified by driving the real path with the resolved SpaceX
  slug + `prior:null`). This is honest: a resolved market exposes NO live CLOB midpoints (see [[gotchas]] "A
  RESOLVED Polymarket market returns NO CLOB midpoints"), so there is genuinely no data to build a fresh record
  from — freezing REQUIRES a prior OPEN capture. It is unreachable via search (Case A) and only hit by manually
  typing a URL for a market the product never saw. Reconstructing such a record from CLOB price HISTORY (the
  backfill path) is possible in principle but is a feature, not a bug fix — deferred.
**Constrains:** don't add a "hide closed" filter to the search route (it already shows nothing resolved, and a
future gamma that DID return them should display them with the resolved dot the client already has). Don't try
to "serve" a never-captured resolved market by faking a record — the 409 is the correct honest failure. If
resolved-market discovery is ever wanted, it needs a different source than gamma `public-search` (a resolved-
markets index) + the backfill-from-history reconstruction, not a change to the serve path.

## Browse markets load history via a DERIVED model — no `scope` column, no migration
**Decided (2026-07-03):** any VIEWED market (search/⌘K/direct `?m=` URL) now reconstructs its full
CLOB history, not just watchlisted ones — while the rail stays watchlist-only and the cron never
snapshots browse markets. The framing assumed this needed a `markets.scope` column (browse/personal/
org, migration 0012); it does NOT. "Browse" = **served-but-not-watchlisted**, entirely derived:
- **The FK target already exists on browse.** `lib/cache.mjs writeRecord` upserts the `markets` row
  (`onConflict:'id'`) on EVERY serve, so `market_history.market_id → markets.id` is satisfied without
  any special creation path.
- **Cron scope is watchlist-governed, not markets-governed.** `allWatchedMarketIds()` reads
  `personal_watchlist ∪ org_watchlist` (NOT `markets`), and `marketsNeedingBackfill(ids)` is bounded
  by that set — so a browse market can never enter the snapshot batch (verified: browsed ids return
  `false` from `allWatchedMarketIds`, count unchanged). This is the hard bounded-growth invariant.
- **Rail is watchlist-governed** (`readScan ← listVisible ← my_visible_watchlist`) → browse markets
  never appear. **No view over `markets`** → no view refresh needed even if a column were added.
**What actually changed (all display/orchestration, no schema, no `core/`):** `DetailData`
(MarketDetailView) fires the SAME fire-and-forget backfill trigger `addMarket` uses, gated on
`needsBackfill(status)` (null/'failed'), via `after(() => triggerBackfill(...))` — **`after()` in a
Server Component works** (verified: 222 rows written on a browse). The trigger was extracted to a
shared `lib/trigger-backfill.mjs` (used by both the add + browse paths). The `TrendHistory` "watched"
gate on the "Backfilling…" display was REMOVED (obsolete — every viewed market now backfills).
`addMarket`'s trigger is now gated on `needsBackfill` too, so browse→Add reuses the browse data (no
re-fetch, no duplicate rows; `writeBackfillRow` ignores `(market_id,snapshot_date)` conflicts as a
2nd guard). **Constrains:** never make cron scope read `markets` instead of the watchlist tables
(that's what keeps browse out of the cron). A browse market's one-time backfill is bounded per-market,
but the COUNT of browse markets grows unbounded — a future GC finds them via a LEFT JOIN vs the
watchlist tables + `markets.last_checked_at` (deferred). Merged to main `0d9b035`, pushed.

### latest.json schema_version label — preserved as historical record
DATE: 2026-07-02
STATUS: ACTIVE — INTENTIONALLY LEFT AS-IS

DECISION: docs/api/v1/latest.json's schema_version reads "1.3.0" while
the confidence sub-block inside it is 2.0.0-shaped (the confidence block
was retroactively filled at Increment A / migration 0010). The version
label reflects the epoch of the original SpaceX freeze, not the current
schema version. This label is intentionally preserved as a historical
record of the freeze time. It is not a bug.

RATIONALE: Changing the label retroactively would misrepresent when
the freeze occurred. The 2.0.0-shaped confidence block is already
documented in the parity gate notes (Gate 2b faithfulness proof).
Any reader inspecting the file should consult decisions.md for the
provenance context.

TRIGGERS_REVIEW_IF: The frozen artifact is formally versioned and
needs a migration path to a new schema format.

## Detail history reads use a LEAN server-side projection — efficiency ≠ data reduction
**Decided (2026-07-02):** the detail Server Component's history read switched from `readHistory`
(full `record` JSONB × up to 365 rows) to a new `readHistoryLean` that projects ONLY the two record
sub-paths any surface consumes — `derived.markets` (Δ columns / movers / dual-chart lines) and
`derived.iqr` (dispersion) — **in Postgres** (PostgREST `record->snapshot->derived->…` selection),
reshaped by pure `leanHistoryRow` back into the row shape every derive fn already consumes (zero
changes to the derive fns; equivalence locked by a full≡lean deep-equal test).
**Measured (dev Supabase, p50 of 5):** SpaceX 180-day ladder **287ms / 1.6MB → 75ms / 323KB**;
fed-rate-cut 189 rows **160ms / 791KB → 65ms / 91KB**. The dropped ~80% (raw_inputs, narrative,
analytics, scenarios per historical record) was fetched and discarded — nothing read it.
**The quant-fund framing (load-bearing):** efficiency here means *fetching only what is displayed*,
NOT displaying less — every field any surface shows still flows to the client, which already
received only lean series. **Constrains:** `readHistory` KEEPS its full-record contract —
`scripts/verify-history.mjs` re-hashes `record.snapshot.raw_inputs` from its rows (the provenance
gate), so its shape is load-bearing; display reads use `readHistoryLean`, provenance reads use
`readHistory`. If a future derivation needs another record field, ADD it to the lean projection —
never quietly widen back to `record`.

## Red-team of the confidence tuning constants — ledger + outcomes
**Decided (2026-06-30):** A calibration red-team on every tuning constant introduced across the
confidence-split epic — windowed volume ($50K/$5K, the $2K 24h floor), B's reliability (entropy 0.40,
leader 0.70, rel-spread 0.50), C's depth ($100K/$10K) — driving the real scorer functions with
adversarial inputs (boundary, manipulation, interaction) + a fresh 280-market live re-survey (overfit,
flicker). **Outcome: no threshold moved** — the worst-of composition held up; one design fix (F1) and
three accept-and-document decisions. The ledger:
- **F1 (FIXED — P2): MAX-per-leg book depth over-credited a non-headline leg.** A deep book on an obscure
  low-volume longshot made a market read LIQUIDITY HIGH when the headline (leader) leg was thin —
  over-credit, the wrong direction for a trust signal. Fixed: `book_depth` = the DOMINANT-outcome leg's
  depth (most-traded leg proxy), max-fallback only when the leader has no book. See the Increment-C
  entry + the F1 lock test.
- **F2 (ACCEPTED — no hysteresis): the $10K depth boundary is the most flicker-prone** (~5% of live
  markets within ±15%, vs ≤1% at the bimodal volume boundaries). **Why accept:** both sides of the
  boundary mean the SAME actionable thing — "not HIGH liquidity, be careful" — so a MED↔LOW flicker
  doesn't change the signal a user acts on. Hysteresis would add state + complexity for no actionable
  gain. Not worth it.
- **F3 (ACCEPTED — conservative by design): a deep book + ZERO recent volume reads LIQUIDITY LOW**
  (worst-of caps it). You can technically trade against resting orders, but a deep book with no trades
  is suspect (stale/wide orders), and **the 280-market survey found ZERO such markets** — the case is
  theoretical. Understating liquidity here is the safe direction. Deliberate.
- **F4 (ACCEPTED — inherent, not a gap): faking HIGH liquidity requires faking BOTH volume AND depth.**
  Worst-of means wash-traded volume alone is caught by the depth signal and a spoofed book alone is
  caught by the volume signal (both verified). That an attacker who fakes *both* can still score HIGH is
  an inherent property of any composed market-data signal, not a residual risk — composition RAISES the
  bar, it was never claimed to be unspoofable. Documented as deliberate.
- **F5 (NO ACTION — redundant-but-harmless): the `leader ≥ 0.70` guard rarely binds** — `entropy ≤ 0.40`
  already implies a leader well above 0.70 for typical N (e.g. `[0.7,0.3]` → entropy 0.88). Kept as a
  cheap defensive guard; correct, just seldom the binding constraint.
**Strengths confirmed (the design working):** depth worst-of catches wash-traded volume; volume worst-of
catches spoofed depth; the spread guard blocks the consensus lift on a manipulated wide-book market; a
last-trade-priced leader caps reliability even under strong consensus (the lift never masks a stale
headline); depth complements the F1 stale-7d-spike floor. **Constrains:** the constants are validated as
of this survey — re-run the live re-survey if Polymarket's market mix shifts materially before trusting
them long-term. Any future change to a tuning constant re-runs the parity gate + full suite.

## Order-book DEPTH → LIQUIDITY (confidence split, Increment C)
**Decided (2026-06-30):** "Can you transact at this price" needs resting-order depth, not just recent
flow. Gamma exposes a per-market `liquidity` field ($ of resting orders) **in the same meta response
`core/fetch.js` already pulls** (verified live — no extra call, no per-leg CLOB hit), so Increment C
adds it via the proven Increment-1 supplementary pattern: `legWindowed` reads `m.liquidity ??
m.liquidityClob`; `aggregateLiquidity` records `derived.liquidity.book_depth` = a per-leg value, **NOT a
sum** — resting orders don't aggregate across mutually-exclusive legs (a 128-leg event summed would
massively over-count). **[SUPERSEDED by red-team F1, above]** the initial selection was the MAX per-leg;
F1 changed it to the DOMINANT-outcome (most-traded) leg's depth, because a blind max over-credited a
market whose deepest book sat on an obscure longshot, not the headline. `bookDepthSignal` tiers (operator-calibrated on ~150 live
markets, depth p50 ≈ $62K / p75 ≈ $352K): **HIGH ≥ $100K, MED ≥ $10K, LOW below.** It feeds the
LIQUIDITY dimension of all 4 scorers **worst-of with windowed volume** (a thin book caps liquidity even
at high recent volume — e.g. a real market with $3.15M/24h but a $53K book reads MED, not HIGH; you
can't transact $3M at the touch). Never touches reliability. Surfaced in `VolumeCard` ("book $X") + the
liquidity basis chips (the reason flows automatically).
**Why:** windowed volume answers "was there flow"; depth answers "is there a book to trade against NOW"
— complementary. The survey found **0** markets with a deep book but no recent volume (MMs pull books
when trading dies) and a meaningful tail of high-volume-but-thin-book markets that worst-of now catches.
**Constrains:** SUPPLEMENTARY — `book_depth` is outside `raw_inputs`, never hashed; **omit-when-absent**
(a resolved market carries no gamma `liquidity` field → SpaceX frozen replay omits it → `derived`
byte-identical → **parity 4/4**). `bookDepthSignal(null)` / no-`book_depth` → null → no-op (the
parity-safety path, identical to `windowedVolumeSignal`). methodology 1.7.0 (no schema change — `derived`
is open, no `additionalProperties`). ⚠ **RED-TEAM TODO (carried):** the $100K/$10K depth cutoffs join
Increment B's entropy 0.40 / leader 0.70 / rel-spread 0.50. **Operator live-verify:** confirm a live
market's served record carries `derived.liquidity.book_depth` (same live-gate posture as Increment 1's
windowed volume). See [[gotchas]] "A NEW always-present field on `derived` breaks SpaceX Gate 2".

## Consensus + decisiveness → RELIABILITY (confidence split, Increment B)
**Decided (2026-06-30):** Strong agreement makes the HEADLINE number reliable even on a thin book, so
it feeds RELIABILITY (additive; no schema change). **Categorical:** a concentrated distribution (norm.
entropy ≤ 0.40 AND a ≥70% leader) LIFTS a spread-driven `medium` reliability to `high` — `meanSpread`
averages across legs, so a tight 98% leader + wide thin tail-legs reads `medium` even though the
headline is decisive; the lift corrects that. It NEVER lifts a `low` (>8% averaged book — genuinely
illiquid) or a `skipped`/`last-trade` defect (those cap separately). `buildCategoricalRecord` passes
`entropy`+`dominantProb` to the scorer. **Binary:** a decisive prob (≤0.02 / ≥0.98) whose spread is a
MINORITY of the smaller tail (rel ≤ 0.5) adds a "price well-determined" reliability REASON — but **no
tier lift**, deliberately: a binary has a SINGLE book (no wide-tail-leg averaging to correct), and a
medium-band spread on an extreme line ALWAYS dominates the tiny tail, so there is no legitimate
medium→high lift to make (the rel-spread guard would always block it). The asymmetry categorical-lifts
/ binary-reason-only is the load-bearing insight.
**Why:** the CT-Governor case (Fazio 98%) should read RELIABILITY HIGH *because of the consensus*, not
merely because volume moved to the liquidity tier — Increment A stopped volume dragging it; B makes the
consensus an explicit positive reliability signal. **Constrains:** thresholds (entropy 0.40 / leader
0.70 / rel-spread 0.50) are tuning constants — a future red-team should pressure-test them. Ladder/touch
untouched; SpaceX parity 4/4 byte-identical (categorical/binary-only). methodology 1.6.0. The lift must
stay gated so it can never raise a market with a real defect. See the Increment-A entry below.

## Confidence SPLIT into two independent tiers — RELIABILITY + LIQUIDITY (Increment A)
**Decided (2026-06-30):** The single confidence tier conflated two genuinely orthogonal questions, so
a 98%-consensus market with no recent volume (CT Republican Primary — Ryan Fazio at 98%) read LOW and
looked like a bug. `derived.confidence` is now `{ reliability, liquidity }`, each a `{tier,score,
reasons}`:
- **RELIABILITY** (is the displayed NUMBER trustworthy): threshold count, monotonicity, spread (+expiry
  tolerance), last-trade fallback, missing rungs, stale-feed. Near-settlement carve-out lives HERE.
- **LIQUIDITY** (can you TRANSACT at this price): book-thin breadth, windowed volume (all-time
  fallback), closed/not-accepting-orders rungs, liquidity-drop.
- **The signals are REPARTITIONED, not retuned** — every threshold/reason string is unchanged, just
  moved to the dimension it belongs to. The old single tier == `worst(reliability, liquidity)`
  (`collapseConfidenceTier`), so nothing is lost.
- **`closedCount` → LIQUIDITY** (you literally cannot trade a closed rung); its stale-price aspect is
  already covered separately by last-trade fallback under RELIABILITY. **Near-settlement → RELIABILITY
  only**: it must not drag the number's trustworthiness, but liquidity stays genuinely low (you can't
  trade a settling market — and that reads through the windowed-volume signal, not the carve-out).
- Result for the CT case: **RELIABILITY HIGH + LIQUIDITY LOW** (verified: tight spread → HIGH;
  $120/24h → LOW), no longer a single misleading LOW. (Increment B will add entropy→reliability so the
  consensus itself explicitly lifts reliability; Increment C folds book-depth into liquidity.)
**Why:** A quant must be told WHICH problem a market has — an untradeable-but-trustworthy price
(everyone agrees, nobody trades) is the opposite situation from a deeply-traded-but-unreliable one, and
collapsing both into one tier hides which is true. The number a fund acts on must not be flagged
untrustworthy merely because it's illiquid.
**The SpaceX parity strategy (the load-bearing part — a PROVABLE shape migration, NOT fixture-editing
to mask a regression):** Gate 1 (raw_sha256) and Gate 3 (history curve math) are byte-identical and
untouched — the split is entirely downstream of `raw_inputs`. Gate 2 deep-equals the whole `derived`
block including confidence, so it diffs ONLY in the confidence sub-block, intentionally. The fixture's
`derived.confidence` was surgically regenerated to the new shape by RUNNING the new builder (only that
sub-block changed; median/mean/iqr/buckets/markets/analytics/narrative/scenarios/freshness stay
byte-identical — confirmed by the diff). **The regen is made legitimate by a new automated GATE 2b**
(`phase1-spacex-parity.test.js`) that hardcodes the OLD frozen tier/reasons (independent of the moved
fixture) and proves the split is FAITHFUL: `reliability.tier === 'high'` (the old tier),
`liquidity.tier === 'high'`, `worst(reliability,liquidity) === 'high'`, and the two new reason lists'
UNION === the old reasons (`"…tight spreads"` + `"deep books"` == `"…tight spreads, deep books"`), with
no reason double-counted. This is why this is not the forbidden "edit the fixture to pass" — the
semantic content is proven preserved, only the shape moved.
**Constrains:**
- **schema 2.0.0** (BREAKING confidence shape) + `validate.js` (`validateHistoryEntry` requires both
  `reliability.tier` + `liquidity.tier`); **methodology 1.5.0** (signals repartitioned, no curve-math
  change). Per the firewall-versioning rule a breaking field reshape would warrant `/api/v2/`, but the
  product has a single live consumer mid-rebuild (the PIVOT's no-parallel-fallback posture), so we bump
  schema MAJOR in place rather than fork the directory.
- **Migration 0010** adds `reliability_/liquidity_` tier+score to `market_snapshots` + `market_history`;
  legacy `confidence_*` columns are KEPT (written with the collapsed worst, back-compat). **We do NOT
  backfill the old single value into both new columns** — the old tier conflated the dimensions, so
  copying it into `liquidity_tier` would FABRICATE a liquidity reading never computed (the trust rule).
  Legacy rows keep new columns NULL; the display shows "—" for the missing half until new data accrues.
  `market_latest` is `select … *` so the columns surface automatically (no view recreation).
- **Published legacy artifacts:** `latest.json` is regenerated (recomputed from its raw_inputs → new
  shape, schema-validated by firewall/analytics tests). `history-full.json` is split IN PLACE (every
  historical reason is a reliability signal; liquidity = the benign `deep books` default these days
  always had) — NOT re-derived, because re-deriving without the original raw_inputs would downgrade the
  captured live-spread reliability to price-only (a dishonest rewrite). `history.csv` is untouched
  (still CSV-safe; not cross-checked).
- The split must stay ATOMIC across all 4 scorers + schema + display (a half-migration breaks the
  shape). `worstTier`/`collapseConfidenceTier` exported from `core/confidence.js`. `deriveConfidenceTrend`
  → `deriveReliabilityTrend` + `deriveLiquidityTrend` (legacy kept for pre-0010 rows). Narrative trend
  claims key off RELIABILITY (the number's trustworthiness), not liquidity. See [[gotchas]] "A breaking
  derived shape change…" and "Changing a .mjs signature breaks the consuming .tsx via JSDoc".

## Analytical-depth epic: supplementary derived fields, windowed liquidity, horizon-aware confidence
**Decided (2026-06-29):** a 7-increment pass deepening the analytics, every increment parity-gated
(`feature/analytical-depth`). The durable decisions:
- **Windowed volume is SUPPLEMENTARY, never hashed.** Gamma returns per-leg `volume24hr`/`volume1wk`;
  we aggregate them into a NEW `derived.liquidity` object — NOT into `raw_inputs`/`canonicalizeRawInputs`
  (frozen recipe + SpaceX hash untouched, same posture as `midpoint_source`). The event-level windowed
  volume EQUALS the sum of per-leg windowed (verified live to the cent), so summing legs is the
  authoritative aggregate, uniform across all 5 market types. **All-time volume stays the FALLBACK** in
  the binary/touch/categorical scorers when windowed is absent. Tiers (operator-calibrated): HIGH 24h≥$50K
  OR 7d≥$200K; MED 24h≥$5K OR 7d≥$25K; LOW below.
- **`derived.liquidity` is OMITTED when no windowed data is present** → SpaceX's frozen replay (legs
  predate the feature) stays byte-identical. Load-bearing parity pattern (see gotcha "a NEW always-present
  `derived` field breaks Gate 2") — it's why windowed volume could be added at all.
- **days-to-expiry is computed DISPLAY-SIDE (header), NOT stored in `derived`.** midpoint_source lives in
  `raw_inputs` (not the deep-equal'd derived block); an always-present new `derived` field would break
  Gate 2 and SpaceX legitimately has a days-to-expiry (can't omit-when-false). So
  `format-detail.daysToExpiryLabel` derives it at render from `asset.resolves`. The CONFIDENCE spread
  normalization still uses days-to-expiry at COMPUTE time (not stored) — SpaceX ~550d → ×1.0 → identical.
- **Time-to-expiry normalizes spread tolerance** (`spreadToleranceMultiplier`): >90d ×1.0 / 30–90d ×1.5 /
  7–30d ×2.5 / <7d ×2.5. NEVER tightens. The relaxation near expiry is backstopped by the independent
  windowed-volume signal (worst-of) — a genuinely-illiquid near-expiry market still reads LOW via volume.
- **Two daily cron captures** (02:00 + 18:00 UTC) keyed by `snapshot_hour` (migration 0009); `ordered()`
  COLLAPSES to one row/day preferring the nearest-US-peak capture — every derive fn prefers US-hours, no
  double-counting. Frozen history (no snapshot_hour → 0, one row/day) → collapse is a no-op.
- **Velocity is jump-aware** (`detectJumps`): with a recent jump (≤21d) the slope is computed on POST-JUMP
  data; trend reads 'converged' (post-jump σ < ½·|jump|) or 'volatile' instead of a misleading linreg.
- **The narrative closes with ONE cross-signal synthesis sentence** (`synthesizeSignals`) which OWNS the
  jump mention (the standalone jump line was removed to avoid duplication; the velocity card keeps it).
**Constrains:** any future `derived` addition must be omit-when-absent or display-side (never an
always-present new key). History-derived analytics live in `lib/market-history.mjs` (display layer, NOT
`core/`) → never touch the record/hash/parity. **PROD-STANDUP now needs migrations 0001–0009 + CRON_SECRET
+ the SECOND cron entry (18:00 UTC) in vercel.json (Pro plan).**

## The lifecycle PROBE must classify market shape first (audit F1) + the cron self-heals backfills
**Decided (2026-06-26):** `lib/compute.probeLifecycle` (the cheap gamma-meta probe `serveMarket`
runs on the within-TTL path to confirm a market hasn't resolved) now **classifies the market shape
first** (`classifyMarketShape`, one gamma GET, no parse) and routes to the shape's lifecycle-status
fetcher; ONLY survival parses `$X`. Before this it assumed a survival ladder and ran the `$X` parser,
throwing "Cannot parse threshold" (HTTP 500) on every binary/categorical/touch/bucket market whenever
the serve took the PROBE branch (cached <15-min TTL, last probe >60s — exactly where a freshly-added
binary lands a minute after adding). Mirrors `computeMarketRecord`'s classify-then-route; injectable
deps for offline tests.
**Why:** a whole class of markets 500'd in the detail a minute after being added — the rail showed
them fine (cache), the detail broke. The probe was the one serve-path step that still assumed the
SpaceX shape. Serve correctness must be shape-aware end-to-end, not just in compute.
**Also decided (self-heal):** the daily `/api/snapshot` cron now retries markets where
`needsBackfill(status)` (status **null** = the add-time trigger never ran, or **'failed'**) by FIRING
the dedicated `/api/backfill` route (its own budget; ACK 202 + rebuild in its `after()`), bounded to
10/run so a backlog drains over days. So a missed add-time backfill self-heals within a day instead of
staying empty forever. (`backfill_status`/`backfilled_through` columns from migration 0008 drive it.)
**Constrains:** the probe now does 2 gamma GETs (classify + status) instead of 1 — acceptable (both
are cheap meta, no CLOB). No `core/` change; **frozen SpaceX parity 3/3 holds.** Verified live via the
real PROBE path (fed-rate-cut categorical + us-recession binary render where they 500'd). See
[[gotchas]] "Audit DOM sweeps must scope…" for the F3/F4 measurement artifacts found alongside.

## History backfill on add — reconstruct market_history from CLOB prices-history (Phase 5)
**Decided (2026-06-25):** When a user adds a market, immediately rebuild `market_history` from
Polymarket's per-token CLOB price history, so velocity/dispersion/Δ/movers/chart populate from
day one instead of waiting weeks for the daily cron. Built as I1–I4 on `feature/history-backfill`:
- **I1 `core/price-history.js` (pure):** `GET /prices-history?market=<token>&interval=max&
  fidelity=1440` → `{history:[{t,p}]}`; floor each point to its UTC DATE, last point per date per
  token, forward-fill per-leg gaps (flagged), `complete=false` before a leg's first datapoint.
- **I2 `lib/backfill-record.mjs`:** per day, build a `live`-shaped object from that day's per-leg
  prices and run the SAME core builders the live path uses (survival/bucket_pmf/binary/touch/
  categorical) → a validated record.
- **I3 `lib/backfill.mjs`:** orchestrator (gamma meta → N histories → reconstruct → assemble →
  write), I/O injected (serve-market pattern). REUSES the live gamma meta parsers (exported from
  `core/fetch.js`, additive). One bad leg/day never aborts; a fatal error marks the market failed.
- **I4:** bearer-guarded `/api/backfill` (own budget: ACK 202 + run in `after()`; `?wait=1`
  synchronous); `addMarket` fire-and-forgets it; migration 0008 (`market_history.source`,
  `markets.backfill_status`/`backfilled_through`).
**Provenance model (the load-bearing part):** a backfill row gets a REAL, re-verifiable
`raw_sha256` — same `hashRawInputs` recipe over `raw_inputs` whose `midpoint` is the historical
price, `best_bid/ask=null`, `volume=null`, `midpoint_source='clob_price_history'` (the exact shape
the live `last_trade` path already hashes). Confidence is CAPPED at MEDIUM with a
historical-backfill reason (no live book/spread to assess). `snapshot.source.{backfilled,method}`
mark the row reconstructed. The markers + `midpoint_source` stay OUT of `canonicalizeRawInputs`, so
the hash recipe — and the **frozen SpaceX hash** — are untouched.
**Why:** the on-demand model cached ONE snapshot, so the analytics were empty until the cron
accrued days. Backfill makes a freshly-added market immediately useful, honestly labelled as
reconstructed-not-captured. **The UI needs no change — it already reads `readHistory`.**
**Constrains:** **CRON PRECEDENCE** — backfill INSERTs and treats a `(market_id,snapshot_date)`
unique conflict as a no-op (`writeBackfillRow` → false), so a real captured `source='cron'` row is
NEVER overwritten by a reconstruction. Daily `fidelity=1440` is the ONLY full-depth option (finer
fidelities are retention-capped to ~17 days — see [[gotchas]]). No `core/fetch.js` behavior change
(only added `export` to the 5 meta parsers + `pinnedConfigFor`) → parity 3/3 holds. Offline gates:
255/255, parity 3/3, tsc + build clean. Live gate (apply 0008, set CRON_SECRET, add a market →
history backfills) is OPERATOR-run. See [[gotchas]] "CLOB prices-history".

## Near-settlement state + confidence recalibration CONFINED to that path (Bug 3)
**Decided (2026-06-25):** A market is NEAR SETTLEMENT when it expires within 7 days AND a
majority (>50%) of rungs are pinned to ~0/~1 (`core/confidence.nearSettlement(markets,
daysToExpiry)`). For such a market the large monotonicity adjustments, closed rungs, and
last-trade-priced legs are the EXPECTED signature of a winding-down book, not data-quality
problems — so `scoreConfidence`/`scoreTouchConfidence` STOP penalizing them (gated on
`expected = settled || nearSettled`), letting a liquid converged market read MEDIUM/HIGH
instead of LOW. A genuinely missing price (`skippedCount`) STILL penalizes — that's a real CDF
hole, not an expected artifact. The state drives an amber `◐ NEAR SETTLEMENT` badge on every
detail view and (Bug 6) swaps the signal-less 1→0 distribution for a settlement-consensus view
(`SettlementConsensus.tsx` + `format-detail.settlementZone` = the max-mass bucket).
**Why:** active liquid markets near expiry were scoring LOW because the pipeline read the
artifacts of convergence as noise — the opposite of the truth (a converged market's number is
MORE reliable, not less). The number a fund acts on must not be flagged untrustworthy precisely
when it's most certain.
**Constrains — THE PARITY GUARD:** the recalibration is gated ENTIRELY on `nearSettled`, and
`derived.near_settlement` is OMITTED when false, so a normal market (incl. frozen SpaceX,
~18 months to expiry → `nearSettled` false) is byte-identical — `phase1-spacex-parity.test.js`
Gate 2 (full derived deep-equal, INCLUDING confidence) stays green. NEVER widen the carve-out to
the general scoring path (that would move SpaceX's frozen confidence). The history path passes no
`daysToExpiry` → `nearSettled` false → Gate 3 unaffected. See [[gotchas]] "Adding a field to derived[]".

## Categorical markets compute (de-vig for DISPLAY, raw midpoints in the hash) — Phase 1b
**Decided (2026-06-25):** Categorical events (named mutually-exclusive outcomes, e.g. "How many
Fed rate cuts in 2026?") now COMPUTE (`core/categorical.js` + `fetchCategorical*` +
`computeCategoricalRecord`) instead of the friendly-422 gate. Each leg's YES midpoint is P(outcome);
the legs form a PMF that is NORMALIZED to sum to 1 for display (de-vig — the market-maker overround
removed), yielding `{ kind:'categorical', outcomes[], dominant_outcome, dominant_prob, entropy
(normalized Shannon), consensus_strength, implied_winner }`. New `kind='categorical'` (migration
0007 + schema `allOf` branch + `validate.js` skip). Live-verified on the real Fed market (13
outcomes sum 1.0, dominant 80%).
**Why:** categorical markets have real, valuable structure (a distribution over outcomes); gating
them as "unsupported" left a whole Polymarket market class unserved. Normalization makes the
distribution legible without distorting provenance.
**Constrains:** the de-vig is a DISPLAY transform — the RAW observed YES midpoints stay in
`raw_inputs` (synthetic `threshold` = leg index, a stable canonical sort key, mirroring binary's
1=YES/0=NO), so `canonicalizeRawInputs` and the hash recipe are UNCHANGED (constraint #2: the hash
is over truth, not presentation). Documented in `methodology.json` `metrics.categorical`. Same
freeze/compute lifecycle pattern as binary/touch. This is the 5th routed shape — see the taxonomy
entry below; the "5 shapes" framing now means all five COMPUTE.

## Per-market history system — additive daily cron + cache table (Phase 1, the v1-parity unlock)
**Decided (2026-06-25):** The product computed on demand and cached ONE snapshot, so every
velocity/dispersion/trend card was empty (v1 SpaceX showed them from a stored daily series). Phase 1
adds `market_history` (migration 0006: one row/market/UTC day, upsert on `(market_id,snapshot_date)`)
written by a daily Vercel Cron (`app/api/snapshot`, `0 2 * * *`) that runs the SAME authoritative
`serveMarket` pipeline for every watched market. `lib/market-history.mjs` derives velocity (≥7d),
dispersion (≥30d), per-threshold deltas, and biggest movers; the detail view renders a Trend &
history section (`HistoryChart` + cards).
**Why:** history is the foundation the entire Phase-3 v1-parity roadmap (delta columns, movers,
populated analytics) is gated on — none of it is possible from a single cached snapshot. Built
additively so it touches NO compute path (SpaceX parity intact).
**Constrains:** (1) **RLS deny-all, MIRRORING `market_snapshots`** — the service role is the only
reader (bounded to a single `market_id` per `readHistory`, same per-market trust as the public
`/api/market`); we deliberately did NOT add an authenticated-SELECT policy (operator-confirmed —
the prompt's spec self-contradicted). (2) **`/api/snapshot` is CRON_SECRET-bearer-authed and FAILS
CLOSED** (timing-safe compare, 401 if the secret is unset) — and it must be EXCLUDED from the
session-auth middleware (see [[gotchas]]). (3) **Sub-minimum series return an explicit
`{status:'collecting', N/min}` — NEVER dashes or a fabricated number** (the trust rule; carried into
Bug 8's analytics cards). (4) One failure never stops the batch; RESOLVED markets are skipped
(frozen). PROD-STANDUP now also needs 0006+0007 applied + `CRON_SECRET` set.

## Market shape taxonomy — 5 types, shape-aware routing (not "any multi-leg $ = ladder")
**Decided (2026-06-24):** `computeMarketRecord` (`lib/compute.mjs`) routes on a FINE market
shape — `binary | survival | bucket_pmf | directional_touch | categorical`
(`core/fetch.js marketShapeFromMarkets`/`classifyMarketShape`) — classified from gamma
question text BEFORE any threshold parse. The legacy `kindFromMarkets`/`classifyMarketKind`
(binary|ladder|categorical) is kept ONLY for the binary gate + its existing tests; the new
path refines the old 'ladder' bucket into the three real multi-leg structures.
- **survival** (SpaceX "above $X"): the original P(>X) ladder, unchanged.
- **bucket_pmf** (Bitcoin/Anthropic "between $X and $Y" / "less than" / "or greater"): parse
  intervals → de-vig the PMF to sum 1 → DERIVE the survival curve P(>boundary) → reuse the
  ladder math (`core/bucket.js` + `computeBucketPmfRecord`). Stored kind `threshold_ladder`
  (ladder-SHAPED → no migration, renders in the ladder detail view). The headline mean is the
  PMF expectation Σ midpoint·prob (NOT the survival-tail formula — that was the $54T blowup).
  One non-`$` categorical leg ("Will X not IPO …") is excluded with a count.
- **directional_touch** (WTI/Silver "(LOW)/(HIGH) hit $X"): HIGH = P(touch ≥ X), LOW =
  P(touch ≤ X); tent-shaped, non-monotone → NO settlement distribution, NO implied median.
  The signal is the implied 50%-crossover RANGE (`core/touch.js` pure + `core/touch-record.js`
  builder + `computeTouchRecord` + `components/zones/TouchDetailView.tsx`). New
  `kind='directional_touch'` (schema `allOf` branch + DB migration 0005).
- **Units** (`core/money.js`): `parseMoney` (thousands-commas + K/M/B/T suffix → absolute $),
  `deriveUnit`; thresholds are stored as MANTISSAS in the derived unit (like SpaceX's "1.8"
  for $1.8T), so every surface (detail/rail/narrative/labels) reads in the market's own unit.
**Why:** The pipeline assumed ONE shape (SpaceX's "above $X" survival ladder). Real Polymarket
markets mostly are NOT that. Forcing bucket/touch markets through the survival model produced
duplicate-threshold collisions, a 30× median/mean ratio, and "$T" on everything — all
plausible-but-WRONG numbers (the worst failure for a trust product). The fix MODELS each shape
correctly; a dedup + trimmed-mean patch over the wrong model was explicitly rejected.
**Constrains:** SpaceX stays a pinned `survival` ladder with its mantissa-only `parse_pattern`
→ frozen `raw_sha256` byte-identical (the ONLY frozen record; all new parsing is off the
pinned path). `canonicalizeRawInputs` is UNCHANGED — bucket uses the bucket lower-bound as
`threshold`; touch uses SIGNED synthetic thresholds (+level HIGH / −level LOW) for uniqueness
+ deterministic hash (mirrors binary's 1=YES/0=NO). New `kind` values need a
`markets_kind_check` widen (migration 0005 = directional_touch; bucket needs none).
`schema.json derived.kind` is an `allOf` of three if/then branches (binary | directional_touch
| else-ladder); `validate.js` skips the ladder invariants for binary + directional_touch.
Import-cycle guard: `core/touch.js` stays pure (no snapshot import) so `fetch.js` can import
it; the builder lives in `core/touch-record.js`. Adding a shape = fetcher + builder + schema
branch + route (the binary precedent) — never a market literal in core/ math. See
`MARKET-TYPES-PLAN.md` + [[gotchas]] "survival pipeline silently mis-modeled".

## `/api/market` is NEVER HTTP-cached (`Cache-Control: no-store`) — the probe is the correctness layer
**Decided (2026-06-18):** The serverless function (`api/market.mjs`) sets `Cache-Control: no-store` on
**every** response (was `public, max-age=30` on 200s). No edge/CDN/proxy/browser caching of
`/api/market` — every request must execute the function.
**Why:** Resolution authority is a **per-request** check. `lib/serve-market.mjs` runs the gamma-meta
resolution **probe** (`decideBeforeProbe → PROBE → probeLifecycle`) before serving a within-TTL OPEN
record, so a market that resolved *after* caching is caught and refrozen — this is the C4 guarantee. An
HTTP response cache **bypasses the function entirely** (confirmed live: `x-vercel-cache: HIT`, the
function never ran), and with it the probe — so a `public, max-age=30` response let Vercel's Edge replay
a stale **OPEN** record for up to 30s after a market resolved (the exact stale-live gap C4 exists to
prevent). It also made live-verify C2 read `cached:false` on a genuine OPEN hit (the Edge replayed
call #1's miss response). The cost savings HTTP caching would add are **already captured by the Supabase
cache** (a hit serves `cached:true` with zero Polymarket calls on every real invocation); edge-caching
only saves a warm function invocation while trading away resolution correctness — a bad trade for a
fund-facing feed. `no-store` (not `private, no-cache`) so a browser/back-button can't replay a stale
`OPEN`/`age_seconds`/`freshness` either (those are computed at function time and embedded in the body).
**Constrains:** Never reintroduce `public`/`max-age`/`s-maxage` on `/api/market` (or any endpoint whose
correctness depends on the per-call probe) to "save cost" — the Supabase cache is the cost layer, the
probe is the correctness layer, HTTP caching skips both. If a future endpoint is genuinely static
(no resolution semantics), cache *that* one explicitly, never the market-serving path. Verify the
`cache-control: no-store` response header after any deploy (it fingerprints the live build). Proven by
`scripts/verify-phase2a.mjs` 12/12 live (2026-06-18). See [[gotchas]] "Vercel edge-caches …".

## Phase 2a cache + secrets boundary (serverless verified-snapshot cache)
**Decided (2026-06-17):** The Vercel function (`api/market.mjs` → `lib/serve-market.mjs`) serves a
verified record from a Supabase cache, computing on demand via `lib/compute.mjs` → `core/` when needed.
Design rules:
- **Cache×resolution precedence (the correctness trap):** resolution state is authoritative over the
  cache. `lib/decide-cache-action.mjs` (pure, fully unit-tested): a RESOLVED cached record is served
  forever (monotonic, no probe, 0 Polymarket calls); a within-TTL OPEN/CLOSED_PENDING record is
  **gamma-meta-probed before serving** (deduped by PROBE_TTL≈60s) so a market that resolved *after*
  caching is recomputed/frozen, never served stale-live; past-TTL recomputes (which re-classifies).
  TTL = 15min (OPEN); cost is bounded by TTL, not request volume.
- **Per-market freshness:** on-demand records carry **TTL-based** `stale_after` (`buildSnapshotRecord`
  gained an optional `freshnessThresholdHours`); the cron path passes nothing → 17h, so SpaceX stays
  byte-identical. RESOLVED = `freshness.final`, never stale.
- **Secrets boundary:** the `service_role` (write) key lives ONLY in the function's server-side env
  (`SUPABASE_SERVICE_ROLE_KEY`, never `NEXT_PUBLIC_`); `lib/cache.mjs` is server-only. RLS is enabled
  with NO anon policies (anon can touch nothing) so the boundary is safe before 2b adds a browser
  client. Generalizes the PAT-exposure lesson: no write-capable credential in client-reachable code.
- **Single write path:** the ONLY writer to `market_snapshots` is `lib/cache.mjs writeRecord`, fed a
  `validateRecord`-passed record by `computeMarketRecord`/the seed — no path caches unvalidated data.
  The cache STORES `raw_sha256`, never recomputes it.
- **Schema:** `markets` (id = event slug = FK target) + `market_snapshots` (immutable archive, unique
  on (market_id, fetched_at)) + `market_latest` view. FK-ready for 2b watchlists/notifications with no
  table rewrite. Migration is reversible (`_down.sql`); cache is regenerable (no source data).
**Why:** scale the verified pipeline to many markets on managed/serverless infra without per-market
eyeballing, while the cache never reintroduces the Phase-1 resolution bug and never leaks a write key.
**Constrains:** never add an `anon`-readable write policy; never write to the cache outside
`writeRecord`; never serve a record that didn't pass `validateRecord`; keep resolution authoritative
over TTL. Deploy mechanics (Supabase/Vercel projects) are human-provisioned in browser consoles;
live-deploy verification gates "2a done". See `docs/ARCHITECTURE.md` §3/§4/§6.

## Market generalization is config-driven; SpaceX is one pinned instance (Phase 1)
**Decided (2026-06-17):** Every market-specific value lives in a per-market **MarketConfig** DATA
object (`core/markets/<id>.json`), never a code branch — `grep -ri "if.*spacex" core/` must stay
empty. `core/market-config.js` `defaultConfigForLadder(thresholds, meta)` derives scale-free defaults
(tail offsets as a fraction of the median inter-threshold gap, relative confidence count thresholds,
etc.) for any ladder; SpaceX's pinned config equals the historical constants exactly. Every `core/`
function takes the relevant config slice with a **legacy default**, so existing callers and SpaceX are
byte-identical and only generic markets take new branches.
**Why:** Generalizing to many markets without per-market eyeballing requires the tuned constants to be
data, not scattered literals — but the verified SpaceX output must not move. The dual guarantee is
enforced by a **blocking parity gate** (`test/phase1-spacex-parity.test.js`): frozen `raw_sha256`
(`c1be52e4…b89003`) + full `derived` deep-equal + 183-day history re-derive, all against an immutable
pre-generalization fixture. Proven on a second real ladder (Kraken IPO $16–28B) via the generic path.
**Constrains:** Never reintroduce a market literal into `core/` math — add a config field. Never edit
the parity fixture to make a test pass (a diff is a real regression). The frozen hash recipe stays
untouched (generalization is all downstream of `raw_inputs`). methodology 1.4.0 / schema 1.3.0
(additive). See [[gotchas]] resolved-market trap; `docs/ARCHITECTURE.md` §1.2.

## Two-stage market resolution; classify from gamma meta BEFORE any CLOB call
**Decided (2026-06-17):** A market's lifecycle (`core/lifecycle.js`, `snapshot.lifecycle`) is
**OPEN → CLOSED_PENDING → RESOLVED**, classified from gamma signals (`closed` + `umaResolutionStatus`
+ `outcomePrices`) — never `active`/`endDate` (unreliable). RESOLVED only when EVERY rung is
UMA-confirmed (a settled outcome per rung); CLOSED_PENDING when trading ended but UMA is unconfirmed —
**never claims a final outcome** (UMA can lag/dispute); else OPEN. A non-OPEN market is **frozen** (the
orchestrator preserves the last OPEN record + stamps the outcome + `freshness.final`; no live pull; a
frozen RESOLVED record is never re-pulled). Classification happens from **gamma meta before any CLOB
fetch**, because a resolved market returns no midpoints.
**Why:** v1 pulled forever — a resolved market would show a live, drifting estimate of a settled fact;
and the moment SpaceX resolved (2026-06-17) the old cron crashed on missing midpoints. `closed` alone
is not "confirmed" (disputes happen), so we split "stop showing drift" from "declare the result" — a
fund must not be told a final outcome for a still-disputed market. `validate.js` asserts RESOLVED
carries an outcome and OPEN/CLOSED_PENDING do not.
**Constrains:** Resolution notifications (a later phase) must fire ONLY on RESOLVED, never
CLOSED_PENDING. Keep classification before the price fetch. `snapshot.lifecycle` stays OUTSIDE
`derived` so an OPEN market's derived block is byte-identical. Don't use `active`/`endDate` as
resolution signals. See `docs/ARCHITECTURE.md` §5.

## PIVOT: single-market tool → multi-market hosted product (Vercel + Supabase)
**Decided (2026-06-17):** After v1 (single SpaceX market, GitHub Actions + Pages) validated with a
hedge fund, the product generalizes into a **hosted multi-market** product. Locked stack: **Vercel**
(frontend + serverless functions running `core/`), **Supabase** (DB + auth + realtime), **Polymarket**
unchanged as source of truth. First pass scopes to **threshold-ladder events** (SpaceX is one
instance); single binary markets are a deferred record type. Refresh: **on-demand + cache, cron for
followed markets only**. Full design in `docs/ARCHITECTURE.md`; built phase-by-phase (Phase 1 =
`core/` generalization + resolution guard).
**Why:** v1's trust machinery (verified pipeline, firewall, hash, validation) is the differentiator a
fund pays for; the goal is to scale it to many markets without manual per-market eyeballing, on
managed/serverless infra a solo operator can run. The fund is not using the site during the rebuild,
so we migrate cleanly (no parallel-fallback constraint).
**Constrains — THE GOVERNING PRINCIPLE: the verified pipeline runs ON THE BACKEND, on demand.** Every
served number is still isotonic-adjusted, firewall-checked, validated, and hashed by `core/` — the
client never fetches Polymarket and bypasses `core/`. The cache **stores** the frozen hash, never
recomputes it. `derived.scenarios` (Tier-2/SpaceX) becomes **optional**, attached only when a
per-market assumptions config exists — the firewall rule stays un-relaxed. Resolution state is
**authoritative over the cache** (a resolved market is never served as live data); resolution
notifications fire only on **confirmed** UMA resolution, never first sight of `closed:true`. Phase 1
has a **blocking byte-identical-hash gate**: the generalized pipeline must reproduce the SpaceX
record's `raw_sha256` exactly, proving generalization didn't chip the pipeline. See
[[spacex-multi-market-pivot]] in MEMORY if present, and `docs/ARCHITECTURE.md`.

## Staleness threshold is a DERIVED function of the snapshot schedule (never a literal)
**Decided:** With the 2h cadence (cron `0 0,12,14,16,18,20,22 * * *`, 7 runs/day, overnight pause
00:00→12:00 UTC), `core/freshness.js` exports the schedule as facts — `SCHEDULE = {CADENCE_H:2,
MAX_EXPECTED_GAP_H:12, JITTER_MARGIN_H:3}` — and computes `STALENESS_THRESHOLD_HOURS` as their sum
(**17h**). `test/schedule-coupling.test.js` re-derives the gap profile from the ACTUAL update.yml cron
(max gap == MAX_EXPECTED_GAP_H, min gap == CADENCE_H) and fails loudly on cron syntax it can't parse.
**Why:** The previous 50h literal was sized for the retired daily cadence and carried a correct,
well-written comment — which desynced anyway the moment the schedule changed (audit P0-1: at 2h
cadence, 50h ≈ 25 missed runs of silence before the STALE flag fired). Comments don't couple; a test
that re-derives the numbers from the workflow file does. Methodology bumped to **1.3.0** (minor:
published policy fields change meaning; no formula change).
**Constrains:** Changing the snapshot cron REQUIRES re-deriving `SCHEDULE` (the coupling test forces
it). Never reintroduce a free-standing threshold literal, and never widen the threshold to quiet a
STALE flag — investigate the pipeline instead. verify-accuracy.js shares the constant by import.

## CI verify gate = publish-then-alert, non-strict, last step
**Decided:** `update.yml` runs `scripts/verify-accuracy.js` (non-strict) as the LAST step, after the
push and the email steps, in all modes. Exit ≠ 0 turns the run red (alert) but can never block
publication or digests. Transport failures (output without a `VERDICT:` line) retry once; real
verdicts surface immediately.
**Why:** Seam-5 fail-mode design: a wedged feed (nothing published) is a worse failure than a
published-then-flagged snapshot — freshness disclosure already covers consumers. Non-strict because
`--strict` promotes Gamma-vs-CLOB cross-source disagreement to FAIL, and Gamma is a documented
*lagging* cross-check (see "Canonical source of record") — false reds train alert blindness. Seconds
after the snapshot the record is deep inside the 3h price-match window, so non-strict still exits 1
on any real published-vs-live mismatch, which at that age means build corruption.
**Constrains:** Do not move the gate before the push (that re-creates the wedge), do not add
`--strict` without first separating cross-source disagreement from publish-mismatch in the exit
codes, and never widen a tolerance to quiet a red run — a FAIL is a finding to investigate.

## GitHub concurrency queue-drop at 2h cadence is ACCEPTED
**Decided:** The `snapshot-commit` concurrency group keeps at most ONE pending run queued; GitHub
cancels additional pending runs even with `cancel-in-progress:false`. Under the 2h cadence (plus
email crons and manual dispatches) a third overlapping run gets cancelled. This is accepted, not
worked around.
**Why:** A cancelled queued snapshot is covered by the next scheduled run within ≤2h — well inside
the 17h staleness threshold. The serialization itself is what prevents the `rebase -X theirs` clobber
window (a queued run checks out only after the prior one pushed, so it always sees that commit).
**Constrains:** Don't remove the concurrency group to "fix" cancelled runs — it's what makes the
push path safe. If sub-2h data loss ever matters, redesign the queue, don't drop the group.

## Volume = Gamma market-level all-time cumulative `volume`
**Decided:** The per-threshold `volume` we publish is Gamma's **market-level `volume`** field — read once
in `core/fetch.js` (`m.volume`), and summed across thresholds for `derived.total_volume`. For these
SpaceX markets it equals `volumeClob` and `volume1yr` (the markets are **CLOB-only**, so AMM volume is
zero and the variants coincide). It is **all-time cumulative** volume; we take the single market-level
figure and do **not** sum the YES+NO tokens (Gamma's `volume` is already market-level). This is the
**same statistic as Polymarket's ALL-timeframe display**. The dashboard column is labeled
"**All-time volume**" with a tooltip tying it to the snapshot's `fetched_at`.
**Why:** Apparent gaps vs the Polymarket UI are **temporal staleness on a cumulative metric, not a
definition mismatch** — all-time volume only ever grows, so a UI reading taken earlier than our live
fetch is necessarily lower, by an amount proportional to each market's subsequent trading. Verified
**2026-06-11** via timeline reconstruction: for >$1.8T, >$2T and >$3T the screenshot's ALL figures all
land strictly between `now − volume1wk` (~1 week ago) and `now` (live), and the gap is largest exactly
where the last week's trading was heaviest (>$1.8T). No single window field (`volume24hr/1wk/1mo/1yr`)
matches the UI numbers; only the cumulative-with-staleness model explains all three consistently.
**Constrains:** Keep reading the market-level `volume` (not a window field, not a YES+NO sum). `volume`
stays in the frozen `raw_inputs` hash recipe (see "raw_inputs + hash recipe are FROZEN") — do not swap
the field. Relabeling/precision lives in presentation only; this is **Tier-1**, no new computation and no
version bump. Like "Canonical source of record — the CLOB midpoint", this is a canonical-definition
decision: do not re-litigate it as a bug when a stale UI tab disagrees.

## Concurrency-safe CI commit/push (the snapshot bot races itself + humans)
**Decided:** `update.yml`'s "Commit API + baked dashboard" step is robust to a remote that advances
mid-run: a **`concurrency: { group: snapshot-commit, cancel-in-progress: false }`** serializes runs
(queued, never cancelled — no snapshot dropped); the push then does **fetch → `git rebase -X theirs
FETCH_HEAD` → push, retrying up to 5×**; `actions/checkout`/`setup-node` are **@v5** with
**`fetch-depth: 0`** so the rebase always has its merge base.
**Why:** A naive `git push` is rejected ("fetch first") whenever the bot or a human pushed after the
runner checked out `main` — this is exactly what failed run 27096553941. Rebasing our one generated-file
commit onto the latest tip integrates the advance instead of failing. `-X theirs` keeps the **freshly
built** artifacts on a generated-file conflict (during rebase "theirs" = the commit being replayed, i.e.
this snapshot — they are the authoritative current state). The concurrency group means two *snapshot*
runs can't overlap, so the retry mainly absorbs non-snapshot pushes. Proven green: run 27154304762,
commit `01d505b` landed via this path.
**Constrains:** Keep this YAML-only — never let push robustness changes touch `core/` formulas, the
schema, or `scripts/snapshot.js` (the pipeline itself was correct). When editing the workflow, trigger a
**fresh** dispatch, not "Re-run jobs" (see [[gotchas]]). The bot's `-X theirs` could in principle clobber
a *newer* concurrent snapshot — the concurrency group is what prevents that, so don't remove it.

## Canonical source of record — the CLOB midpoint
**Decided:** Two public Polymarket surfaces expose a YES price and they are **different statistics**:
the **CLOB `/midpoints`** value `(best_bid + best_ask)/2` and **Gamma**'s `outcomePrices`. The feed's
`raw_inputs.midpoint` (hence every `raw_prob` and all derived metrics) is the **CLOB midpoint** — that
is the input of truth. Gamma is used **only** for metadata (token ids, volume, threshold parsing); its
`outcomePrices` is a **lagging cross-check, never an input**.
**Why:** The CLOB midpoint is the live two-sided book (the price you could transact near), computed
from `best_bid`/`best_ask` we already publish — self-consistent. Gamma `outcomePrices` is a
platform-surfaced display value that can reflect last-trade or a cached number and **lags the book**
(observed this session: a stale published 0.9845 vs Gamma 0.993, while *live* Gamma and CLOB agreed).
Picking one source of truth and documenting it is what lets a quant trust the feed.
**Constrains:** Never feed Gamma `outcomePrices` into `raw_inputs` or any metric. On disagreement the
CLOB midpoint wins and the divergence is **reported, not silently reconciled** (see
`scripts/verify-accuracy.js` cross-source check, ±1pt). Documented in `METHODOLOGY.md` ("Source of
record") + `core/methodology.json` `metrics.source_of_record`. Keep the hash recipe over the CLOB
midpoint frozen.

## Data freshness is Tier-1, policy-baked but evaluated client-side
**Decided:** Every record carries `derived.freshness` = `{ as_of, staleness_threshold_hours,
stale_after, expected_cadence, policy }` — a pure function of the snapshot's own `fetched_at` plus one
constant (`STALENESS_THRESHOLD_HOURS = 50`, in `core/freshness.js`). The published record holds
**policy only**; the live `age`/`stale` flag is computed **client-side** (dashboard + note) as
`now > stale_after`. **50h** because the snapshot cron (`update.yml` `0 14 * * *`) runs **daily incl.
weekends** (~24h normal gap), and 50h absorbs one fully-missed run (~48h) without false-alarming.
**Why:** A silently stale number is a trust failure, so the feed must disclose its own age. But age is
inherently a **read-time** quantity — baking `stale:true/false` at build time would be a frozen lie the
moment the file sits unchanged. Publishing an absolute `stale_after` instant lets every consumer judge
staleness with one comparison and no duplicated threshold. (The "weekday-only / ~72h weekend" belief
was **wrong** — only the *email* crons are weekday-gated; the snapshot is daily.)
**Constrains:** Tier-1 (no assumption — firewall-safe). `core/freshness.js` is the **single source**
of the threshold; the browser only supplies "now". The verifier shares this same 50h constant for its
*liveness* horizon (see [[gotchas]] two-horizons). Schema change was additive (`derived.freshness`,
optional → schema 1.2.1). Don't bake a live flag into the published record.

## The Tier-1 / Tier-2 firewall (most important constraint)
**Decided:** Market-derived outputs (Tier 1) and assumption-based outputs (Tier 2) are
**structurally** separated, not just visually labeled. Tier 1 = pure transforms of observed
Polymarket prices, under `derived` + `derived.market.analytics`. Tier 2 = anything needing an
input the market didn't provide (shares outstanding, a prior valuation), quarantined under
`derived.scenarios`.
**Why:** A quant trusts Tier 1 *because* the assumptions are quarantined. One assumption leaking
into a market metric, or one unsourced scenario number, discredits the whole feed.
**Constrains:** `validate.js` **fails the build** if (a) any `derived.scenarios` number lacks a
non-empty `assumptions[]` with a `source` + `as_of` + `value`, or (b) an `assumptions` key appears
anywhere under `derived` outside `derived.scenarios`. Renderers must style Tier 2 distinctly
("ASSUMPTION-BASED" banner). Never relax these checks.

## No grey-market / secondary-market data in v1
**Decided:** v1 uses **public Polymarket data only**. No Forge / Caplight / EquityZen scraping or
secondary-market trade data.
**Why:** Scope discipline + legal exposure — secondary-market data carries licensing/redistribution
risk and is a different product (v2). Keeping v1 to a public, free, auth-less source keeps it clean
to ship and defend.
**Constrains:** Any feature needing a secondary-market price is out of scope. (Note: the SpaceX
shares estimate is sourced from mainstream *press* reporting of a company tender — press, not a
secondary-trading-platform feed — and is flagged low-confidence; see the assumptions entry below.)

## Never fake calibration
**Decided:** Calibration is a **scaffold only**: `status:"pending_resolution"`, `resolves:"2027-12-31"`,
plus the standing forecast recorded for later scoring. No Brier score, no accuracy number.
**Why:** The market resolves exactly once (at IPO close). A calibration/Brier score before
resolution would be fabricated precision — the exact thing this product refuses to do.
**Constrains:** Do not compute a score until the outcome is known. `core/analytics.js`
`computeCalibration()` must never emit `brier`/`score`. A test asserts their absence.

## Assumptions-as-inputs (Tier 2 sourcing)
**Decided:** Every Tier-2 external input is a registry entry in `core/assumptions.json` with
`{ value, unit, source, source_url, as_of, confidence, range:[low,high], adjustable, note }` — never
a silent constant. With no usable input, the scenario renders `status:"input_required"`, never a guess.
SpaceX `shares_outstanding` ≈ **1.9B** is a *press-derived estimate* (Reuters, Dec 13 2025: ~$800B
tender at $421/share → 800e9/421), `confidence:"low"`, `range:[1.7B, 2.1B]`. `last_round_valuation`
≈ $0.80T from the same report.
**Why:** SpaceX is private and discloses none of this. The honest move is to expose the input, its
source, its date, and its uncertainty band — and let a user adjust it — rather than bake in a number
that looks authoritative.
**Constrains:** Changing a value bumps `assumptions.json` `version`. The dashboard's user edits
recompute client-side and **must not mutate the published feed**. Bump confidence/range honestly.

## Independent semantic versioning (methodology / schema / assumptions)
**Decided:** Three independent semvers — `methodology_version`, `schema_version`,
`assumptions_version` — and **every snapshot embeds all three**.
**Why:** They change for different reasons. A formula change (breaking) is methodology; a field
addition is schema (additive); an input change is assumptions. Consumers need to know which moved.
**Constrains:** A formula change bumps methodology + adds a changelog entry. Schema changes must stay
**additive** within `/api/v1/` (breaking → `/api/v2/`). `methodology.json` and `METHODOLOGY.md` must
stay consistent.

## raw_inputs + hash recipe are FROZEN
**Decided:** `snapshot.source.raw_sha256` = sha256 over the canonical JSON of `raw_inputs`
(keys ordered `token_id, threshold, midpoint, best_bid, best_ask, volume`; ascending by threshold;
literal API string values). This recipe and the `raw_inputs` shape **do not change**.
**Why:** Every archived `snapshots/YYYY-MM-DD.json` is independently verifiable against this exact
recipe. Changing it silently breaks the verifiability of all historical archives — the core trust claim.
**Constrains:** Status flags (closed/active) and any new metadata go in side channels / `derived`,
**never** into the hashed `raw_inputs`. The browser verifier in `index.html` and `core/fetch.js`
`canonicalizeRawInputs` must stay byte-identical.

## One source of truth — core/ owns every formula
**Decided:** Every metric is computed exactly once in `core/` (metrics, stats, analytics, scenarios,
confidence, narrative). Renderers and scripts import and display; they never recompute.
**Why:** Duplicate formulas drift (that was defect D1: a delta rounded two ways read $0.19T vs $0.20T).
Single source = surfaces can't disagree.
**Constrains:** Deltas/derived numbers are computed in core and **stored**; renderers read stored
values through one formatter (`core/format.js`). A `grep` for any formula must find one definition.
The red-team has twice caught renderer re-derivation (density bars, then guarded) — keep checking.
