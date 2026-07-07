# primer.md — resume here

> First file to read on a new session. Present-tense, thin, kept current.
> The "why" behind decisions lives in `.workflows/_knowledge/decisions.md`;
> traps that already bit us live in `.workflows/_knowledge/gotchas.md`.
> **Knowledge layout (this repo):** `primer.md` is the resume-here file (it plays the
> SESSION-CONTINUITY role); the only `_knowledge/` files are `decisions.md` + `gotchas.md`.
> There is **no `.workflows/_system/` dir, no `codebase.md`/`MEMORY.md`** — the global `/sync`
> skill tolerates their absence (updated 2026-06-18); don't be alarmed when it skips them.

## ⮕ DIRECTION (2026-07-07, latest): HARD-STOPS H1-H4 RESOLVED — MERGED to main + PUSHED (`main` @ `b805f17`)
- **`main` is at `b805f17`, in sync with `origin/main`.** PR #1 (the perfection pass, previous entry
  below) was merged first (`--no-ff` `407bb92`); this session then closed all four HARD-STOP items
  it left open, on `fix/hardstops-h1h2h3h4` (4 commits), merged `--no-ff` `b805f17`, pushed directly
  (operator-run, no classifier block this time). **458/458 (+4 over the 454 baseline); parity 4/4
  byte-identical (`c1be52e4…b89003`); tsc 0 errors; clean `next build`.**
- **H1 (confidence.js monoScore) + H2 (LOW-tier window naming) + H4 (PM TERMINAL → PREDICTION
  INDEX) FIXED; H3 (touch-record boundLabel $) DEFERRED + documented** (TODO at the exact line +
  gotchas entry — no live %-unit touch market exists yet). Full detail + exact fix design (why the
  MEDIUM window-naming pattern couldn't apply verbatim to H2's LOW branch, why H1 doesn't move
  SpaceX's frozen score) in [[decisions]] "Hard-stop resolutions: monoScore carve-out, LOW-tier
  window naming, PM TERMINAL → PREDICTION INDEX".
- **NEXT:** nothing pending on H1-H4. Still open from the prior entry: prod standup checks prod cron
  rows land at hours 2/18 UTC; optional `git branch -d fix/resolved-no-prior-all-shapes` (carried,
  stale). `git branch -d fix/hardstops-h1h2h3h4` (fully merged, safe to delete).

## ⮕ DIRECTION (2026-07-06): PERFECTION PASS — 14 gated fixes — MERGED to main + PUSHED (PR #1, `main` @ `407bb92`)
- **PR: https://github.com/ilanbenamaro-cyber/Prediction-Index/pull/1 — MERGED.** (A direct push to
  main was DENIED by the permission classifier when this was first attempted → PR-review flow used
  instead; the operator then reviewed and merged via `gh pr merge`.) **Gates at merge: 454/454 (+22
  over the 432 baseline); parity 4/4 byte-identical (`c1be52e4…b89003`); tsc + clean `next build`;
  verify-phase2a vs the PRODUCTION build ALL GREEN — including C4, green for the first time since the
  confidence split.** Full-system audit (Opus math + Opus security + adversarial probes): **no P0
  anywhere**; Playwright sweep of every view/state: **0 console errors**.
- **Why C4 is finally green (P1):** `seed-spacex.mjs` was a SILENT NO-OP — `writeRecord` upserts with
  `ignoreDuplicates` on `(market_id, fetched_at)` and a frozen record's fetched_at never changes, so
  the documented "re-run the seed" remediation could never work. `writeRecord` gained a `replace`
  option (seed-only); dev re-seeded. See [[gotchas]] "A conflict-IGNORING upsert…".
- **Touch dup-strike dedup (P1, the session's big data-accuracy find):** gamma touch events carry
  re-listed strikes with CONTRADICTORY settlements (early-touched Yes + re-listed No at the same
  level). `dedupTouchLegs` in `fetchTouchMeta` keeps the current board. `si-hit-jun-2026` fully
  remediated on dev: 70 stale pre-split snapshot rows purged → serves 200 RESOLVED ("touched LOW
  $60–75"), history purged + re-backfilled (187 rows, 21 unique strikes). See [[decisions]]
  "Touch strikes dedup to the CURRENT BOARD".
- **Other P1s:** unknown/delisted slug → 404 (was 502); post-jump velocity window clipped to its
  "7d" label; resolved-market display voice (settlement banners for touch/categorical, resolved
  narratives, expiry-countdown suppression). **P2s:** refreshMarket getUser guard + MARKET_ID_RE
  allow-list; %-unit touch settlement labels; resolvedBand inversion guard; binary NO% complement
  (101% artifact); caveat-dot basis chips; slug-uniquifier strip + platformLabel; search clears on
  close; degenerate range labels; net-move/fitted-trend disambiguation.
- **CLOSED carried items:** si-hit 422 (above); cron snapshot_hour 15/19 = dev-DB manual runs, NOT a
  bug (see [[decisions]] "Cron snapshot_hour…"; prod-hours check = operator standup); Bitcoin
  two-sided confirmed serving 200 RESOLVED on prod (classifier-gap note stands, no code change).
- **The four HARD-STOP items this pass left open (H1-H4) are now resolved** — see the entry above.

## ⮕ DIRECTION (2026-07-06): RESOLVED-NO-PRIOR 409 FIX — ALL 5 SHAPES — MERGED to main + PUSHED (`main` @ `40e5855`)
- **`main` is at `40e5855`, in sync with `origin/main`.** Two branches, sequential passes on the same fix:
  `fix/resolved-no-prior` (`20aa690`, binary-only) merged as `39b0cbf`, then `fix/resolved-no-prior-all-shapes`
  (`4fafd88`, the remaining 4 shapes) merged `--no-ff` as `40e5855` — clean merge, no conflict. **Final gates:
  432/432 (+21 over the binary-only pass's 411); parity 4/4 byte-identical (`c1be52e4…b89003`); tsc + next
  build clean; browser-verified.**
- **The bug (both passes):** browsing a RESOLVED market the product never captured while OPEN threw a
  **409** ("no prior record to freeze") — OUR gap, not a Polymarket limitation (gamma serves resolved
  markets with `closed:true` + `umaResolutionStatus:'resolved'` + settled `outcomePrices`).
- **Pass 1 (binary, `39b0cbf`):** `buildMinimalResolvedRecord` built a valid `kind:'binary'` record from
  settled YES/NO prices. Verified live on `net-quarterly-earnings-nongaap-eps-02-11-2026-0pt27` (Cloudflare
  NET). Two traps hit (now in [[gotchas]]): the `confidence.*.tier` schema enum (no literal `'RESOLVED'`
  tier exists) and `Number(null) === 0` fabricating a false 0% probability.
- **Pass 2 (all shapes, `40e5855`):** `buildMinimalResolvedRecord` is now shape-dispatching —
  `(shape, meta, id, lifecycle?)` — covering survival/bucket_pmf/directional_touch/categorical too, wired
  into `computeMarketRecord`'s survival branch + the 3 other shapes' compute functions. **Design: each
  shape builds a `live`-shaped object from settled prices and feeds it through the SAME builder the OPEN
  path already uses** (mirrors the backfill pattern) — reusing isotonic adjustment/quantile crossings/
  de-vig/entropy rather than re-deriving bucket math. A shared `resolvedConfidence()` (reliability high /
  liquidity low) replaces each shape's live-scored confidence. `CLOSED_PENDING`-no-prior still 409s
  everywhere (genuinely no settled outcome). Verified live on
  `what-price-will-bitcoin-hit-june-29-july-5-2026` (14-leg survival ladder): loads RESOLVED/final/absent
  from rail, 0 console errors; NET binary + SpaceX + an OPEN binary all regression-verified unchanged.
- **⚠ FOUND, NOT fixed (out of scope, flagged in [[decisions]] + [[gotchas]]):** (a) the reported Bitcoin
  market classifies as `'survival'` but is ACTUALLY a two-sided "reach $X / dip to $X" market the shape
  classifier doesn't detect (its `TOUCH_RE` only recognizes WTI/Silver's `"(HIGH)"/"(LOW)"` wording) —
  its settled outcomes are genuinely non-monotonic as a one-directional ladder; the existing isotonic step
  handles it without a crash, and a new `ladderSettlementLabel` avoids emitting a backwards-reading range
  string for this case; (b) the UI's OWN `MarketDetailView.resolvedBand` has the identical un-fixed
  backwards-label bug (independent of `derived.narrative`) — not touched this session; (c) a new gotcha —
  `raw_inputs` has a SCHEMA-WIDE `minItems:1` independent of any per-kind field's own constraints (bit
  while assuming categorical could degrade to an empty distribution).
- **NEXT:** `git branch -d fix/resolved-no-prior-all-shapes` (fully merged; `fix/resolved-no-prior` from the
  binary pass should already be gone). Nothing else pending on the resolved-no-prior fix. Possible future
  follow-ups (not scheduled): fix the "reach/dip" shape-classifier gap, fix `resolvedBand`'s backwards
  range in the UI.

## ⮕ DIRECTION (2026-07-06): HISTORYCHART REWORK + RESOLVED-MARKET DISPLAY — BOTH MERGED to main + PUSHED (`main` @ `79f7e0d`)
- **`main` is at `79f7e0d`, in sync with `origin/main`.** Two independent branches, each merged `--no-ff`:
  `feature/history-chart-multiseries` (`e0320e1`, 6 commits `6ad69ab..032a92f`) then
  `fix/resolved-market-display` (`79f7e0d`, 2 commits `2775bec..182aa60`). **Post-merge gates: 405/405
  (+18 over the 387 pre-epic baseline); parity 4/4 byte-identical (`c1be52e4…b89003`, hash re-verified
  against `test/fixtures/spacex-reference-latest.json`); tsc + next build clean.**
- **Conflict (expected, trivial):** both branches prepended a DIRECTION entry to this file and touched
  `app/globals.css`. `globals.css` auto-merged clean (both branches' new rules present — `--accent-violet`,
  `.wl-resolved-pill`, `.hist-band`, the 0.15 gridline opacity). `primer.md` conflicted on the prepended
  entries — resolved by **keeping both** (chart entry first, resolved-display entry second, this same
  ordering now collapsed below into one summary).
- **HISTORYCHART REWORK (3 bug fixes + multi-series):** **BUG 2 dedup** — a `(market_id, snapshot_date)`
  could carry an hour-0 backfill row PLUS cron rows (unique key is date+hour since 0009) → duplicate chart
  dots; new pure `collapseDaily` (cron beats backfill) applied in `readHistoryLean`. **BUG 3 touch chart**
  — the touch headline scalar is the barrier-range midpoint (a PRICE), so the chart Y-axis read
  "$6.02K"-style; new `deriveTouchSeries` plots P(touch ≥/≤ L) probability lines instead (HIGH amber / LOW
  blue). **BUG 1 axis** — probability axes were hard-fixed 0–100% and never re-domained on the 7D/30D/90D/
  ALL switch; new pure `probDomain` fits the filtered window (10pp min-span guard, clamp [0,1]).
  **Shape-aware lean read** — `readHistoryLean(id, days, shape)` now projects per-shape JSONB sub-paths
  (ladder markets+iqr; touch high/low series; categorical outcomes; binary scalars) instead of one fixed
  projection. **Multi-series** — categorical charts top-4 outcome lines; the ladder dual chart gained a
  P25–P75 IQR band. **Design polish** — "Jun 15" date ticks, 0.15 gridline opacity, top-right legend.
  Browser-verified all 5 shapes, 0 app console errors (only the pre-existing favicon 404).
- **RESOLVED-MARKET DISPLAY (2 fixes):** **Fix 1** — a watchlisted RESOLVED market showed a STALE pill
  ("needs refresh", meaningless for a frozen record); `WatchlistRows.Freshness` now renders a neutral/muted
  RESOLVED badge, with `lifecycle_state === 'RESOLVED'` taking priority over `stale_after`. **Fix 2**
  (diagnosis only, no serve change) — viewing a RESOLVED market not in the watchlist: **Case A, a gamma
  limitation** — `public-search` returns only active markets, so resolved markets are unsearchable at the
  API layer (nothing in our code to fix); a CACHED resolved market loads fine by direct `?m=` URL regardless
  of watchlist (`serveMarket` has no watchlist dependency); a NEVER-cached resolved market returns a clean
  409 ("no prior record to freeze"), not a 500 — honest, since resolved markets expose no live CLOB prices.
  Full write-up in [[decisions]] "Resolved markets are NOT searchable…".
- **⚠ STILL OPEN, pre-existing, operator-owned (carried from the chart branch, unrelated to either fix
  above):** (a) `si-hit-jun-2026` detail 422s — its stored frozen record is PRE-SPLIT schema (same family
  as the SpaceX C4 stale-seed; fix = re-seed/recompute those rows); (b) live cron rows carry snapshot_hour
  **15/19**, not the documented 2/18 (vercel.json vs docs — `prefersCapture` is hour-agnostic, nothing
  breaks); (c) gold (`what-will-gold-…-december`) is not on dev — touch verified on WTI/Anthropic/silver
  instead, gold confirms after deploy.
- **NEXT:** `git branch -d feature/history-chart-multiseries fix/resolved-market-display` (both fully
  merged). Optional follow-ups — velocity-of-P(touch) for touch cards, a 4th survival threshold line,
  re-seed the pre-split frozen rows (si-hit + SpaceX C4), resolved-market discovery via a non-gamma index.

## ⮕ DIRECTION (2026-07-03/04): BROWSE-HISTORY + 2 bug fixes — ALL MERGED to main + PUSHED (`main` @ `4b02cc2`)
- **`main` is at `4b02cc2`, in sync with `origin/main`.** Everything below the predemo/HARD-STOP entries
  (which were merged as `fe84e7e`) is now ALSO on main + pushed. **387/387; parity 4/4 byte-identical
  (`c1be52e4…b89003`); tsc + next build clean.** Three independent pieces, each branch merged `--no-ff`:
- **BROWSE-HISTORY (`0d9b035`):** any VIEWED market (search/⌘K/direct `?m=`) now loads its full
  history/trend data — no longer watchlist-only. Rail stays watchlist-only; **cron never snapshots
  browse markets** (the hard invariant — `allWatchedMarketIds` reads the watchlist tables, not
  `markets`; verified browse ids stay out). DERIVED model, **no schema change** (browse =
  served-but-not-watchlisted; `writeRecord` already creates the FK row). `DetailData` fires the shared
  `lib/trigger-backfill.mjs` (extracted from `addMarket`) via `after()` in the RSC (works — 222 rows on
  a browse); `TrendHistory` "watched" gate dropped; `addMarket` trigger now `needsBackfill`-gated so
  browse→Add reuses the data (no re-fetch). See [[decisions]] "Browse markets load history via a DERIVED
  model". Full acceptance browser-verified (Backfilling display, rail absence, upgrade path, cron scope).
- **AUTH FIX (`67a1b89`):** `lib/watchlist.mjs currentUid` was the last `getSession()` (trusts the
  cookie unverified — Vercel warning + a real pre-RLS gap) → now `getUser()` (verifies the JWT), fails
  closed. middleware + layout already used getUser. See [[gotchas]] "getSession trusts the cookie
  UNVERIFIED".
- **GOLD TOUCH-TOKEN GUARD (`4b02cc2`):** `what-will-gold-gc-hit-by-end-of-december` 500'd — an untraded
  "(HIGH) $5,000" leg with no `clobTokenIds` crashed `ids[0]` in `fetchTouchMeta`. New shared
  `parseClobTokenIds` (null for absent/empty/malformed); all 5 meta parsers now SKIP a no-token leg
  (market loads from its tradeable legs; binary single-leg → clean coded-404). SpaceX byte-identical.
  See [[gotchas]] "A gamma leg with no clobTokenIds crashes ids[0]".
- **⚠ STILL OPEN (operator-owned, carried):** verify-phase2a **C4** stays red — the dev-seeded SpaceX
  row is the PRE-SPLIT schema-1.3.0 record; the freeze path revalidates priors → 422. Fix:
  `node scripts/seed-spacex.mjs` on dev (+ prod at standup). Unrelated to any of the above. Also open:
  METHODOLOGY.md realignment (pinned 1.2.1, behind methodology.json 1.7.1); the browse-history GC
  (bounded-growth of browse rows); `feat/browse-history` local branch is fully merged and can be `-d`'d.
- **NEXT:** nothing pending on these three — all shipped. Resume from the operator's next ask.

## ⮕ DIRECTION (2026-07-02): 4 approved HARD-STOP core/ fixes — 4 more commits on `fix/predemo-polish-pass`
- **Operator pre-approved and specified all 4 HARD-STOP items** from the pass below; implemented as
  4 separate commits (16→17 total on the branch). **377/377 (+7 over the 370 from the prior pass);
  parity 4/4 byte-identical; tsc clean.** `fix/predemo-polish-pass` had already been merged into
  `main` between sessions (`d00bd09`, pushed) — fast-forwarded the branch onto that tip before
  starting, so these commits sit cleanly on top for the next merge.
- **`core/confidence.js` `windowedVolumeSignal`:** the MEDIUM-tier reason string named `'24h'`
  whenever `volume_24hr` was merely PRESENT (even $0), not whichever window actually crossed its
  own threshold — a market that qualified via 7d could read "moderate 24h volume ($0)". Now names
  the window that actually crossed VOL24_MEDIUM/VOL1WK_MEDIUM (24h preferred only when both cross).
  No threshold/tier logic changed. +2 tests.
- **`core/bucket.js` `buildPmfLadder`:** the open-bottom mean heuristic used `l.lo <= 0`, which
  wrongly caught a BOUNDED finite negative rung (a real percent leg like `[-2%, 0%)`) as if it were
  the open floor, biasing its midpoint contribution. Tightened to `!Number.isFinite(l.lo)`. **⚠
  Disclosed side effect (outside the "positive lo" guarantee):** a dollar ladder's own `[0, hi)`
  "less than $X" leg ALSO reroutes (lo=0 is finite, not -Infinity) — changing every dollar
  bucket_pmf market's LOWEST-bucket mean contribution (background text only discussed percent; this
  wasn't limited to percent by the literal fix). Updated the one existing test this touched
  (61200→55400, comment explains why); no frozen/committed artifact covers it (SpaceX is
  survival-only). +4 tests.
- **`core/touch-record.js` `buildTouchNarrative`:** the STORED narrative still said "implied 50%
  trading range" after the display layer switched to barrier-option language (INC 7) — the
  persisted text contradicted the UI. One string changed to "implied barrier range"; no test
  previously covered this exact function's output. +1 test.
- **[[decisions]]:** added the `latest.json` schema_version-label provenance entry (operator's
  verbatim decision) — preserved as-is, a historical record of the freeze epoch, not a bug.
- **NEXT:** operator review + merge these 4 commits; the earlier pass's other items (re-seed
  SpaceX, METHODOLOGY.md realignment) are still open.

## ⮕ DIRECTION (2026-07-02, later): PRE-DEMO POLISH PASS — 12 commits on `fix/predemo-polish-pass`, AWAITING OPERATOR MERGE
- **Full-codebase audit (every file in core/lib/app/components/test) + fix pass + browser gate.** On
  branch `fix/predemo-polish-pass` (NOT merged/pushed — operator reviews per convention). **370/370
  (+19 over the 351 baseline); parity 4/4 byte-identical; tsc + build clean; Playwright: 0 console
  errors on ALL 5 market types** (SpaceX survival, us-recession binary, fed-cuts categorical, UK-GDP
  percent bucket, WTI touch), ghost flows 2/3 PASS, crosshairs PASS — screenshots reviewed.
- **P1 fixed:** (a) percent-bucket BACKFILL was broken 3 ways (hardcoded `$` prefix; `v>0` boundary
  filter dropping 0/negative rungs; open-bottom `lo=-Infinity` landing in hashed raw_inputs → JSON
  null → broken canonical) — extracted pure `bucketBackfillMeta` mirroring the live path, dollar
  ladders byte-identical; (b) verify-phase2a + verify-categorical still read the pre-split
  `d.confidence.tier` → false fails, now assert both dimensions; (c) SIX display surfaces hardcoded
  `$` next to the ladder unit (`$1–2%` style on UK GDP) — modeBucket/detailNarrative/
  settlementZoneLabel/movers-label/HistoryChart-dual/TrendHistory-cards — all pfx-threaded +
  live-verified ("1.03%", "1–2% range").
- **P2 fixed:** rail remove surfaces failures; "Backfilling history…" gated on WATCHED (unwatched
  search-navigated markets get plain Collecting); touch aria-label barrier wording; `app/(app)/
  error.tsx` boundary; **perf: `readHistoryLean`** (detail history 287ms/1.6MB → 75ms/323KB p50,
  same data — see [[decisions]] "lean server-side projection"; full `readHistory` KEPT for the
  verify-history provenance re-hash).
- **Tests:** +19 (percent backfill locks, percent formatter locks, full≡lean equivalence, and direct
  coverage for quantileValuation/computeImpliedMean/marketShapeFromMarkets/statusFor/
  freezePriorRecord (incl. the pre-reshape-prior 422 characterization)/scoreTouchConfidence/
  jumpNarrative/score-trends — test/coverage-gaps.test.js).
- **Docs: methodology 1.7.1** (MATERIAL_ADJUSTMENT 0.5%; the $2K 24h floor; the CORRECTED
  book_depth dominant-leg selection superseding the 1.7.0 changelog's "max per-leg"; the categorical
  placeholder filter) + METHODOLOGY.md note + 2 new gotchas + the perf decision.
- **⚠ STILL RED (operator-owned): verify-phase2a C4** — the dev-seeded SpaceX row is the PRE-SPLIT
  schema-1.3.0 record; the freeze path revalidates priors → 422. Fix: `node scripts/seed-spacex.mjs`
  on dev (+ prod at standup). Same stale seed makes the resolved SpaceX detail's reliability/
  liquidity badges read "—". See the new [[gotchas]] "breaking derived reshape … STORED FINAL records".
- **HARD-STOP items listed, not touched** (see "Immediate open tasks"): the `($0)` windowed-volume
  reason, buildPmfLadder's non-uniform-percent mean bias, the stored touch narrative wording, the
  latest.json schema_version label.
- **NEXT:** operator review + `--no-ff` merge of `fix/predemo-polish-pass`; re-seed SpaceX (dev+prod);
  decide the 4 HARD-STOP items.

## ⮕ DIRECTION (2026-07-02): SEARCH/FRESHNESS/WATCHLIST UX + TOUCH-CHART OVERHAUL — MERGED + PUSHED
- **MERGED to main** (`--no-ff` `6a55a95`; branch `feature/ux-pass-search-freshness-barrier`, 12 commits;
  **pushed, in sync**). A 4-item UX pass, all display/action-layer → **no `core/` or hash change; parity
  4/4 byte-identical; 351/351; tsc + build clean.** Operator-verified via screenshots throughout.
- **FRESHNESS (Issue 2):** `lib/compute.mjs` stopped passing `CACHE_TTL_HOURS` (15min) as the freshness
  threshold — the rail read STALE ~15min after any cron/view (it reads cached `stale_after` without
  recomputing). On-demand records now use `core/freshness.js`'s schedule-derived **17h**, validated
  against the Vercel twice-daily cron (02:00+18:00 UTC, 16h max gap). `CACHE_TTL_HOURS` removed (dead).
  The two-horizons gotcha (cache-recompute ≠ trust-staleness). No SCHEDULE change → SpaceX parity intact.
- **SEARCH (Item 1):** `MarketSearch` selecting a result NAVIGATES to `?m=<slug>` (compute-then-serve on
  the detail page) — no preview/action-bar, no auto-add. **Landing on a detail ≠ being watchlisted** (the
  detail's `serveMarket` computes+caches but does NOT call addPersonal/addOrg). CommandBar/layout no longer
  pass `orgs` to search.
- **ADD CONTROL (Item 2):** new `components/zones/AddToWatchlist.tsx` in every detail header, adapting to org
  count (0→one button / 1→two / 2+→picker+confirm); shows "✓ On …watchlist" when already added; inline
  pending/error. `DetailData` fetches orgs + membership (listVisible) and passes a ready-made client element
  down to all 5 views. **BUG FIXED:** the control is `key`ed on server membership so an EXTERNAL remove (from
  the rail) re-runs DetailData and REMOUNTS it (useState(initial) is sticky otherwise) → the Add button
  returns. React's "reset state via key".
- **RAIL TOGGLE (Item 3):** `WatchlistRows` gains a Personal/Org toggle (0 orgs→none, 1→two buttons, 2+→org
  `<select>`), a pure client-side filter over the existing `listVisible` union — `assembleScanRows` now
  accumulates **`org_ids: string[]`** (every org a market is in, for correct multi-org filtering). Default
  Personal; scope-aware remove (removes from the viewed scope); per-scope empty states; keyboard nav over
  the filtered list. Layout passes `orgs` → WatchlistRail → WatchlistRows.
- **TOUCH CHART (Item 4 + many follow-ups):** `TouchDetailView` barrier bar rebuilt in a padded **480×150**
  viewBox (was a clipping 1000×80 strip). New pure helpers in `lib/touch-rangebar.mjs` (all unit-tested):
  `niceTicks` (round 1/2/5×10ⁿ ticks), `buildAxisSamples` (uniform axis sampling for the crosshair),
  `resolveBound` (DIRECTION-AWARE null handling), `rangeBarLayout` parameterized with `{x0,W,yAbove,yBelow,
  domain}` (defaults = legacy). Fixes, each screenshot-verified: (a) real tick axis, no clipped labels;
  (b) axis SCOPED to the implied range + 2 context levels + 12% margin (heavy-tail "will it hit $X" markets
  no longer a sliver; dead tail stays in the table); (c) crosshair value reads LINEARLY off the SCOPED axis
  — locked by an alignment test (cursor at a tick's pixel → that tick's value; the old level-anchor interp
  reported the clamped end level in the margins); (d) crosshair marks CLIPPED to the plot rect; tooltip
  follows the cursor (`tooltipAtCursor`); (e) **direction-aware null bound** — a LOW ">$max" floor (P(touch≤)
  never hits 50%, e.g. Anthropic ">$0.80T") ANCHORS the band at the ladder top (was falsely extending to the
  far-left edge, contradicting its own label) with a **dashed** unresolved marker + explicit caption;
  RESOLVED bound markers are now SOLID (were dashed); "< $min" / ">$max" EXTEND cases fade to the edge
  (not live → fixture-tested); one-sided range width shows "n/a — open-ended bound", never a dash.
  See [[gotchas]] "A server SVG can carry an interactive client overlay" for the crosshair pattern.

## ⮕ DIRECTION (2026-07-01): BACKFILL OBSERVABILITY + CHART HOVER + market_latest VIEW FIX — MERGED + PUSHED
- **MERGED to main** (`--no-ff` `30fc3c0`; branch `feature/backfill-observability-chart-hover`, 4 commits;
  **pushed, in sync**). Three-part display/ops pass. No `core/` or hash change → **parity 4/4 byte-identical;
  346/346 (+7 new); tsc + next build clean.** **Operator-verified locally:** 0 console errors on all 5 market
  types, hover crosshair + tooltips correct, no touch-bar label collision.
- **⚠ DB / SCHEMA STATUS: dev + prod verified IN SYNC as of this session.** Migration **0011**
  (`market_latest` view refresh — see PART 3) is **applied to BOTH** dev (`dxoyxjxcfbgygvjvrrfk`) and prod
  (`pcmdavmstcwxjpmpmhce`); the reliability_/liquidity_ columns from 0010 now resolve through
  `market_snapshots`, `market_history`, AND `market_latest` on both (12/12 columns each). Prod was fixed
  manually earlier this session; dev via the same idempotent script (0010 `add column if not exists` + 0011
  view refresh + `notify pgrst`). `.env.local` → dev (`dxoyxjxcfbgygvjvrrfk`).
- **PART 1 — backfill reliability (`75691c6`).** The three former silent `triggerBackfill` paths were
  already logged (prior "Audit F2"); this pass adds the missing `attempt`+`success` lines (every call
  now emits `[backfill-trigger] {event: attempt|skipped|success|failure, …}`) and captures `host`/`proto`
  at REQUEST scope in `addMarket`, passing them into the deferred `after()` callback (Next 15 allows
  `headers()` inside `after()` for a Server Function, but reading before the callback is the
  documented-robust pattern + makes the trigger testable). **UI signal:** `readBackfillStatus(id)` threads
  `markets.backfill_status` into the detail view; a freshly-added market (null/'pending') shows
  **"Backfilling history…"** in Trend & History instead of the bare "Collecting" state (`HistoryChart`
  `Collecting` branches on a `backfilling` prop). **Prod-verified live (dxoyxjxc…):** 9/9 WATCHED markets
  `backfill_status='done'`; the 4 null/0-row markets are UNWATCHED orphans — correctly excluded from the
  cron retry set (`marketsNeedingBackfill(allWatchedMarketIds())`), by design not a failure.
- **PART 2 — shared ChartCrosshair (`1df9043`).** ONE client overlay (`components/zones/ChartCrosshair.tsx`)
  gives every chart a vertical crosshair + edge-aware tooltip. The chart SVG stays SERVER-RENDERED and is
  passed as `children`; the client island layers a same-viewBox overlay (`preserveAspectRatio="none"` →
  linear pointer→viewBox map) on top. Two SERIALIZABLE modes — `snap` (points/bars) + `interpolate`
  (continuous CDF/touch axis) — so no closure crosses the RSC boundary. Wired: HistoryChart (dual shows
  ALL series at the date in one tooltip), DistributionSVG (CDF interpolates threshold+P(>X); density snaps),
  touch RangeBar (interpolates P(touch ≥/≤) from new `highPts`/`lowPts`), categorical bars (per-ROW hover,
  not an x-crosshair — horizontal bars). Axis polish: 5 Y ticks + grids, rotated every-Nth date labels
  (`pickTicks`). The numeric core is extracted to **`lib/chart-hover.mjs`** (the `touch-rangebar.mjs`
  precedent) + unit-tested (`test/chart-hover.test.js`). Interactive hover **operator-verified** on all 5
  views (0 console errors, no touch-bar collision). See [[gotchas]] "A server SVG can carry an interactive
  client overlay…".
- **PART 3 — market_latest VIEW FIX (`4f75b8e`).** Migration 0010 added reliability_/liquidity_ columns to
  `market_snapshots` but they never surfaced through `market_latest` → prod 500'd "Could not find the
  'liquidity_score' column". **Root cause:** a view's `select *` is EXPANDED + FROZEN at create time; a later
  `alter table add column` does NOT propagate. **Fix:** `0011_market_latest_view_refresh.sql` — CREATE OR
  REPLACE VIEW (re-expands `*`, preserves grants, keeps `security_invoker=on`) + `notify pgrst, 'reload
  schema'`; down = DROP+CREATE back to 14 cols (must precede 0010_down; DROP+CREATE resets grants → re-grant).
  0010's wrong comment corrected in place. See [[gotchas]] "Redefining a base TABLE via migration does NOT
  propagate to a dependent VIEW".

## ⮕ DIRECTION (2026-07-01): PERCENTAGE-DENOMINATED BUCKET MARKETS — MERGED + PUSHED
- **MERGED to main** (`--no-ff` `ac99cd4`; `0e923a4..ac99cd4`; **pushed, in sync**). `uk-annual-gdp-growth-2026`
  failed with "<2 parseable buckets" — a bucket_pmf market with PERCENT-denominated legs ("between 0% and
  1%", "below 0%", "5% or higher") the dollar-only `parseBucketLeg` couldn't read. Now supported alongside
  dollar buckets (Bitcoin/Anthropic).
- **`core/bucket.js`:** `parseBucketLeg` tries a percent path when no `$` (SIGNED — GDP growth can be
  negative); returns `{lo,hi,unit}` with `unit` `'$'|'%'`. `"below 0%"` → `(-∞, 0]` (percent has NO 0
  floor, unlike dollars' `"less than $X"` → `[0,X)`). `buildPmfLadder` boundary rule made unit-agnostic
  (a finite `b` is a rung iff ∃ leg `hi ≤ b`) — keeps percent's `0`/negative rungs, **byte-identical for
  dollar ladders**.
- **`core/fetch.js`:** percent → `unitInfo {unit:'%',divisor:1}`; an open-bottom bucket (`lo=-∞`) gets a
  finite **synthetic floor** (`minFiniteLo − medianWidth`, e.g. `-1`) for its raw_input threshold so it
  canonicalizes/hashes cleanly; labels prefix-aware. `lib/compute.mjs` config `unit_prefix ''` for %.
- **Display:** `lib/format-detail.mjs` (`unitFromLadder` recognizes `%`; `fmtMoney/fmtRange/impliedMedianLabel`
  drop `$`), `DistributionSVG` (median marker + density bars), `MarketDetailView` (`P(>X)`, analytics,
  resolved labels) — all `%`-aware. Rail inherits via the fixed formatters.
- **Live-verified:** 6 rungs (0–5%), median **1.04%** / mean **~1.0%**, %-axis, hash reproduces. SpaceX
  survival path untouched → **raw_sha256 byte-identical, parity 4/4.** methodology unchanged (no new
  metric); **339/339; tsc + build clean.** New tests: unit-tagged parseBucketLeg, percent parsing
  (positive-only / neg-to-pos / negative-only), zero-crossing PMF, percent display formatters.

## ⮕ DIRECTION (2026-06-30): CONFIDENCE SPLIT → RELIABILITY + LIQUIDITY — EPIC CLOSED (A+B+C + red-team, all merged)
- **EPIC COMPLETE + RED-TEAMED + ALL MERGED.** A (`4462960`) + B (`cf0c185`) + C (`545d1ce`) + the
  red-team F1 fix (`d834af4`) all **merged --no-ff, pushed, in sync.** A calibration red-team on every
  tuning constant (5 classes, 280-market live re-survey) **moved no threshold** — worst-of held. **F1
  FIXED + MERGED:** book_depth was a blind MAX-per-leg → over-credited an obscure deep longshot; now the
  DOMINANT-outcome (most-traded) leg's depth, max-fallback only when the leader has no book. F2–F4
  accepted-and-documented, F5 no-action. **333/333; parity 4/4 byte-identical; live-verified** (fed market
  reads its leader leg's $496K, not a non-headline $707K). Full ledger in [[decisions]] "Red-team of the
  confidence tuning constants". **The confidence-split epic is fully closed.** Migration 0010 applied
  dev+prod. methodology now 1.7.0; schema 2.0.0.
- **Increment C MERGED** (`545d1ce`; book_depth selection later refined by F1 — see the red-team entry).
  Order-book DEPTH → LIQUIDITY: gamma's per-market `liquidity` field ($ resting orders) is in the
  meta we already fetch (no extra call); `derived.liquidity.book_depth` = the leader leg's depth (F1; was
  MAX per-leg). Tiers
  HIGH ≥$100K / MED ≥$10K / LOW (calibrated on ~150 live markets), fed worst-of with windowed volume into
  LIQUIDITY across all 4 scorers — a thin book caps liquidity even at high volume (real case: $3.15M/24h +
  $53K book → MED). Supplementary, omit-when-absent → SpaceX **parity 4/4 byte-identical.** VolumeCard shows
  "book $X". methodology **1.7.0**; **332/332; tsc + build clean.** ⚠ Operator live-verify a served record
  carries `book_depth` (Increment-1 posture).
- **Increment B MERGED** (`--no-ff` `cf0c185`). Consensus/decisiveness → RELIABILITY (entropy ≤0.40 +
  ≥70% leader lift; binary decisive + tail-minority spread reason). methodology 1.6.0.
- **⚠ RED-TEAM TODO (consolidated tuning constants):** B's entropy **0.40** / leader **0.70** / rel-spread
  **0.50**; C's depth **$100K / $10K**. Pressure-test these in the eventual red-team pass.
- **NEXT (after C review/merge):** the confidence-split epic (A→B→C) is complete; a red-team pass on the
  tuning constants is the natural follow-up. See [[decisions]] "Order-book DEPTH → LIQUIDITY".

## ⮕ DIRECTION (2026-06-30): CONFIDENCE SPLIT → RELIABILITY + LIQUIDITY — Increment A MERGED + PUSHED
- **MERGED to main** (`--no-ff` `4462960`; `572e02c..4462960`; **pushed, in sync**). Three commits on
  `feature/confidence-split-reliability-liquidity`: core (`1cb1383`), display (`7e356a6`), knowledge
  (`822d997`). **324/324** on merged main; **SpaceX parity 4/4** (Gate 1 hash + Gate 2 derived + **Gate 2b
  faithfulness proof** + Gate 3 history — byte-identical except the intentional confidence shape);
  **tsc + next build clean.** Migration 0010 **operator-applied to dev + prod.**
- **What shipped (Increment A — the atomic shape split):** `derived.confidence` is now
  `{ reliability, liquidity }`, each `{tier,score,reasons}`. RELIABILITY = is the number trustworthy
  (threshold count, monotonicity, spread, last-trade fallback, missing rungs, stale-feed, near-settlement
  carve-out); LIQUIDITY = can you transact (book-thin breadth, windowed volume + all-time fallback,
  closed-rungs, liquidity-drop). Signals REPARTITIONED not retuned; old tier == `worst(rel,liq)`.
  **Fixes the CT-Governor case** (Ryan Fazio 98% consensus, dead recent volume): was a single misleading
  LOW, now **RELIABILITY HIGH / LIQUIDITY LOW** (verified). All 4 scorers (ladder/binary/touch/categorical)
  + narrative (reliability-keyed) + 4 detail views (two badges + two basis rows + 3×3 synthesis sentence)
  + rail (Option B: two tier-dots, "Reliability X · Liquidity Y" tooltip).
- **schema 2.0.0** (breaking confidence shape), **methodology 1.5.0**, **migration 0010** (reliability_/
  liquidity_ tier+score on market_snapshots + market_history; legacy confidence_* kept = collapsed worst;
  NO backfill of the missing half — never fabricate; display "—" until new data accrues).
- **⚠ OPERATOR:** migration 0010 **applied to dev + prod.** `latest.json` regenerated; `history-full.json`
  split in place; `history.csv` untouched.
- **Increment B — DONE, on `feature/confidence-reliability-enrichment`, awaiting review** (commits
  `db29c7c` code+test+methodology, knowledge follows). Consensus/decisiveness → RELIABILITY: categorical
  strong consensus (entropy ≤0.40 + ≥70% leader) LIFTS a spread-medium reliability to high (never over a
  real defect); binary decisive prob (≤0.02/≥0.98) with a tail-minority spread adds a "well-determined"
  reason (no tier lift — single-book asymmetry). CT case now reads RELIABILITY HIGH *because of consensus*.
  methodology 1.6.0; **329/329; parity 4/4.** See [[decisions]] "Consensus + decisiveness → RELIABILITY".
- **NEXT: Increment C** — book-depth into liquidity (⚠ no gamma book-depth field is currently fetched —
  only ladder thinShare + spread exist; C must reuse those or add a fetch). See [[decisions]] "Confidence
  SPLIT into two independent tiers" +
  [[gotchas]] "A breaking `derived` SHAPE change…" / "Changing a `.mjs` signature breaks the consuming `.tsx`".

## ⮕ DIRECTION (2026-06-29): ANALYTICAL-DEPTH PASS (7 increments) — MERGED to main (`--no-ff` `2c3f56c`) + PUSHED
- **MERGED & PUSHED** (`2c3f56c`; `74c4f72..2c3f56c`; **320/320** on merged main; **SpaceX parity 3/3
  byte-identical**; tsc + build clean; in sync). 7-increment `/ship`-style pass on
  `feature/analytical-depth`, EACH increment approval-gated + parity-gated. Research-first (live
  Gamma/CLOB via curl + Context7 Vercel-cron). **The discipline that made it parity-safe: every new
  derived signal is OMIT-WHEN-ABSENT or DISPLAY-SIDE — never an always-present new `derived` key, and
  no `core/` formula or `canonicalizeRawInputs` change.** See [[decisions]] "Analytical-depth epic" +
  [[gotchas]] "A NEW always-present field on `derived` breaks SpaceX Gate 2".
- **INC 1 — windowed (24h/7d) volume:** all-time volume is a poor liquidity proxy (US-recession $1.6M
  all-time hid $627/24h). Gamma per-leg `volume24hr`/`volume1wk` → summed into a NEW supplementary
  `derived.liquidity` (NOT hashed; Σlegs == event-level, verified). Confidence uses it (HIGH 24h≥$50K
  OR 7d≥$200K; MED 24h≥$5K OR 7d≥$25K; LOW), all-time = FALLBACK. VolumeCard "24h · 7d · all-time";
  rail 24h chip; ladder 24h column. `core/confidence.windowedVolumeSignal`.
- **INC 2 — cron timing:** 2nd cron 18:00 UTC (US peak) + **migration 0009** `snapshot_hour`; `ordered()`
  collapses to one row/day preferring US-hours. **⚠ OPERATOR: apply 0009 + add the 18:00 cron is already
  in vercel.json (Pro plan); live-verify two rows at hours 2 & 18.**
- **INC 3 — time-to-expiry confidence:** `spreadToleranceMultiplier` widens spread tolerance near expiry
  (>90d ×1.0 / 30–90d ×1.5 / 7–30d ×2.5); reasons read "expected near expiry — 12d remaining" vs
  "illiquid — 180d remaining". days-to-expiry header label is DISPLAY-SIDE (`daysToExpiryLabel`).
- **INC 4 — velocity jump detection:** `detectJumps` (8pp/8% threshold, ≤21d recent); deriveVelocity →
  'converged' (post-jump σ<½|jump|) / 'volatile'; slope on post-jump data.
- **INC 5 — narrative synthesis:** `synthesizeSignals` one closing conflict/reinforcement/jump sentence
  (owns the jump mention; the standalone INC-4 jump line was removed — no dup).
- **INC 6 — threshold table S/N:** `classifyLadderZones` (SETTLED_HIGH ≥95% / ACTIVE / SETTLED_LOW ≤5%);
  client `LadderThresholdTable` collapses settled zones behind per-side toggles (2 context rows kept;
  not collapsed when near-settlement or <3 active); settled Δ muted.
- **INC 7 — touch barrier framing:** "implied trading range" → **"IMPLIED BARRIER RANGE"**; barrier-option
  explainer + narrative ("…not a settlement forecast") + header tooltips; `barrierPathUncertainty`
  (width as %-of-axis → path uncertainty; omits on a one-sided range).
- **EPIC CLOSE:** **/redteam** on the confidence scoring (Inc 1+3) — NO vulns; defensively layered
  (worst-of; volume backstops the relaxed spread). ⚠ ONE calibration flag: the windowed `v7≥$200K` OR
  can read HIGH when 24h is dead (stale-spike) — operator to decide a 24h floor. **/sync** updated
  decisions+gotchas. **Playwright** (single clean dev `:3000`, **0 console errors all 3**): SpaceX
  survival (resolved → resolution cards + table + "549d to expiry"; live windowed/synthesis/collapse
  N/A on a resolved/sparse-history market, covered by unit tests), us-recession binary (LOW "thin 24h
  volume ($627)", card "$627 / 7d $16K / all-time $1.6M", "215d to expiry"), Anthropic touch (barrier
  heading/explainer/tooltip/narrative, "185d to expiry", card "$30K / 7d $198K"). Screenshots
  `epic-verify-{1,2,3}-*.png`.
- **⚠ BEFORE/AFTER confidence (volume signal, the 5 research markets):** all-time tier → windowed tier —
  **US-recession HIGH→LOW** ($1.6M all-time vs $627/24h), **CT-primary MED→LOW** ($21.7K vs $0/$0);
  Fed/SpaceX-touch/Silver stay HIGH (real recent flow); Anthropic HIGH→MED (volume drifted under $50K/24h
  + $200K/7d). The dormant-market unmasking is the whole point.
- **NEXT:** the INC-1 red-team calibration call (24h floor for the v7-OR HIGH); optional "backfilling
  history…" UI signal; live-verify INC 2 after applying 0009. PROD-STANDUP: migrations 0001–0009 +
  CRON_SECRET + the 18:00 cron.

## ⮕ DIRECTION (2026-06-26): CATEGORICAL DE-VIG + DETAIL CLEANUPS (Bug Zero/A/B/C + title) — MERGED to main (`--no-ff` `b95d73d`) + PUSHED
- **MERGED & PUSHED** (`b95d73d`; `d589729..b95d73d`; **283/283** on merged main; **SpaceX parity 3/3**;
  tsc + build clean; in sync). Clean topology (main an ancestor of `fix/categorical-devig-touch-resolved`,
  no cron race). All Playwright-verified on a single clean dev `:3000`, **0 app console errors**.
- **BUG ZERO (SHIP-STOPPER, `fa127e7`):** the categorical de-vig (`normalizeProbabilities` via
  `parseCategoricalOutcomes`) ran over ALL legs — including the 25+ generic placeholder legs Polymarket
  seeds ("Candidate C".."Candidate Z") AND untraded catch-alls ("Other"), each $0 volume / ~0.5 raw —
  so the denominator collapsed the real leader: **Ryan Fazio read 7%** (label-only filter → 65%; truth
  ~97%). Fix: **`isPlaceholderLeg`/`realCategoricalLegs`** drop a leg ONLY when **zero volume AND (generic
  `<word> <letter>` label OR midpoint still pinned at the ~0.5 untraded default)**; applied at the TOP of
  `parseCategoricalOutcomes` so de-vig/entropy/dominant compute over **real, traded** candidates only.
  Any traded leg (vol>0) is always kept; a $0-vol leg with a real divergent quote (a long-shot) is kept
  too. **raw_inputs + the hash are UNTOUCHED** (the filter is on the derived display PMF, not on what's
  hashed — every observed leg still lands in raw_inputs). **Playwright: Ryan Fazio 98%** on
  `connecticut-governor-republican-primary-winner`, only the 5 real candidates (Fazio/Stewart/Wilcox/
  McCaughey/Arora), no Candidate X, no Other. **⚠ stale cache:** a record computed before this fix shows
  the wrong %; the detail's RefreshButton (or any TTL-expired serve) recomputes it correct.
- **BUG A (`762519f`, categorical display):** `CategoricalDetailView` defensively re-drops placeholders
  with the SAME `isPlaceholderLeg`; bars capped at 10 via a new **client `CategoricalOutcomeBars`** with a
  "N more outcomes" expand; headline names the leader only above a **10% floor** (`NO_CONSENSUS_FLOOR`),
  else "No consensus — field is wide open". (NB: the filter is so effective that every live crowded field
  collapses to its 2–8 real outcomes, so the >10 expand path didn't trigger live — verified by render +
  logic, not a live >10 market.)
- **BUG B (`762519f`, touch tables):** new **client `TouchProbabilityTable`** — NEAR SETTLEMENT shows only
  active rows (P(touch) > 1% either side) + "N settled legs hidden" + a **show-all** toggle (Silver: 6
  active, 15 hidden, show-all → 21); otherwise the full table with consecutive 0%/0% rows collapsed into
  one "N levels at 0%" row (Anthropic: full mode, nothing to collapse).
- **BUG C (`762519f`, resolved ladder):** a RESOLVED ladder swaps the v1 at-the-money/tail P(>X) cards
  (0%/100% with a meaningless "30d Δ") for **RESOLUTION STATE cards** — outcome ("Settled: $2–2.2T range"),
  final implied median ($2.10T), resolution date (from `lifecycle.as_of`/`fetched_at`). SpaceX verified.
- **Title date-range repair (`762519f`):** `humanizeDateRange` fixes "June 22 28 2026" → "June 22–28, 2026"
  (em-dash + comma; only fires on Month + bare day(s) + 4-digit year), applied in `titleFromSlug` +
  `displayTitle` → rail + every detail title. Verified in the rail ("What Price Will Bitcoin Hit
  June 22–28, 2026"); the live `bitcoin-hit-june-22-28-2026` detail 502s (market delisted from gamma —
  its window passed), so the repair is rail- + unit-verified, not detail-verified.
- **⚠ DEV-ENV note:** `rm -rf .next` under a LIVE `next dev` wedges it (stale in-memory chunk refs → every
  route 500s) — same stale-`.next` family. Recover with kill-all + `rm -rf .next` + ONE fresh server. Don't
  rm `.next` while dev is running.
- **NEXT:** optional detail "backfilling history…" signal from `backfill_status`; Phase-4 polish.
  PROD-STANDUP still needs migrations 0001–0008 + CRON_SECRET.

## ⮕ DIRECTION (2026-06-26): v1-DEPTH DETAIL (items 1–11 + dual-axis chart + non-ladder propagation) — MERGED to main (`--no-ff` `e31c02d`) + PUSHED
- **MERGED & PUSHED** (`e31c02d`; `b9182bc..e31c02d`; **278/278** on merged main; **SpaceX parity 3/3**;
  tsc + build clean; `main`↔`origin/main` in sync). Clean topology (main was an ancestor of
  `feature/v1-depth-detail`, no cron race). The whole v1-depth epic is **display-only** — no
  pipeline/hash/stored-data change; frozen SpaceX `raw_sha256` byte-identical.
- **The epic brought the detail views to v1 depth.** Items 1–6,8–11 (survival ladder) landed in the
  first two commits (`8e17b03`/`5a55393`); this session finished it: **ITEM 7** + propagation.
- **ITEM 7 — multi-line DUAL-AXIS history chart** (survival/bucket ladders only): per-threshold
  P(>X) lines on a LEFT 0–100% axis + implied median (bright) + faint dashed mean on a RIGHT
  valuation axis, low-confidence days dashed — exactly the v1 trend chart. New pure
  `lib/market-history.deriveChartSeries` builds **lean `{date,value}[]` per line server-side** (the
  record JSONB never ships — it reads per-threshold probs from the record on the server, emits only
  scalars). `HistoryChart.tsx` gained an optional `series` prop + a `DualPlot` rendered
  **segment-by-segment** so a low-conf day dashes just its adjacent segments; legend + axis note.
  Binary/touch/categorical pass `series=null` → unchanged single-line path. **Playwright-verified on
  SpaceX** (180-day backfill): `data-dual="true"`, 3 prob lines (P(>$2.4T)/$2.2T/$2T), median+mean,
  dual axes ($2.08–$2.50T right / 0–100% left), low-conf dashing. Screenshot
  `v1-item7-dual-axis-chart-spacex.png`.
- **PROPAGATION of items 1/5/8/11 to Binary/Touch/CategoricalDetailView:**
  - **ITEM 11** — confidence basis as a tier-marked **checklist** (✓ high · caveat ✗ low). Extracted
    to a shared **`components/zones/ConfidenceBasis.tsx`** and adopted by the ladder view too (DRY).
  - **ITEM 1** — deterministic per-kind narrative (`binaryNarrative`/`touchNarrative`/
    `categoricalNarrative` in `format-detail.mjs`): headline + 30d/7d move + consensus/range +
    confidence; Δ sentences **omit gracefully** (never "—") with no history.
  - **ITEM 5/8** — a **Key metrics** card row per view (headline value + 30d move + a kind metric +
    volume) with plain-English sub-labels. Movement Δ from the lean history series via the new pure
    **`pointChange`** (mirrors `headlineChange` on `{date,value}[]`). (Item 8's two parts map to the
    card sub-labels + the narrative's tying sentence — no separate synthesis line, to avoid
    redundancy with the narrative directly below.)
- **Offline gates:** node --test **278/278** (+13: 5 `deriveChartSeries`, 2 `pointChange`, 6 narrative),
  tsc clean, next build clean. **Playwright** (single clean dev `:3000`, **0 app console errors**):
  us-recession (binary) + Anthropic (touch) — all four propagated items render; SpaceX (ladder) —
  Item 7 dual chart. Touch "Range width" correctly shows `—` on Anthropic (one-sided range, LOW bound
  `> $0.80T` is outside the ladder → no width).
- **⚠ Wording fix mid-verify:** the narrative read "down +11.0pp" (redundant sign after the direction
  word) → magnitude-only `ppMag` (cards keep the signed `fmtDeltaPp`). Caught in the binary Playwright
  pass, not offline.
- **NEXT:** optional detail-view "backfilling history…" UI signal from `backfill_status` (cron-retry
  half done). Then Phase 4-style polish. PROD-STANDUP still needs migrations 0001–0008 + CRON_SECRET.
  A possible perf split: the detail reads up to 365 full `record` JSONBs for the chart/derivations —
  could be slimmed to horizon records + lean series if detail-load latency becomes a concern.

## ⮕ DIRECTION (2026-06-26): PREDEV GUARD + CRON BACKFILL-RETRY (audit follow-ons) — MERGED to main (`--no-ff` `6dd52c1`)
- **MERGED** (`6dd52c1`; **262/262** on merged main; **SpaceX parity 3/3**; tsc + build clean). Not yet pushed
  at the time of this entry (the `/sync` commit + push follow).
- **Predev guard (`91b55fe`):** `scripts/predev-guard.mjs` + a **`predev` npm hook** abort `npm run dev` when
  PORT 3000 is already LISTENing or a `next dev` process exists → prevents the two-servers-one-`.next` wedge
  (bitten 3+ times, incl. a FALSE "search hangs" finding mid-audit). `DEV_GUARD=off` bypasses. **Verified
  end-to-end:** clean start allowed, 2nd `npm run dev` blocked, bypass works. (It also CAUGHT a live double-server
  during this session — two were actually running on :3000 + :3001.) See [[gotchas]] "TWO `next dev`…".
- **Cron backfill-retry (`19b9545`):** the daily `/api/snapshot` cron now retries markets where
  `needsBackfill(status)` (status **null** = add-time trigger never ran, or **'failed'**) by firing
  `/api/backfill` (own budget; bounded 10/run). Self-heals a missed add-time backfill within a day. Pure
  `needsBackfill` (tested) + `marketsNeedingBackfill`. Summary reports `backfill_retried[]`. **⚠ live-verify
  (operator):** `GET /api/snapshot` with the CRON_SECRET bearer → the summary should list `backfill_retried`.
  See [[decisions]] "The lifecycle PROBE must classify shape first … cron self-heals".
- **`.env.local` loader fix (`789673f`):** the manual dotenv parse in `check-backfill-status` + `seed-history-dev`
  now strips a leading `export ` (the file is `export KEY=val`, sourceable) — they were reporting creds "not set"
  despite being present. See [[gotchas]] "A sourceable `.env.local`…".
- **F2 CONFIRMED NOT A BUG** (operator ran `scripts/check-backfill-status.mjs`): Bitcoin
  `backfill_status=done`, `backfilled_through=2026-06-23`, 3 history days — correct for a 4-day-old weekly market;
  the add-time auto-trigger DID fire. (My "silent failure" hypothesis was wrong; the `[backfill-trigger]` logging
  added in `fc14689` remains useful defensively.)
- **NEXT:** optional detail-view "backfilling history…" UI signal from `backfill_status` (the cron-retry half of
  that roadmap item is now done). Then Phase 4-style polish. PROD-STANDUP still needs migrations 0001–0008 +
  CRON_SECRET.

## ⮕ DIRECTION (2026-06-26): AUDIT FIXES (F1/F3/F7/F8 + F2) — MERGED to main (`--no-ff` `0d27dc8`) + PUSHED
- **MERGED & PUSHED** (`0d27dc8`; `b999261..0d27dc8`; **261/261** on merged main; **SpaceX parity 3/3**; tsc +
  build clean; in sync). From the live-market Playwright audit (`AUDIT-2026-06-25.md`). All Playwright-verified
  on the 5 real markets (single clean dev `:3000`, 0 app console errors).
- **F1 (CRITICAL, `dc1c2c7`):** `lib/compute.probeLifecycle` assumed a survival ladder and ran the `$X` parser
  → threw "Cannot parse threshold" (HTTP **500**) on every binary/categorical/touch/bucket market whenever the
  serve took the **PROBE path** (cached <15min TTL, last probe >60s — exactly where a freshly-added binary lands
  a minute after adding). Now it **classifies shape first** (classifyMarketShape) and routes to the shape's
  status fetcher; only survival parses `$X`. Injectable deps + 4 tests. **Verified via the real PROBE path:**
  fed-rate-cut (categorical) + us-recession (binary) render where they 500'd.
- **F3+F7 (`1682088`):** `lib/market-scan.headlineDisplay` — added a **categorical** branch (rail headline =
  leading-outcome %, e.g. fed-rate-cut `44%`, was a bare `—`) + a **null-median ladder** branch (the Bug-5
  `< $lo`/`> $hi` label, was `—`). +2 tests.
- **F8 (`57305f2`):** `.wl-title` clamps to **2 lines** — long rail titles were clipping after one; verified all
  8 rows un-clipped.
- **F2 (`investigated`, not a backfill code fix):** `addMarket`'s `triggerBackfill` had **3 SILENT failure
  paths** (no CRON_SECRET / no host / swallowed fetch) → a market added before CRON_SECRET was set (the likely
  Bitcoin cause) left history empty + `backfill_status` null with NO trace. Now each path **logs
  `[backfill-trigger]`**. Added **`scripts/check-backfill-status.mjs`** (operator-run; reads `backfill_status`/
  `backfilled_through` + history-row counts by source). **Bitcoin's manual backfill returned written:3/days:4.**
- **⚠ TWO AUDIT FINDINGS WERE MEASUREMENT ARTIFACTS** (the audit's unscoped `querySelector('[data-field=…]')`
  grabbed the **rail's first row** — rail + detail share `data-field` names): **F3-detail** (detail median is
  fine, `$2.10T`, never `—`) and **F4** (rail==detail confidence, both HIGH). Lesson for future audits: **scope
  DOM queries to `[data-zone="detail-view"]`**. F5 (Bitcoin IQR `n/a–$64.15`) + F6 (noisy quotes, 51.4%
  monotonicity adj) are real DETAIL findings, left as data-quality observations (not in the fix scope).
- **⚠ The two-`next dev`-on-one-`.next` wedge RECURRED AGAIN during the audit** (it had falsely looked like
  "/api/search hangs"; after kill-all + `rm -rf .next` + one server, search returns 200/580ms). **3rd recurrence
  — keep ONE dev server; never run `next build` while `next dev` is live (corrupts the shared `.next`).**
- **NEXT:** the recommended F2 follow-on — wire the daily cron (`/api/snapshot`) to RETRY markets where
  `backfill_status IN (null,'failed')` (columns exist) + an optional detail "backfilling history…" UI signal.
  Then Phase 4-style polish. PROD-STANDUP still needs migrations 0001–0008 + CRON_SECRET.

## ⮕ DIRECTION (2026-06-26): Phase 5 — HISTORY BACKFILL — MERGED to main (`--no-ff` `e270f05`) + PUSHED; live gate GREEN
- **MERGED & PUSHED** (`e270f05`; `ff086d8..e270f05`; **255/255** on merged main; **SpaceX parity 3/3**; tsc +
  build clean; `main`↔`origin/main` in sync). Branched off `main` (Phase 3 + Phase 4); no cron race.
- **✅ PLAYWRIGHT LIVE GATE GREEN on dev `:3000`** (operator applied migration 0008 + set CRON_SECRET + ran
  backfills; I drove the browser) across all THREE shape families, 0 app console errors throughout:
  - **survival ladder** `spacex-ipo-closing-market-cap-above` (180 days, the definitive test): **Δ columns
    24h/7d/30d** with real per-threshold values (>$2T +7.0/−1.0/0.0; >$1.6T +4.4/+1.6/+10.8; honest "—" where a
    horizon has no matching day), **Biggest Movers** real data (>$2.4T ▼−11.0 37→26%, >$1.6T ▲+10.8 85→95%,
    >$1.8T ▲+9.0), velocity `rising +0.06 $T`, **dispersion `converging IQR −46%`** (needs ≥30d — 180 delivers),
    HistoryChart **ALL = 180 dots**.
  - **touch** (Anthropic Dec-31 HIGH-only + SpaceX Jun-30, 37d each): velocity + 38-day chart populate;
    dispersion n/a + no Δ/movers — **CORRECT, touch markets have no threshold ladder by design**.
- **⚠ TWO FOLLOW-ON FIXES from the live gate (both in the merge):** (a) **one-sided touch trend** —
  `headlineValue` returned the midpoint of BOTH range bounds → null when either is null; a HIGH-only "hit $X"
  market has no LOW crossover → trend NEVER charted. Now tracks the single available bound (display-only, no
  hash/parity impact). (b) **detail history read 90→365 days** — a backfill writes 180+ days but `readHistory(id,
  90)` showed only the tail for a market whose data ends weeks ago (74 of 180). Now the chart's ALL shows the
  full series.
- **⚠ SHAPE LEARNING (cost 2 gate rounds):** Polymarket "valuation **hit** $X" / "(HIGH)"/"(LOW)" markets are
  `directional_touch` (range view — NO Δ columns / movers / dispersion). The **survival ladder** is "cap
  **above** $X" (P(>X)); "**between** $X and $Y" is `bucket_pmf` (renders as a ladder). Δ/movers only exist on
  survival/bucket. When verifying ladder analytics, pick a "cap above" or "between" market.
- **What:** on add, rebuild `market_history` from Polymarket CLOB prices-history so the Phase-3
  analytics populate from day one (not after weeks of cron). Built + offline-gated as I1–I4
  (`1499837`/`b68cebf`/`ecb1c92`/`1bdf12d`). **The UI needs no change — it already reads `readHistory`.**
  Full "why" + provenance model in [[decisions]] "History backfill on add"; the endpoint traps in [[gotchas]]
  "CLOB prices-history".
- **I1 `core/price-history.js` (pure, 8 tests):** `prices-history?market=<token>&interval=max&fidelity=1440`
  → `{history:[{t,p}]}`; floor to UTC DATE (raw `t` varies by token → date-floor aligns legs), last point per
  date, forward-fill gaps (flagged), `complete=false` before a leg's first point.
- **I2 `lib/backfill-record.mjs` (7 tests):** per day → a `live`-shaped object → the SAME core builders
  (survival/bucket_pmf/binary/touch/categorical) → a VALIDATED record. Backfill provenance: real re-verifiable
  `raw_sha256` (recipe over `midpoint`=historical price, `best_bid/ask=null`, `volume=null`,
  `midpoint_source='clob_price_history'` — exactly the live last-trade shape), confidence **capped at MEDIUM**
  + historical-backfill reason, `snapshot.source.{backfilled,method}`. Markers OUT of `canonicalizeRawInputs`
  → **frozen SpaceX hash untouched**.
- **I3 `lib/backfill.mjs` (5 tests):** orchestrator, I/O injected (serve-market pattern). `fetchBackfillMeta`
  REUSES the live gamma meta parsers (now `export`ed from `core/fetch.js`, additive). One bad leg/day never
  aborts; fatal → market `failed`, never throws; status pending→done/failed + earliest date.
- **I4:** bearer-guarded **`/api/backfill`** (timing-safe CRON_SECRET, fails closed; ACK **202** + run in
  `after()` for its own budget; `?wait=1` = synchronous summary) + `addMarket` fire-and-forgets it (user sees
  the market instantly; trigger failure never affects the add) + **migration 0008** (`market_history.source`
  cron|backfill; `markets.backfill_status`/`backfilled_through`) + `writeBackfillRow` (INSERT, unique-conflict
  = no-op → **cron precedence**, never clobbers a captured row) + `setBackfillStatus`. **middleware excludes
  `/api/backfill`** from session auth (the bearer-route gotcha — applied, not re-discovered).
- **OFFLINE GATES GREEN:** node --test **255/255** (+20), **SpaceX parity 3/3**, tsc clean, next build clean
  (`/api/backfill` registered). No `core/fetch.js` behavior change (only `export`s).
- **✅ LIVE GATE — DONE** (steps kept for re-run): (1) **migration 0008** applied to dev; (2) **CRON_SECRET**
  set in `.env.local`; (3) single clean dev server; (4) backfill via UI add or
  `curl -H "Authorization: Bearer $CRON_SECRET" ".../api/backfill?id=<slug>&wait=1"` → `{written, failed, days}`;
  (5) `market_history` has `source='backfill'` rows + `markets.backfill_status='done'`/`backfilled_through`;
  (6) detail populates from real backfilled history. All green — see the ✅ bullet at the top of this entry.
  **⚠ PROD-STANDUP now also needs migration 0008 applied + CRON_SECRET** (CRON_SECRET was already required for
  the daily cron). Migrations to apply at standup: **0001–0008**.
- **NEXT:** wire the daily cron (`/api/snapshot`) to RETRY `backfill_status IN ('failed', null)` markets — the
  columns exist for it; optional UI "backfilling history…" signal from `backfill_status`. Then Phase 4-style
  polish (the touch range-bar narrow-band nit was already fixed in Phase 4). A possible perf optimization: the
  detail now reads up to 365 full `record` JSONBs for the chart — the Δ/mover/velocity/dispersion derivations
  only need a handful of horizon records + lean {date,value} for the chart, so a leaner history read could be
  split out later if detail-load latency becomes a concern.

## ⮕ DIRECTION (2026-06-25): Phase 4 — LAYOUT FIXES (Bug A width-fill + Bug B touch labels) — MERGED to main (`--no-ff` `782cbed`)
- **MERGED** (`782cbed`; **235/235** on merged main; parity 3/3; tsc + build clean). **NOT yet pushed.**
- **Bug A — detail not filling width:** `.detail-view` was capped at `max-width: 920px`, leaving the right of
  the `1fr` detail grid area empty on wide monitors (`.detail` itself was always full — the cap was on the
  content). Now `width: 100%` so it fills at any width; the narrative prose keeps a `max-width: 80ch` for
  readability. **Playwright-verified** (forcing `.terminal` width, since the MCP browser is a maximized window
  that ignores `setViewportSize`): at 1280 → detail 1016 / view 986; at 1920 → detail 1656 / view 1626; only the
  ~30px padding gap remains (was a ~1376px gap at 2560). `maxWidth: none`.
- **Bug B — touch range-bar label overlap (Phase 4):** new pure `lib/touch-rangebar.rangeBarLayout` — when the
  implied band is **< 20% of the axis** (`NARROW_FRAC`), stack the labels (hi ABOVE y=16, lo BELOW y=72, centred,
  edge-hugging anchor at the extremes) instead of the colliding above-left/above-right; wide bands keep the
  original layout. Unit-tested (`test/touch-rangebar.test.js`, 6 cases incl. the 20% boundary). **Playwright-
  verified on two real narrow markets** — WTI `$67.24–$90.00` + Silver `$56.00–$80.00`, both `data-narrow="true"`,
  hi/lo bounding boxes do NOT overlap. (Both live touch markets happen to be narrow — exactly why the overlap
  showed in screenshots; the wide path is the unchanged original layout, covered by the unit tests.) 0 app
  console errors.
- **⚠ The two-`next dev`-on-one-`.next` trap RECURRED** (two server pairs running → :3001 hung, curl 000). Fixed
  per the [[gotchas]] entry: killed all `next` procs, `rm -rf .next`, started ONE on :3001. **Keep a single dev
  server.** (A clean single server is running now, PID pair `next dev`+worker.)
- **NEXT:** **operator wants to DISCUSS the history-backfill architecture before any further build.** Do not start
  Phase 3-real-data or anything new until that conversation. Also still pending: **push `main` to origin**
  (4+ commits unpushed: Phase 3 + its docs + these layout fixes).

## ⮕ DIRECTION (2026-06-25): Phase 3 — HISTORY ANALYTICS — MERGED to main (`--no-ff` `7d0485c`); live gate GREEN
- **MERGED** (`7d0485c`; clean topology — main was an ancestor of `feature/phase3-history-analytics`, no cron
  race; **229/229** on merged main; **SpaceX parity 3/3**; tsc + build clean). **NOT yet pushed to origin.**
- **✅ PLAYWRIGHT LIVE GATE GREEN** (operator seeded + clean single dev `:3001`; I drove the browser): all four
  fixtures render their exact state — FULL ladder velocity `rising` + dispersion `converging −40%` + Δ columns
  (>$2T row **+1.0 / +7.0 / +30.0**) + Biggest Movers **>$2T/+30, >$2.5T/+24, >$3T/+15** (ranges 40→70 / 21→45 /
  5→20); VELOCITY-ONLY (18d) dispersion `Collecting 18/30` + Δ30d **"—"**; COLLECTING (4d) both cards collecting +
  Δ7d/Δ30d **"—"**; BINARY velocity `rising +6.0pp` + dispersion `n/a` + no ladder/movers; the 7D/30D/90D/ALL
  toggle re-renders (7D→8 pts, 30D/90D/ALL→31). **0 app console errors** (the only console errors were external
  noise from other tabs — google.com / polymarket.com / gamma-api 401 / cloudflareinsights CSP — none from
  `localhost:3001`). Screenshot `phase3-full-ladder-detail.png`.
- **What (commit `ae970ae`):** wired the already-tested `deriveDeltas`/`deriveBiggestMoves` (pure, in
  `lib/market-history.mjs` since Phase 1) into the **ladder detail** + a **dev history seeder**, so the
  Phase 3 analytics render NOW instead of waiting weeks for the daily cron. **The UI switches to real cron
  data automatically once rows accrue — no code change at that point** (the detail already reads `readHistory`).
- **UI (`MarketDetailView.tsx`):** the "All thresholds" table gains **24h/7d/30d Δ columns** (`DeltaCell` →
  signed percentage points, `is-up`/`is-down` colour, **"—" for a horizon with no matching day — never a fake
  0**) + a **Biggest Movers** section (top-3 thresholds by |ΔP(>X)| over 30d, explicit collecting state < 2
  days). **Survival/PMF only** — binary/touch/categorical views ignore the new props. Velocity/dispersion
  cards + the 7D/30D/90D/ALL `HistoryChart` were ALREADY wired in Phase 1 → they populate from the same
  seeded series with no new code. New pure formatters `fmtDeltaPp`/`deltaSign` in `format-detail.mjs`.
- **Seeder (`scripts/seed-history-dev.mjs`):** 4 fixtures exercising ALL three display states — **full ladder
  (31d)** = velocity ok + dispersion ok (converging) + Δ all horizons + movers; **binary (31d)** = velocity ok,
  dispersion n/a; **velocity-only ladder (18d)** = velocity ok, dispersion collecting, Δ30d "—"; **collecting
  ladder (4d)** = both collecting, only Δ24h. **⚠ Kept OPEN but with `cached_at`/`last_checked_at` anchored to
  the FUTURE** so `serveMarket` SERVE_FRESHes from cache with ZERO network (synthetic ids have no live gamma) —
  see the new [[gotchas]] entry. Pure generators exported + `run()` guarded → importing is side-effect-free.
- **OFFLINE GATES GREEN:** node --test **229/229** (+13: 3 formatter, 10 `test/seed-history-fixture.js` that feed
  the seed's EXACT rows through the real derive fns → the Δ/mover/state values the Playwright gate asserts are
  proven with no DB), **tsc clean**, **next build clean**. **No core/ change → frozen SpaceX parity 3/3
  byte-identical.** Markets without seeded history degrade to "—" Δ + collecting movers (verified).
- **✅ LIVE GATE — DONE (steps kept for re-run; the seed is operator-run, dev service key isn't in Claude's env):**
  (1) `SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/seed-history-dev.mjs` (auto-loads `.env.local`);
  (2) **single** clean dev server (`rm -rf .next && npm run dev`; the two-servers-one-`.next` 500 trap);
  (3) Playwright the 4 fixtures (`/?m=dev-hist-{ladder-full,binary-full,ladder-vel,ladder-coll}`). All green —
  see the ✅ bullet at the top of this entry.
- **NEXT:** **push `main` to origin** (not yet done), then **Phase 4 polish** (the only standing UI nit: touch
  range-bar label overlap on narrow bands). Real cron history accrues from 02:00 UTC → the same sections light
  up for live OPEN markets with no further work; verify once ≥7 real days exist (velocity) then ≥30 (dispersion).

## ⮕ DIRECTION (2026-06-25): Phase 2 — Bug 3 + Bug 6 (NEAR SETTLEMENT) — MERGED to main (`--no-ff` `4a36229`)
- **MERGED & PUSHED** (`4a36229`; clean topology; **209/209** on merged main; **SpaceX parity 3/3**;
  tsc clean; pushed `9c4e4b8..4a36229`). Branch `feature/i5-confidence-near-settlement` (rebased onto the
  post-history main, then merged).
- **Bug 3 — NEAR SETTLEMENT** (`core/confidence.nearSettlement`: expiring ≤7d AND >50% rungs pinned ~0/~1):
  now on BOTH the survival/bucket **ladder** path (`core/snapshot.js` computes it from the adjusted curve +
  days-to-expiry, sets `derived.near_settlement` **omitted-when-false**) and the touch path. Amber `◐ NEAR
  SETTLEMENT` badge on every detail view. **Confidence recalibration CONFINED to the near-settlement path**
  (`expected = settled || nearSettled`): large monotonicity adjustments, closed rungs, last-trade legs are the
  EXPECTED signature of a winding-down book → no longer drag a liquid market to LOW; a genuinely skipped rung
  (no price) STILL penalizes. **Parity-safe: SpaceX (~18mo out → false) byte-identical, incl. confidence.**
- **Bug 6 — settlement-consensus view** (`SettlementConsensus.tsx` + `format-detail.settlementZone`): near
  settlement the ladder detail REPLACES the (signal-less 1→0 step) distribution with the converged zone (the
  max-mass bucket) as an amber band on the strike track. TDD'd (settlementZone above/below/between/empty).
- **Bug 5 + 7 + 8 — MERGED** (`--no-ff` `e674a23`; 215/215; parity 3/3; display-only). Bug 5: ladder median
  shows `< $lowest`/`> $highest` (not n/a) when the CDF doesn't cross 50% (`format-detail.impliedMedianLabel`).
  Bug 7: titles fall back to a humanized slug (`displayTitle`/`titleFromSlug`) across all 4 detail views + rail.
  Bug 8: Tier-1 analytics never show bare dashes — "Requires history — collecting" + per-card collecting states.
- **Enh 6 signup form — MERGED** (`--no-ff` `5f11cb0`; 215/215). `/signup` invite-acceptance (anon client;
  the 2b.2 allowlist hook is the gate, already gate-proven), cross-linked with `/login`; middleware treats
  `/signup` as an auth route. **⚠ Operator live-gate:** on dev, signup with a fresh ALLOWLISTED email → into the
  app; a non-allowlisted email → "invite-only" message (the hook fails closed).
- **Enh 8 keyboard nav — MERGED** (`--no-ff` `b2430c4`; 215/215; **Playwright-green on dev :3001**, 0 console
  errors). Client-only `kbd.ts` event bus + global `KeyboardShortcuts` (layout): J/↓ K/↑ (rail focus cursor),
  Enter (open), R (refresh), H (verify hash), Esc (close search/deselect), ? (legend); ⌘K stays search's own.
  Typing + modifier combos never hijacked. **NOTE for future Playwright gates: the dev session cookie on :3001
  was already live → no password needed; `.env.local` is readable for dev creds when login IS required (never
  commit values — a pre-commit hook blocks them).**
- **Enh 1 + 4 + 5 — MERGED** (`--no-ff` `13512b9`; 216/216; parity 3/3; presentation-only). Enh 1: CDF gradient
  fill + median-crossing dot + hover tooltips (CDF dots + density bars incl. volume). Enh 4: binary YES
  probability meter + spread indicator + prominent resolves date + strong-consensus read. Enh 5: search proxy
  classifies each result's TYPE server-side (same `marketShapeFromMarkets`) + category tag + human volume
  (`fmtVolHuman`) → shape legible before add, categorical distinguished.
  **Visual Playwright spot-check DONE** (2026-06-25, clean single `:3000`): search type chips + categorical-amber +
  human volume ✓; CDF gradient + 14 dot / 15 bar tooltips ✓; binary meter + spread + consensus ✓. 0 console errors.
- **Enh 2 + 3 + 7 — MERGED** (`--no-ff` `f1b9596`; 216/216; **Playwright-green** on clean `:3000`). Enh 2: rail
  volume tint + confidence circle dots + near-settlement clock + binary Y/N chip (market-scan surfaces volume +
  near_settlement). Enh 3: narrative moved AFTER the distribution (header→headline→trust→distribution→narrative→
  analytics). Enh 7: loading state names the verified-pipeline work + indeterminate progress bar.
- **✅ PHASE 2 COMPLETE** — Bugs 3/5/6/7/8 + Enh 1–8 all merged to main. Suite 163 → 216, every step parity-gated.
- **⚠ DEV ENV:** there were TWO `next dev` sharing one `.next` (→ webpack-runtime 500 + stale-404 corruption, the
  documented gotcha). Cleaned up: killed both, `rm -rf .next`, started ONE clean server on :3000 (still running).
  Going forward keep a SINGLE dev server.
- **NEXT: Phase 3 — v1-parity** (delta columns in the threshold table, biggest movers, POPULATED velocity/
  dispersion) — **HARD-GATED on real history rows accruing** from the daily cron (02:00 UTC; velocity ≥7d,
  dispersion ≥30d). To build/demo before then, write `scripts/seed-history-dev.mjs` to seed fixture
  market_history rows. Then **Phase 4** polish. (Touch range-bar label overlap on narrow bands still pending.)

## ⮕ DIRECTION (2026-06-25): Phase 1 + 1b — HISTORY SYSTEM + CATEGORICAL — MERGED to main (`--no-ff` `9e9b1b1`)
- **MERGED & PUSHED** (`9e9b1b1`; clean topology — main was an ancestor of `feature/history-system`, no cron
  race; **194/194** on merged main; **SpaceX parity 3/3**; tsc + next build clean; pushed `b1be34e..9e9b1b1`).
- **Phase 1 LIVE-GATE GREEN** (operator ran `verify-history.mjs`): NEG 401s, POS batch ran **5/5 markets
  success, 0 failed**, history rows landed + re-hash, collecting state shown, **anon RLS = 0 rows**. Migrations
  **0006** (market_history) + **0007** (categorical kind) APPLIED to dev. **PROD-STANDUP now needs 0001–0007 +
  CRON_SECRET** (Vercel Preview+Production).
- **⚠ Live-gate bug found + fixed (`ef723ff`):** the auth middleware matcher caught `/api/snapshot` and only
  excluded `/api/market`, so the bearer-authed cron route was being session-redirected to /login (returned login
  HTML, not batch JSON). Fixed: `/api/snapshot` joins `/api/market` as a non-session API (its CRON_SECRET bearer
  is the gate). **This is exactly why the live gate exists** — it would have silently broken every prod cron run.
- **Phase 3 is now UNBLOCKED once real history accrues** (the daily cron at 02:00 UTC writes rows; velocity
  populates after 7 days, dispersion after 30, trends chart as data grows). To demo the populated UI before then,
  seed fixture `market_history` rows.
- **NEXT: Phase 2 — Bug 3 (NEAR SETTLEMENT) FIRST, on its own branch** (work already started on
  `feature/i5-confidence-near-settlement` — reconcile/continue there or branch fresh off the new main). Then
  Bug 5 (median `<lowest`/`>highest`), Bug 6 (settlement view), Bug 7 (titles), Bug 8 (analytics collecting),
  Enh 1–8, signup form, keyboard nav → Phase 3 (v1-parity, history-gated) → Phase 4 polish.

## ⮕ DIRECTION (2026-06-25): Phase 1b — CATEGORICAL MODEL — DONE on `feature/history-system` (live-verified)
- **Categorical markets now COMPUTE** (was a 422 gate). `core/categorical.js` (de-vig
  `normalizeProbabilities`, `shannonEntropy`, `consensusStrength`, `scoreCategoricalConfidence`,
  `buildCategoricalRecord`) + `core/fetch.js` `fetchCategoricalMeta/Status/Snapshot` (YES-leg PMF
  via the shared Phase-1 fallback chain) + `computeCategoricalRecord` (route in `compute.mjs`,
  replacing the 422). **RAW observed midpoints stay in raw_inputs (threshold=leg index); de-vig is
  display-only → hash recipe UNCHANGED** (constraint #2). schema.json categorical `allOf` branch +
  `validate.js` skip + **migration 0007** (kind check) + methodology.json recipe doc.
- **`CategoricalDetailView.tsx`** (dominant headline + entropy consensus meter + SVG outcome bars +
  volume table + trust/hash-verify + trend chart), routed in MarketDetailView; HistoryChart treats
  categorical as a 0–100% dominant-prob axis. `market-history` fineKind/headlineValue/dispersion updated.
- **LIVE-VERIFIED** (`node scripts/verify-categorical.mjs`, network-only, no DB): `how-many-fed-rate-cuts-in-2026`
  → 13 outcomes sum 1.0, dominant "0 (0 bps)" 80%, entropy 0.291→HIGH, hash re-verifies. **SpaceX parity 3/3.**
  node --test **194/194** (+13), tsc clean, next build clean. Commit `e916207`.
- **⚠ OPERATOR:** apply **migration 0007** to DEV (+ PROD at standup). Categorical adds to watchlist via
  search now (no error). `scripts/verify-categorical.mjs` runnable anytime (no creds).
- **NEXT:** Phase 2 (I5+ bug cluster: Bug 3 NEAR SETTLEMENT [started on `feature/i5-confidence-near-settlement`],
  Bug 5 median labels, Bug 6, Bug 7 titles, Bug 8 analytics-collecting, Enh 1–8, signup, keyboard) → Phase 3
  (v1-parity, HARD-GATED on real history rows) → Phase 4 polish.

## ⮕ DIRECTION (2026-06-25): Phase 1 — HISTORY SYSTEM — CODE DONE on `feature/history-system` (live gate pending operator)
- **Why:** the multi-market product computes on demand + caches ONE snapshot, so every
  velocity/dispersion/trend card was empty (v1 SpaceX showed them from a stored daily series).
  This is the foundational unlock for the whole Phase-3 v1-parity roadmap. **Branch off `main`**
  (independent of + sequenced before the in-flight Bug 3 work on `feature/i5-confidence-near-settlement`).
- **Backend (`deb0e8b`):** migration **0006** `market_history` (one row/market/UTC day, upsert on
  `(market_id,snapshot_date)`); **RLS deny-all, MIRRORS market_snapshots** — service role is the only
  reader (operator-confirmed choice; NOT the prompt's authenticated-policy variant — the prompt
  self-contradicted, see the AskUserQuestion decision). `lib/market-history.mjs`: pure derive fns
  (`linregSlope`, `deriveVelocity` ≥7d, `deriveDispersion` ≥30d, `deriveDeltas`, `deriveBiggestMoves`)
  + server-only I/O (`allWatchedMarketIds`, `writeHistory`, `readHistory`, `marketsSnapshottedOn`).
  **Sub-minimum series → explicit `{status:'collecting'}`, never dashes/fabrication.** `app/api/snapshot`
  cron route: **TIMING-SAFE CRON_SECRET Bearer** (Vercel dispatcher pattern, Context7-verified), **FAILS
  CLOSED** if secret unset; one bad market never stops the batch; RESOLVED skipped (frozen); dedup guard.
  `vercel.json` crons `0 2 * * *`. `scripts/verify-history.mjs` = the live-gate harness.
- **UI (`75dc227`):** `HistoryChart.tsx` (client island, hand-rolled SVG, 7D/30D/90D/ALL toggle, binary
  0–100% axis vs value-range axis, <2 pts → "Collecting history") + `TrendHistory.tsx` (shared section
  — extracted to break the MarketDetailView⇄Binary/Touch import cycle — velocity+dispersion cards with
  collecting states) rendered on **all three** detail views. `readHistory` wired into the detail Server
  Component; lean `{date,value}` series only — heavy record JSONB never ships to client.
- **Additive — touches NO compute path. SpaceX `raw_sha256` byte-identical (parity 3/3).** Offline gates
  ALL GREEN: **node --test 181/181** (+18 new `test/market-history.test.js`), **tsc clean**, **next build clean**.
- **⚠ OPERATOR LIVE GATE (the "done" criteria I can't run — needs the console + dev creds):**
  (1) apply **migration 0006** to DEV Supabase (`dxoyxjxcfbgygvjvrrfk`); (2) set **CRON_SECRET** in
  `.env.local` (and Vercel Preview+Production at standup); (3) `rm -rf .next && npm run dev` (:3001);
  (4) run `BASE_URL=http://localhost:3001 CRON_SECRET=… SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=…
  NEXT_PUBLIC_SUPABASE_ANON_KEY=… node scripts/verify-history.mjs` → expect NEG 401s, POS batch summary,
  rows in `market_history`, anon-RLS 0 rows, deriveVelocity 'collecting'. To prove the chart/cards
  DISPLAY before 7 real days exist, seed fixture history rows. **PROD-STANDUP now also needs 0006 + CRON_SECRET.**
- **NEXT (sequenced):** Phase 1b categorical model → Phase 2 (I5+ bug cluster, incl. the Bug 3 NEAR
  SETTLEMENT work already started on `feature/i5-confidence-near-settlement`) → Phase 3 v1-parity
  features (**HARD-GATED on real history rows existing**) → Phase 4 polish. Full roadmap in the session prompt.

## ⮕ DIRECTION (2026-06-24): Market-type redesign — 5 shapes routed correctly — MERGED to main
- **MERGED** (`--no-ff` `8db0251`; clean topology, no cron race; **163/163** on merged main; SpaceX
  `raw_sha256` byte-identical — parity GATE 1 green). The P0 cluster (Bugs 1/2/4) is fixed AT THE ROOT:
  the pipeline no longer forces every multi-leg `$` market through the survival ladder.
- **5 shapes** — `core/fetch.js marketShapeFromMarkets`/`classifyMarketShape` → `computeMarketRecord`
  routes `binary | survival | bucket_pmf | directional_touch | categorical`, classified from gamma
  question text BEFORE any threshold parse (`kindFromMarkets` kept for the binary gate + its tests):
  - **survival** (SpaceX "above $X") — unchanged, pinned, frozen-hash.
  - **bucket_pmf** (Bitcoin/Anthropic "between $X and $Y") — `core/bucket.js`: parse intervals → de-vig
    PMF → derive survival curve + PMF mean (`computeBucketPmfRecord`). Stored kind `threshold_ladder`
    (NO migration), renders via the ladder detail view. **Bitcoin $60.98K, Anthropic $1.69T** (was
    $T / $54T). The "not IPO" categorical leg is excluded with a count.
  - **directional_touch** (WTI/Silver "(LOW)/(HIGH) hit $X") — `core/touch.js` (pure, parse+range) +
    `core/touch-record.js` (builder) + `computeTouchRecord` + `components/zones/TouchDetailView.tsx`.
    NO median — the implied 50%-crossover RANGE. **WTI $66.73–$90.00.** New `kind='directional_touch'`
    (schema `allOf` branch + migration 0005). raw_inputs use SIGNED synthetic thresholds (canonicalize
    unchanged).
- **Units (Bug 1):** `core/money.js` parseMoney (commas + K/M/B/T → absolute $) + deriveUnit; thresholds
  stored as MANTISSAS in the derived unit; detail (`unitFromLadder` now T/B/M/K/bare-$) + rail
  (`market-scan.headlineDisplay` reads the record's labels) + narrative read each market's OWN unit —
  no more "$T on everything". $T still routes through `fmtT` so the SpaceX rail string is byte-identical.
- **⚠ MIGRATION 0005** (`0005_directional_touch.sql`): widens `markets_kind_check` to add
  'directional_touch'. **APPLIED to DEV.** bucket_pmf needs none. **PROD-STANDUP now requires
  `0001`+`0002`+`0003`+`0004`+`0005`.**
- **GATE-PROVEN:** 163/163 + frozen-hash parity GATE 1 + tsc clean; live `/api/market` serve (compute →
  Supabase cache WRITE → read) for Bitcoin (bucket) + WTI (touch, post-0005); **Playwright** (dev :3001,
  `DEV_LOGIN_PASSWORD`): Bitcoin bucket detail = $60.98K full distribution, WTI touch detail = TOUCH
  MARKET badge + $66.73–$90.00 range + touch table + range bar, rail shows the WTI range — **0 console
  errors** (favicon 404 only).
- **⚠ Vercel posture UNCHANGED** — production stays erroring pre-standup (fails-closed 500). Expected.
- **⚠ Stale cache (cosmetic, NOT a bug):** watchlist rows computed by the OLD pipeline show bare-$
  medians in the rail until recomputed; every NEW compute is correct.
- **Roadmap:** `MARKET-TYPES-PLAN.md` (delete when the epic fully lands). **NEXT: I5+** — Bug 3
  (confidence recalibration + NEAR SETTLEMENT state), Bug 5 (ladder "< lowest" / "> highest" median
  labels), Bug 6 (near-settlement settlement view), Bug 8 (analytics "requires history"), Bug 7 (titles
  polish) + Enhancements 1–8 + signup form (Enh 6) + keyboard nav (Enh 8). Minor polish: touch range-bar
  labels overlap when the band is narrow. Backup branch `feature/p0-parser-units-mean` retained.

## ⮕ DIRECTION (2026-06-24): Categorical detection + UI polish — MERGED to main
- **Categorical market detection: MERGED** (`--no-ff` `174cab0`; 136/136). `core/fetch.kindFromMarkets`
  now classifies **binary / ladder / categorical** from the event shape (multi-leg + first leg's question has
  no numeric `$threshold` → categorical). `computeMarketRecord` routes categorical to a **friendly 422**
  ("This market uses categorical outcomes — numeric threshold or binary markets only") **before** any parsing,
  so the raw "Cannot parse threshold" error never reaches the UI (it surfaces in the search overlay via the
  add flow). Binary + ladder paths unaffected; frozen SpaceX parity intact. (NB: a `$`-valuation ladder like
  Anthropic still classifies 'ladder' and computes.)
- **Detail UI polish (4 items): MERGED** (`--no-ff` `6b893ec`; 137/137; presentation-only, backend untouched):
  (1) **Distribution axes** — CDF gets a Y probability scale (0/25/50/75/100% + hairline grid) + a rotated X
  threshold label at every rung; density gets rotated X bucket labels; the median marker has an explicit text
  label (`.dist-tick` token). (2) **Analytics always renders** — real cards (`—` per null field) OR an
  "Analytics pending — insufficient history" state; never silently absent. (3) **Refresh button** in the
  detail header → `refreshMarket` server action force-recomputes (bypasses TTL) + writes, then
  **`revalidatePath('/', 'page')` — DETAIL ONLY, not the layout** (rail not re-fetched). (4) **Timestamps →
  America/New_York** via `lib/format-detail.fmtEastern` (Intl `timeZoneName:'short'` → EST/EDT, DST-safe; the
  detail "As of" in both ladder+binary views). Display-only — DB / raw_inputs / raw_sha256 stay UTC.
- **⚠ Vercel posture UNCHANGED** — production stays erroring pre-standup (fails-closed 500). Expected.

## ⮕ DIRECTION (2026-06-22): Market-type work — Phase 1 (midpoint fallback) + Phase 2 (BINARY) MERGED
- **Phase 2 — BINARY (Yes/No) market support: MERGED to `main`** (`--no-ff` `a09610a`; no cron race).
  **135/135 on merged main; frozen SpaceX `raw_sha256` byte-identical** (ladder path untouched). Single Yes/No
  markets (gamma `event.markets.length === 1`) now compute alongside ladders.
  - **Detection:** `core/fetch.classifyMarketKind(slug)` — one gamma GET **before** any threshold parse (the
    parser throws on a binary question, so detection must precede it). `computeMarketRecord` branches to
    `computeBinaryRecord` → `core/binary.buildBinaryRecord` + `scoreBinaryConfidence` (spread/volume/fallback;
    no ladder math). `derived = { kind:'binary', probability, probability_no, confidence, total_volume,
    narrative, freshness }`.
  - **Provenance:** reuses `canonicalizeRawInputs` UNCHANGED (synthetic threshold 1=YES/0=NO sort key) — same
    hash recipe, binary content. Phase-1 midpoint fallback applies per token (resolver extracted to a shared
    `resolveFromBook`/`fetchLastTradePrice`).
  - **Schema:** single discriminated `schema.json` (`if kind:'binary' then …, else` the unchanged ladder
    `required` — SpaceX validates identically); `validate.js` skips `bucketErrors` for binary.
  - **UI:** `BinaryDetailView` (probability hero, trust band + hash-verify, **no SVG/ladder**); `MarketDetailView`
    branches on `kind`; rail shows the **probability %** headline (binary) vs **$median** (ladder), via a
    kind-aware `lib/market-scan` + `markets.kind`.
- **⚠ MIGRATION 0004 (the one schema change Phase 2 needed — my plan's "no migration" was WRONG):**
  `0004_phase2_binary.sql` widens `markets_kind_check` from `('threshold_ladder')` to
  `('threshold_ladder','binary')` (the binary probability reuses the **`implied_median` column** — that part
  needed no migration). **Applied to DEV.** The CHECK violation was caught in the Playwright gate (add error
  surfaced, not swallowed), fixed, re-run green. **PROD-STANDUP now requires `0001`+`0002`+`0003`+`0004`.**
- **⚠ Vercel posture UNCHANGED** — production still erroring pre-standup (fails-closed 500). Expected.
- **GATE-PROVEN:** node `scripts/verify-phase2-binary.mjs` (detection · binary compute · verify-ready hash ·
  ladder no-regression on live US-recession + WTI) + 135/135 + frozen-hash parity + tsc + build;
  **Playwright** (⌘K→search→add a real binary → rail **11%** headline → binary detail → **hash-verify ✓ VERIFIED
  in-browser** → SpaceX ladder full-distribution no-regression → 0 console errors).
- **⚠ Noted for a future parse-hardening pass (still NOT done):** the `$X` threshold parser collapses
  comma/repeated levels to duplicate thresholds (WTI monthly two rung-90). Computes fine; separate from binary.

## ⮕ DIRECTION (2026-06-22): Market-type work — Phase 1 (midpoint fallback) MERGED
- **Phase 1 — CLOB midpoint fallback: MERGED to `main`** (`--no-ff` `502933b`; no cron race). **133/133 on
  merged main.** A missing `/midpoints` value no longer fails the whole market — `core/fetch.js fetchLiveSnapshot`
  now resolves each rung via `clob_midpoint → bid_ask_mean → best_bid/best_ask → last_trade → skip → fail-all`.
  Measured truth: a missing midpoint = an EMPTY book (no bid/ask), only a last-trade price (deep ITM/OTM rungs).
  `raw_inputs` records `midpoint_source` (+ `last_trade_price`) — **NOT** in `canonicalizeRawInputs`, so the hash
  recipe is untouched and **frozen SpaceX `raw_sha256` is byte-identical** (`c1be52e4…b89003`, parity gate proves it).
  Confidence degrades via a `midpoint_fallback` signal ("N rung(s) priced from last trade…"). Silver+WTI weekly/
  monthly now compute (1/3/5 last-trade rungs, honestly low confidence). See [[gotchas]] + `core/confidence.js`.
- **⚠ Noted for a FUTURE parse-hardening pass (NOT done):** the `$X` threshold parser collapses comma-formatted
  or repeated levels to duplicate thresholds (WTI monthly had two rung-90; the 2c.3 detail key bug was the same
  family, fixed in `b08b1b1`). Computes fine; just coarser. Out of scope for the midpoint fix + binary work.
- **Next: Phase 2 — BINARY market support** (single Yes/No markets, not threshold ladders). Plan first.

## ⮕ DIRECTION (2026-06-22): Phase 2c.4 (search + add, Zone 3) — DONE & MERGED · 2c DASHBOARD COMPLETE
- **Where:** **MERGED to `main`** (`--no-ff` merge `b77e8a1`; main an ancestor of `feature/phase2c4-search-add`,
  no cron race). **132/132 on merged main.** `main` now reflects **2a+2b+2c.1+2c.2+2c.3+2c.4** — the **three-zone
  dashboard is functionally complete** (rail · detail · search/add/remove). Backend/auth/schema untouched (no migrations).
- **⚠ Vercel posture UNCHANGED** — production stays erroring **pre-standup** (fails-closed 500, Production env
  deliberately empty). Pushing 2c.4 does NOT change that; the auto-built prod deploy from `main` keeps failing — expected, don't touch.
- **What:** Zone 3 = the command-bar search + the load-bearing **compute-then-add** flow + remove-from-rail.
  - **Search:** `app/api/search/route.ts` proxies gamma `public-search` server-side (CORS-safe, normalized to
    `{slug,title,closed,active,volume}`). `MarketSearch.tsx` (client island in CommandBar): **⌘K** activate,
    debounced fetch, ↑/↓/Enter/Esc, click-outside, add-scope picker (Personal + RLS-scoped orgs).
  - **Compute-then-add** = **server actions** (`app/(app)/actions.ts`): `addMarket` runs `serveMarket` (service-role
    DEPS — the COMPUTE populates `markets`+`market_snapshots` via writeRecord), THEN `addPersonal`/`addOrg`
    (cookie-bound user client, RLS), THEN **`revalidatePath('/', 'layout')`** → the rail (layout Server Component)
    re-renders. Client auto-navigates `?m=<slug>` → detail opens. `MarketNotInCatalogError` surfaced (the FK guard,
    not the happy path); compute 404 → "not a supported threshold-ladder market" (e.g. a market with a non-`$X` leg).
  - **Remove:** `removeMarket` action + hover **×** on each rail row. `lib/market-scan` now carries `org_id` per row.
    **Dual-scope ×** drops PERSONAL — the row STAYS via org with only the ORG chip; a second × (org-only) removes it.
- **GATE-PROVEN:** node `scripts/verify-2c4-search-add.mjs` (search · **MarketNotInCatalogError guard** ·
  **compute side-effect: market_snapshots row exists after add** · add/list/remove) + no-regression (phase2a 12/12,
  rail, detail). **Playwright:** ⌘K → search → **live compute-then-add** of a real Bitcoin market (appears in rail
  post-revalidate + detail auto-opens — the live falsification, a genuinely new snapshot row) · add-error surfaced ·
  **dual-scope remove stays-via-org** · 0 console errors · 1280px screenshot. 132/132 + tsc + build clean.
- **⚠ Gotcha hit + fixed (`b08b1b1`, a latent 2c.3 bug):** the detail keyed distribution dots/density bars/ladder
  rows by `m.threshold`/`b.label` — unique for SpaceX but NOT for an arbitrary market (a Bitcoin price ladder parses
  two legs to the same threshold → two `>$56` rows → React "two children with the same key"). Fix: **index-safe keys**.
  Only 2c.4's search→add of an arbitrary market could expose it. (Same family as the 2c.3 SVG-hydration trap.)
- **Next (post-2c, deferred fast-follows):** the **signup / invite-acceptance form** (the dashboard is login-only);
  the **prod-standup checklist** (below) to take production live; optionally a **history endpoint** if the cut
  trends/Δ/movers sections are wanted back in the detail. The core 2c product is done.

## ⮕ DIRECTION (2026-06-22): Phase 2c.3 (market DETAIL, Zone 2) — DONE & MERGED to main
- **Where:** **MERGED to `main`** (`--no-ff` merge `251a853`; main an ancestor of `feature/phase2c3-detail`,
  no cron race). **132/132 on merged main.** `main` now reflects **2a+2b+2c.1+2c.2+2c.3**.
  Backend/auth/schema/rail **untouched** (the one edit to `app/api/market/route.ts` is the shared-DEPS
  extraction — behavior-identical, `verify-phase2a` 12/12 covers it).
- **⚠ Vercel posture UNCHANGED** — production stays erroring **pre-standup** (fails-closed 500, Production
  env deliberately empty). This push auto-builds a **failing prod deploy from `main`** — expected, don't chase/touch.
- **What:** Zone 2 detail = a PORT+GENERALIZE of `docs/index.html` into the React pane, fed by the rail's
  **`?m=<id>` selection** (read server-side in `app/(app)/page.tsx` via `searchParams`). It runs the
  **AUTHORITATIVE probed serve** for that one market — `serveMarket` called DIRECTLY with the **shared
  `lib/market-deps.mjs` DEPS** (same object `/api/market/route.ts` now imports — no drift, no HTTP hop). This
  is the CORRECTNESS layer (per-call resolution probe), the deliberate opposite of the rail's cached read.
- **Sections (from `record.snapshot.derived` + `record.asset`):** header (asset.name/resolves/market_url),
  TRUST band high (confidence tier+reasons, freshness, provenance sha256 + **in-browser hash-verify**),
  narrative, **distribution SVG** (hand-rolled CDF polyline + median marker + density bars — NO charting dep),
  Tier-1 analytics, current-snapshot ladder table, methodology. **RESOLVED** → prominent frozen-outcome banner
  (served cache-final, no live re-pull). Defensive optional-chaining → a thin record degrades, never throws.
- **⚠ UNIT-AWARE formatter** (`lib/format-detail.mjs`): derives T/B/M scale from the ladder labels so the
  headline reads in the market's own denomination (not hardcoded $T). Velocity delta still rendered verbatim.
- **⚠ HASH-VERIFY**: client `crypto.subtle` over the **server-canonicalized** `raw_inputs`
  (`core/fetch.js canonicalizeRawInputs` reused — can't import client-side, core untouched). Gate proved ✓ verified.
- **CUT (no source in `/api/market` — it carries no history):** trends chart, per-threshold Δ columns, movers.
  Tier-2 scenarios cut (locked scope). History is a future backend addition, not this phase.
- **GATE-PROVEN:** node `scripts/verify-2c3-detail.mjs` (RESOLVED served cache-final · field coverage ·
  verify-ready) + `verify-phase2a` 12/12 + `verify-2c2-rail` (no regression); **Playwright** (full render,
  field-match, **hash-verify → ✓ verified**, RESOLVED banner + `data-lifecycle="RESOLVED"`, SVG CDF+density+
  median marker, states: empty / bogus→error / thin→degrades, 0 console errors, 1280px screenshot);
  **132/132 `node --test`** (+7: 6 format-detail, 1 hash-verify parity) + tsc + build clean.
- **⚠ Gotcha hit + fixed (`b90184d`):** SVG `<text>`/`<title>` with adjacent dynamic+static children
  **mis-hydrate** ("Hydration failed") — consolidate each to a SINGLE template-literal child. (Caught in the
  Playwright gate, distinguished from stale-`.next` 404 noise.) Add to [[gotchas]] if not already.
- **Dev seed** (`scripts/seed-watchlist-dev.mjs`): synthetic OPEN markets are now **FULL records with a REAL
  `hashRawInputs` sha256**, so the in-browser verify passes on them too (not only SpaceX).
- **Next: 2c.4 (search + compute-then-add, Zone 3 in the command bar)** — gamma `public-search`, then
  compute-then-add (`/api/market?id=` populates `markets`, retry the watchlist add) **handling
  `MarketNotInCatalogError`**; also the deferred remove-from-rail wiring + signup form fast-follow.

## ⮕ DIRECTION (2026-06-22): Phase 2c.2 (watchlist RAIL, Zone 1) — DONE & MERGED to main
- **Where:** **MERGED to `main`** (`--no-ff` merge `fd4d1ed`; main was an ancestor of `feature/phase2c2-rail`,
  no cron race — local==origin/main at merge). **125/125 on merged main.** `main` now reflects **2a+2b+2c.1+2c.2**.
  Backend/auth/schema **untouched** (only added `lib/market-scan.mjs`, the two rail components, rail CSS, 2 scripts).
- **⚠ Vercel posture UNCHANGED** — production stays erroring **pre-standup** (the expected fails-closed 500;
  Production-scope env deliberately empty). Pushing 2c.2 to `main` does NOT change that; do not touch prod.
- **What:** Zone 1 rail = a Server Component (`components/zones/WatchlistRail.tsx`) that reads the
  **cache only** — `listVisible()` (RLS-scoped union) → `lib/market-scan.readScan()` for exactly those
  markets. **It runs NO resolution probe**: the rail is a SCAN SUMMARY on the COST layer; the
  authoritative probed serve stays in **Zone 2 / `/api/market`** for the selected market. Dense rows reuse
  existing tokens (`.conf-*`/`.is-*`/`.state-*`/`.is-stale`) — **no new design tokens**. Client freshness
  (live `now`, no hydration mismatch). Selection sets **`?m=<market_id>`** + marks `.wl-selected` — this is
  the handoff **2c.3 consumes server-side**. Suspense skeleton + real empty + caught error states.
- **⚠ KEY ARCHITECTURE DECISION (option b):** the scan fields are **already promoted to `market_latest`
  columns** (`implied_median`/`confidence_tier`/`lifecycle_state`/`is_final`/`stale_after`/`fetched_at`);
  the 24h delta lives in the record JSONB at `snapshot.derived.market.analytics.velocity.change_24h`. So the
  rail reads the cache — **no recompute, NO `/api/market` fan-out** (proven below). Rejected naive N×/api/market.
- **⚠ THE FIREWALL (load-bearing):** `readScan` uses the **service-role** key (RLS-bypassing) but takes
  **NO id list** — ids come ONLY from `listVisible()` and every query is bounded `.in('market_id', ids)`.
  A market the user can't see can't reach the rail even though service-role could read it. Lives in
  `lib/market-scan.mjs` (server-only, `cache.mjs` fence pattern); the heavy `record` is never shipped to the client.
- **GATE-PROVEN:** node gate `scripts/verify-2c2-rail.mjs` GREEN (FIREWALL cross-tenant exclusion · FIDELITY
  scan===market_latest, no drift, `median_display`===`fmtT` · DEDUP dual-scope→one merged row); **Playwright**
  GREEN (3 seeded rows + titles, confidence/lifecycle/delta pills, **STALE pill ONLY on the past-`stale_after`
  row**, ORG chip only on the org row, click→`?m=`+`.wl-selected`, **zero `/api/market` on rail load
  [architecture-falsification]**, 0 rail console errors, 1280px screenshot); **125/125 `node --test`** (6 new) +
  `tsc` clean + `next build` clean. **Empty state + no-regression re-runs (`verify-phase2a` 12/12 +
  `verify-2c1-authgate`) operator-verified separately.**
- **Seed for the rail demo:** `scripts/seed-watchlist-dev.mjs` (dev user: real SpaceX RESOLVED + synthetic
  `dev-rail-open-fresh` + `dev-rail-open-stale`; `.in`-bounded, idempotent). DEV-only fixtures.
- **Next: 2c.3 (market detail, Zone 2)** — reads the **`?m=` selection this phase wired** (server-side
  `searchParams`), fetches `/api/market?id=` (the authoritative probed serve), generalizes `docs/index.html`.

## ⮕ DIRECTION (2026-06-22): Phase 2c.1 (dashboard SHELL) — DONE & MERGED to main
- **Where:** **MERGED to `main`** (2026-06-22, `--no-ff` merge `fd97d8e`; main was an ancestor, no race).
  119/119 on merged main; frozen-hash parity GATE 1+2 reproduce (Option-A behavior-identical).
  `main` now reflects **2a + 2b + 2c.1**.
- **⚠ CODE-ON-MAIN ≠ LIVE-IN-PROD (now with a frontend).** Vercel posture is **unchanged** — previews build
  from branches, **production untouched**, prod Supabase still doesn't exist. Pointing prod Vercel at `main`
  is **blocked** on the prod-standup checklist (below) — it would build the Next app + `/api/market` against
  Production-scoped env that isn't set → middleware loud-check throws. The Option-A import-bundling is already
  in code, so *that* ENOENT mode is prod-safe; the env/Supabase prerequisites are not yet met.
- **PROD-STANDUP CHECKLIST — production goes live ONLY when ALL of these are done:** (1) prod Supabase
  project created w/ `0001`+`0002`+`0003` applied; (2) Before-User-Created hook **enabled** (created-but-
  not-enabled fails OPEN); (3) email-confirmation posture set (prod CONFIRMS, unlike dev); (4) Vercel
  Framework Preset = **Next.js** + `public` Output-Dir override cleared; (5) the **4 env vars**
  (`NEXT_PUBLIC_SUPABASE_URL`/`_ANON_KEY` + `SUPABASE_URL`/`_SERVICE_ROLE_KEY`) set in Vercel **Production**
  scope with **PROD values (NOT dev)**; (6) deployment-protection / app-auth posture decided; (7) re-run all
  gates against prod. Until ALL are done, production must NOT be treated as live.
- **✅ EXPECTED PRE-STANDUP STATE (NOT a bug — do not chase):** `polymarket-tracker-nu.vercel.app`
  (Vercel auto-built a **production** deploy from `main`) returns **500** — the middleware loud env-check
  (`NEXT_PUBLIC_SUPABASE_URL/ANON_KEY missing at runtime`). This is **correct: the gate fails CLOSED**
  because Production-scope env is deliberately **empty** (env vars are Preview-only; prod Supabase doesn't
  exist yet). **Every push to `main` will auto-build a failing production deploy until standup — this is
  fine and expected**, not something to investigate each time. Leave production erroring **as-is**; it
  becomes healthy only after the checklist above. (Confirms "code-on-main ≠ live-in-prod" empirically.)
- **What:** Next.js (App Router) on Vercel wrapping the proven backend — the SHELL only (no zones).
  Auth-gated routing (`@supabase/ssr`, **Node-runtime middleware**), institutional-terminal design tokens
  (IBM Plex Sans/Mono, `app/globals.css`), three empty zone shells (rail / detail / command-bar search).
  `/api/market` relocated to `app/api/market/route.ts` — behavior-identical (same serveMarket + no-store;
  **frozen SpaceX `raw_sha256` unchanged**). Login-only (signup/invite-acceptance = deferred fast-follow).
- **Service-role boundary:** `server-only` fence on `lib/supabase/server.ts`; key never `NEXT_PUBLIC_`;
  `lib/watchlist.mjs` is the lone client-safe lib (used by Client Components).
- **GATE-PROVEN:** local (build + auth negative/positive/logout + `verify-phase2a` 12/12 + 119 tests) AND
  **real Vercel preview build** (`verify-phase2a` 12/12, no ENOENT; `verify-2c1-authgate` unauth→/login).
- **⚠ TWO DURABLE LEARNINGS (now in [[gotchas]] — don't rediscover):**
  1. **Vercel's `@vercel/next` builder does NOT honor `outputFileTracingIncludes`** like `next build`/
     `output:standalone` do — files traced locally were missing from the deployed function (ENOENT).
     **Durable fix applied: bundle `core/` JSON via `import … with { type: 'json' }`** (+
     `core/markets/manifest.mjs` for the old `readdirSync`), so there's **no runtime file read**. Local
     trace/standalone is NOT a faithful proxy for Vercel packaging — bundle data, don't `readFileSync`.
  2. **Stale `.next` runs old middleware/build** — `next dev` ran stale **edge** middleware after a
     `next build` despite `runtime:'nodejs'`. `rm -rf .next` when switching build↔dev or changing
     runtime/config; confirm via `process.env.NEXT_RUNTIME`. (Same stale-artifact family as edge-replay.)
- **Vercel project config:** Framework Preset must be **Next.js** (the old static-site preset's `public`
  Output Directory override broke the build); `vercel.json` has `framework:nextjs` as a lock. Preview
  needs the 4 dev env vars in **Preview** scope. Wall still UP (Protection-Bypass-for-Automation for the
  verify scripts — they read `VERCEL_AUTOMATION_BYPASS_SECRET`, no-op when absent).
- **Next (2c.2 rail now DONE on branch): 2c.3** (market detail, generalizes docs/index.html) → 2c.4 (search +
  compute-then-add, where `MarketNotInCatalogError` is handled). Plus deferred: signup form, prod standup.
- **Backup:** `feature/phase2c1-shell` retained on origin (commit `b9003bc`) as an off-machine backup.

## ⮕ DEV ENVIRONMENT — fresh-context resume facts (2026-06-22)
> A new session needs these to run dev/gates; none are in the code. No secrets here (project ref + emails
> are not credentials; the 4 env-var VALUES live only in Vercel/.env.local, never in this repo).
- **Dev Supabase project:** ref **`dxoyxjxcfbgygvjvrrfk`** (`https://dxoyxjxcfbgygvjvrrfk.supabase.co`).
  All 3 migrations applied (`0001_phase2a` + `0002_phase2b` + `0003_phase2b_auth`); **Before-User-Created
  hook ENABLED**; **Confirm-email OFF** (dev only); **SpaceX seeded** (frozen RESOLVED, `raw_sha256`
  `c1be52e4…`) via `scripts/seed-spacex.mjs`.
- **Dev login (allowlisted):** **`ilanbenamaro@gmail.com`** — `admin` in org **"Dev Org"** (`allowed_emails`
  seeded). Account exists (signed up out-of-band; there is no UI signup form yet).
- **Vercel env:** the 4 vars (`NEXT_PUBLIC_SUPABASE_URL`/`_ANON_KEY` + `SUPABASE_URL`/`_SERVICE_ROLE_KEY`)
  are set in **Preview** scope with **dev values**. **Production scope is EMPTY** (deliberate → the prod 500).
- **Local:** `.env.local` (gitignored) **is NOT reliable across sessions** — don't assume it
  holds all 4 dev vars (a fresh machine had only `NEXT_PUBLIC_SUPABASE_URL`). The gate scripts
  read `process.env` directly, so the **4 dev vars must be present in the shell/env at run time**
  (export them or prefix the command). **Canonical source of the dev VALUES = Vercel Preview-scope
  env + the operator's own records, NOT a guaranteed-present `.env.local`.** Signup-fixture domain:
  `TEST_EMAIL_DOMAIN=polymarket-tracker-dev.com` (Supabase rejects `example.com`/`.test` at validation).
- **Gates all green on dev:** `verify-phase2a` 12/12, `verify-phase2b-{isolation,auth,watchlist}`,
  `verify-2c1-authgate`. Run them with the dev creds in env (+ `VERCEL_AUTOMATION_BYPASS_SECRET` if hitting
  a protected preview).

## ⮕ 2c SCOPE (locked) — dashboard; what's CUT / DEFERRED / ABANDONED
- **Product:** the 2c dashboard — **Bloomberg-dense, institutional-terminal** aesthetic (density via
  hierarchy + color-as-meaning, not clutter; IBM Plex Sans/Mono; tokens in `app/globals.css`). Quant audience.
- **Three zones:** Zone 1 watchlist rail · Zone 2 market detail · Zone 3 search+add (in the command bar).
- **Build order:** 2c.1 shell **DONE** → **2c.2 rail DONE** (`lib/watchlist.listVisible` + `lib/market-scan`,
  on branch, not merged) → **2c.3 detail (NEXT)** (generalizes `docs/index.html` via `/api/market`) →
  **2c.4 search+add** (gamma `public-search` + compute-then-add, handling `MarketNotInCatalogError`).
- **CUT entirely (do NOT build):** related-markets / "market relates to other aspects" analysis; **scenario
  analysis (Tier-2)**; anything **trading / positions / P&L**.
- **DEFERRED to 2d:** email / notifications.
- **ABANDONED:** the **news area** — `docs/ARCHITECTURE.md §8` designed a firewall to "build later"; that is
  now **dropped**, not merely deferred. (ARCHITECTURE.md §8 is superseded on this point.)
- **Deferred fast-follow:** the signup / invite-acceptance form (2c.1 is **login-only**).

## ⮕ DIRECTION (2026-06-20): Phase 2b (accounts + watchlists) — COMPLETE (2b.1+2b.2+2b.3), GATE-PROVEN on dev
- **Where:** **MERGED to `main`** — 2b.1+2b.2 via `--no-ff` `d9f1e3e`, **2b.3 via `--no-ff` `3fd4761`**
  (2a was already in main). 119/119 tests green on merged main.
- **2b.3 DONE — watchlist CRUD:** `lib/watchlist.mjs` (CLIENT-SAFE: client-direct, user-session,
  `authenticated` role, **no service-role**) — `addPersonal`/`removePersonal`, `addOrg`/`removeOrg`
  (added_by=self), `listVisible` (the `my_visible_watchlist` union). Idempotent adds; access control is
  the 2b.1 RLS firewall, surfaced as typed errors (`MarketNotInCatalogError` 23503, `NotPermittedError`
  42501) — no app-side permission checks, no schema change. Proven by `scripts/verify-phase2b-watchlist.mjs`
  (GREEN on dev); isolation gate re-run GREEN. ⚠ **`market_id` must already exist in `markets`** (FK) →
  `addPersonal/addOrg` throw `MarketNotInCatalogError`; **compute-then-add is 2c's job** (GET `/api/market?id=`
  populates `markets`, then retry). **The full accounts+watchlist BACKEND is now complete & gate-proven.**
- **⚠ CODE-ON-MAIN ≠ LIVE-IN-PROD.** `main` now carries `0002`/`0003`, but those migrations are applied
  **only on the DEV Supabase**. Production is **NOT ready**: do **not** point production Vercel at this
  stack until a **PROD Supabase exists with `0001`+`0002`+`0003` applied**, the **Before-User-Created hook
  ENABLED** (created-but-not-enabled fails OPEN — the negative gate is the proof), and a real
  **email-confirmation posture** set. Vercel production posture is **unchanged** (still the open
  deployment-protection / prod-vs-preview 2b-backlog decision). The Vercel **preview** still builds the
  branch.
- **Design (approved + built):** invite-only accounts. `organizations` + `profiles` (1:1 `auth.users`) +
  `org_membership` (M:N) + `allowed_emails` (operator allowlist) + **two** watchlist tables —
  `personal_watchlist` (private) and `org_watchlist` (shared, **any-member** curate with `added_by`) —
  plus a `security_invoker` union view `my_visible_watchlist` (= personal ∪ org). Watchlist FK →
  `markets.id` (the 2a table). Watchlist CRUD is **client-direct** via supabase-js (RLS is the guard);
  **`/api/market` stays public + `no-store` + untouched** (don't entangle the verified-data path w/ auth).
- **2b.1 SHIPPED (schema + RLS):** `0002_phase2b.sql` (+ `_down`; additive, touches no 2a table). RLS on
  every new table; `SECURITY DEFINER` helpers `is_org_member`/`shares_org` avoid policy recursion;
  membership/allowlist are client-deny (operator/trigger only). **`verify-phase2b-isolation.mjs` GREEN
  through real JWTs:** cross-tenant read/insert/delete denied (42501; no phantom row; targets survive),
  union view scoped, B-symmetry. **This gate is the RLS regression proof — re-run after ANY auth change.**
- **2b.2 SHIPPED (invite-only signup gate + provisioning):** `0003_phase2b_auth.sql` (+ `_down`).
  `hook_restrict_signup_to_allowlist` = the **"Before User Created" Auth Hook** (current Supabase
  mechanism, verified vs live docs — NOT the legacy `auth.users` trigger), **DENY BY DEFAULT** (allow
  only on explicit `allowed_emails` match; null/empty/malformed rejected). `handle_new_user`
  (after-insert) provisions `profiles` + `org_membership` from the allowlist row + stamps `consumed_at`;
  idempotent. Both functions `SECURITY DEFINER set search_path=''`. **`verify-phase2b-auth.mjs` GREEN:**
  NEGATIVE — valid-format but UNLISTED email rejected by OUR hook (403/"invite-only", NOT email-format
  validation), no `auth.users` row → invite-only **fails CLOSED**; POSITIVE — allowlisted email →
  account + profiles + `org_membership`(correct org+role) + `consumed_at` + login. Isolation re-run GREEN.
- **⚠ DEV-ONLY CONFIG used to make the gates run (does NOT apply to prod):** the hook is **enabled** in the
  dev project's Auth settings, and **"Confirm email" is OFF** on dev (so test `signUp` sends no mail).
  Test fixtures use `TEST_EMAIL_DOMAIN=polymarket-tracker-dev.com` (Supabase rejects reserved/no-MX
  domains like `example.com`/`.test` at email-deliverability validation, which runs **after** the hook).
- **⚠ PROD STANDUP CHECKLIST when a prod project is created:** (1) apply `0001`+`0002`+`0003`; (2)
  **manually ENABLE the Before-User-Created hook** (a created-but-not-enabled hook **fails OPEN** silently
  — the negative gate is the proof it's on); (3) set a real **email-confirmation posture** (prod should
  CONFIRM emails, unlike dev); (4) decide the **deployment-protection posture** (Vercel wall OFF for
  testing → gate prod via our own auth, per the 2a backlog item); (5) re-run both gates against prod.
- **Email validation ⟂ access control:** the allowlist hook runs BEFORE email-deliverability validation
  and is the ONLY access gate; the dev email-validation/confirmation relaxations change nothing about who
  can get in, and don't affect what the negative gate proved.
- **Deferred (do NOT scaffold):** dashboard UI (2c), notifications/email (2d), news, "market relates to
  other aspects" analysis (pending a concrete fund definition).

## ⮕ DIRECTION (2026-06-18): multi-market hosted product — Phase 2a DONE & LIVE-VERIFIED
- **Phase 2a (backend foundation) — SHIPPED on Vercel + Supabase.** A Vercel serverless function
  (`api/market.mjs`) serves ONE verified market on demand, backed by a Supabase cache. The verified
  pipeline runs on the backend (`lib/compute.mjs` → `core/`); the client never fetches Polymarket /
  bypasses `core/`; the cache only ever stores a `core/`-validated record (`lib/cache.mjs` `writeRecord`
  is the sole write path) and stores the frozen hash, never recomputes it. Cache×resolution precedence
  in `lib/decide-cache-action.mjs` (RESOLVED served forever; within-TTL OPEN is gamma-probed before
  serving so a since-resolved market is never served stale; TTL=15min). Auth/watchlists/notifications/
  news = **deferred** (2b/2c); schema is FK-ready. Also shipped: **R1** (CI failure → GitHub issue) +
  **R2** (fail-loud if a builder gets no MarketConfig).
- **LIVE-VERIFIED 2026-06-18: `scripts/verify-phase2a.mjs` 12/12 green against the deployed stack** —
  C1 OPEN market returns a re-hash-verified record; C2 repeat call is a TRUE Supabase cache hit
  (`cached:true`, function runs + reads cache, no Polymarket re-fetch); C3 SpaceX served frozen RESOLVED
  from the seed; C4 cache×resolution trap holds (a since-resolved market is never served stale-live).
  Supabase schema applied (`markets` + `market_snapshots`, RLS locked, `market_latest` view
  `security_invoker=on`); SpaceX seeded via `scripts/seed-spacex.mjs`.
- **⚠ LOAD-BEARING: `/api/market` sets `Cache-Control: no-store` — DO NOT add HTTP/edge caching.** The
  per-call resolution probe is the correctness layer; an edge-cached response (`x-vercel-cache: HIT`)
  skips the function and could replay a since-resolved market as OPEN (the C4 gap). Supabase is the cost
  layer. See [[gotchas]] "Vercel edge-caches …" and [[decisions]] "/api/market is never HTTP-cached".
- **Proven locally: 119 tests** (decision logic + orchestration incl. the cached-then-resolved trap);
  parity gate still green (SpaceX byte-identical).
- **Next: Phase 2b** — Supabase Auth + watchlists (FK-ready schema; no table rewrite needed).
  Plan fresh next session. Backlog to fold in:
  - [ ] **Deployment-protection posture** — Vercel deployment protection is currently **OFF** (was
    turned off for 2a live testing). Production access should be gated by **our own Supabase auth**
    (2b), **not Vercel's wall** — decide/lock this when 2b auth lands, and don't leave the preview
    open indefinitely. (Resolution correctness is already enforced server-side; this is access control.)
  - [ ] **Document the 0.5% `MATERIAL_ADJUSTMENT` threshold** (`core/confidence.js`) in
    `core/methodology.json` — an isotonic tweak below 0.5% is treated as immaterial and keeps the
    confidence tier high; that rule should be written into the methodology, not only the code.

## ⮕ DIRECTION (2026-06-17): multi-market hosted product — Phase 1 SHIPPED
- **Pivot:** generalizing from the single SpaceX market into a **hosted multi-market** product on
  **Vercel + Supabase** (Polymarket unchanged). Design: `docs/ARCHITECTURE.md` (read before rebuild
  work). Governing principle: the verified pipeline runs on the backend, on demand + cached. See
  [[decisions]] "PIVOT".
- **Phase 1 DONE (core/ generalization + resolution guard, no infra):** `core/` now processes ANY
  threshold-ladder event via a per-market **MarketConfig** (`core/markets/*.json` + `core/market-config.js`
  `defaultConfigForLadder`) — no `if spacex` anywhere. SpaceX is one pinned instance whose output is
  **byte-identical** to pre-generalization (blocking gate `test/phase1-spacex-parity.test.js`: frozen
  `raw_sha256` `c1be52e4…b89003` + full derived deep-equal + 183-day history). Proven on a 2nd real
  ladder (Kraken IPO $16–28B) via the generic defaults. Two-stage lifecycle (`core/lifecycle.js` +
  `snapshot.lifecycle`: OPEN / CLOSED_PENDING / RESOLVED) classified from gamma meta; Tier-2 scenarios
  optional. methodology **1.4.0**, schema **1.3.0**. 99/99 tests.
- **⚠ SpaceX RESOLVED (2026-06-17):** the market settled — realized cap in **$2.0–2.2T** (>$2T Yes,
  >$2.2T No), matching the last live median ~$2.1T. The feed is **frozen** (lifecycle RESOLVED,
  `freshness.final`, no live pull; re-runs skip). This also fixed a live breakage: the OLD v1 cron was
  crashing every run with "No midpoint" because a resolved market returns no CLOB midpoints (see [[gotchas]]).
- **Next:** Phase 2 (serverless compute + Supabase cache) per ARCHITECTURE §9. The v1 GitHub-Actions/
  Pages app below now serves the frozen resolved SpaceX record.

## Current state
- **Live:** https://ilanbenamaro-cyber.github.io/polymarket-tracker/
- Methodology **1.3.0**, schema **1.2.1**, assumptions **1.0.0** — all three embedded in every snapshot.
  (1.3.0 = 2h cadence + schedule-derived 17h staleness threshold + post-publish verify gate;
  policy change, NO formula change. 1.2.1 = source-of-record + verifier + freshness.)
- **Cadence (2026-06-12):** snapshots every 2h, 12:00–00:00 UTC (overnight pause 00→12 UTC = max
  12h gap → threshold 12+2+3 = **17h**, derived in `core/freshness.js` SCHEDULE; coupling test binds
  it to the update.yml cron). Dashboard auto-refreshes (10 min + visibilitychange, silent failures).
- Branch `feature/cadence-audit` carries the 2026-06-12 audit pass (8-seam directed audit:
  4 P1 fixes each with regression tests + cadence migration + verify gate). Repo: `ilanbenamaro-cyber/polymarket-tracker`.

## What this is (3 sentences)
An institutional prediction-market data product: it turns Polymarket's "SpaceX IPO closing
market cap above $X?" markets into a trustworthy valuation signal. It serves a canonical JSON
API (`docs/api/v1/`), a dashboard, and a printable research note, all projecting from one
core record. **Public Polymarket data only** — no grey-market/secondary data (that's v2, out of scope).

## How to run
- `node scripts/snapshot.js` — main entry (the cron runs this): fetch → build canonical record
  (isotonic-adjusted, analytics, scenarios, narrative) → validate (schema+invariants+firewall) →
  write API → append today to history → bake HTML fallback.
- `node scripts/backfill.js` — one-time/idempotent: rebuild full history from Polymarket price-history.
- `node scripts/verify-accuracy.js` — independent accuracy harness: dual-source fetch (Gamma + CLOB) ×2,
  cross-source + drift + published-vs-live reconciliation; report-only. Canonical green path: run
  snapshot then verify while seconds-old → PASS (exit 0). Flags: `--strict --json --price-window-hours --staleness-hours`.
- `node --test` — unit tests (currently **80/80**: PAVA, band, anomalies, hash, firewall (incl.
  numeric-0 leaves), rounding, analytics, freshness + schedule coupling, accuracy-verifier zones,
  dashboard contract (velDelta/auto-refresh), email digest inputs, full-history invariant sweep).
- Output lands in **`docs/api/v1/`** (`latest.json`, `history.json` lean, `history-full.json`,
  `history.csv`, `methodology.json`, `schema.json`, `snapshots/YYYY-MM-DD.json`).
- Local preview: `cd docs && python3 -m http.server 8000` (the page `fetch`es the API, so use HTTP not file://).

## VERIFIED
- Local pipeline: snapshot + backfill run clean; 176-day history; 0 negative buckets across all days.
- Dashboard + 3-page note render with **0 console errors** (favicon present); verify-hash MATCH/MISMATCH works.
- Firewall enforced: validate.js throws on a stripped/unsourced scenario assumption and on a Tier-1 leak.
- Live API serves 1.2.1 with CORS `*`; schema validates (incl. additive `derived.freshness`).
- **Accuracy verifier** run live: canonical path (snapshot→verify seconds-old) = PASS; price-match FAIL
  and aged-drift OK paths both confirmed; cross-source (Gamma vs CLOB) agrees live; source curve valid.
- **Freshness** verified via Playwright: fresh state shows "as-of age" muted + badge hidden; stale state
  shows red age + STALE pill; 0 console errors.
- node --test 43/43.
- **CI pipeline proven END-TO-END** ✅ — `workflow_dispatch` (mode snapshot) ran green
  (run 27154304762): npm ci on ubuntu, snapshot, schema validation, and the bot commit/push all
  succeeded. The new **concurrency-safe push** path worked (snapshot commit `01d505b` landed on
  `origin/main` via fetch→rebase→push). Was UNVERIFIED #1 — now done.

## UNVERIFIED (do these — top item FIRST)
1. **First overnight pause under the 2h cadence** — after merge, confirm the 12:00 UTC run lands and
   the dashboard never showed STALE overnight (the 12h-gap-not-stale policy, validated in production).
2. Email/push path (`send-emails.js`) is dormant and unrun in CI (intended; guarded to skip without
   secrets). Now reads `docs/api/v1/` — the deleted-data.json time bomb is fixed but the live send
   path is still unexercised.

## Recently shipped (2026-06-12 audit pass, branch feature/cadence-audit)
- [x] **8-seam directed audit** — severity-ranked ledger; 4 P1s fixed each with a regression test:
  firewall numeric-0 leaf bypass (validate.js null-checks), impliedSharePrice Infinity on zero range
  bound, velDelta D1 re-derivation (3rd occurrence — now renders stored display), send-emails read
  the deleted docs/data.json (now reads v1 API, ascending-history prior). See [[decisions]], ledger
  in the session report.
- [x] **2h cadence + schedule-derived 17h staleness threshold** (was 50h literal) + coupling test +
  methodology **1.3.0**. See [[decisions]].
- [x] **CI verify gate, publish-then-alert** (non-strict, last step, transport-aware retry) — closes
  the old "wire --strict gate" task with deliberately different semantics. See [[decisions]].
- [x] **Dashboard auto-refresh** (10 min + visibilitychange; silent failures keep the view) +
  **mobile table scroll** (375px verified, was overflowing).
- [x] **Full-history invariant sweep test** (181 days through production validators) + CSV constraint.

## Immediate open tasks
- [x] **Document the 0.5% confidence threshold** (`MATERIAL_ADJUSTMENT` in `core/confidence.js`) in
  `core/methodology.json` — [DONE — session 2026-07-02, methodology 1.7.1, which also documented the
  $2K 24h floor, the CORRECTED book_depth dominant-leg selection, and the placeholder-leg filter].
- [ ] **P2 backlog from the audit** (documented, deliberately deferred): scenarios.js pct Math.round
  asymmetric on negatives vs roundT (changing alters published Tier-2 values — needs its own
  methodology note); inline money() can render $-0.00T (unreachable today); quantileValuation
  CDF-touches-0.50-at-last-node returns null (definitional).
- [ ] **OPERATOR: re-seed the stored SpaceX final on dev (+ prod at standup)** — `node
  scripts/seed-spacex.mjs`. The dev row is the PRE-SPLIT (schema-1.3.0 single-tier) record, so any
  freeze-path revalidation 422s ("Record invalid") — this is verify-phase2a C4's remaining red.
  General rule (new [[gotchas]] entry): a breaking `derived` reshape must re-seed stored FINAL records.
- [x] **`latest.json`'s `schema_version: "1.3.0"` label vs its 2.0.0-shaped confidence block** —
  [DECIDED — session 2026-07-02: preserved as-is, intentionally. See [[decisions]] "latest.json
  schema_version label — preserved as historical record".]
- [ ] **HARD-STOP candidates from the 2026-07-02 audit, awaiting operator "proceed"** (all core/):
  (a) `windowedVolumeSignal` can emit "moderate 24h volume ($0)" when the 7d leg qualified — name the
  qualifying window; (b) `buildPmfLadder`'s `lo <= 0` bottom-bucket heuristic biases the PMF mean for
  NON-UNIFORM percent ladders straddling 0 (no live market affected); (c) the STORED touch narrative
  still says "implied 50% trading range" (display uses barrier language since INC 7).
- [ ] **METHODOLOGY.md is pinned at 1.2.1** — broadly behind methodology.json (1.7.1); only the
  MATERIAL_ADJUSTMENT note was added 2026-07-02. A full realignment pass is pending.
- [ ] Carried: the INC-1 red-team calibration call is CLOSED (the $2K floor shipped + is now
  documented); PROD-STANDUP still needs migrations 0001–0011 + CRON_SECRET + the 18:00 cron.

## Pointers
- Why things are the way they are → `.workflows/_knowledge/decisions.md`
- Traps already hit → `.workflows/_knowledge/gotchas.md`
- Human methodology → `METHODOLOGY.md`; API contract → `API.md`; schema → `docs/api/v1/schema.json`
- Latest task plan → `~/.claude/plans/azure-if-not-already-prancy-lemur.md` (overwritten per task; holds 1.2.0 only)
