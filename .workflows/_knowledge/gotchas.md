# Gotchas — traps that already bit us

Concrete failure modes hit during development. Check here before diagnosing a
"weird" symptom. Newest at top.

---

## CLOB /last-trade-price FABRICATES `{"price":"0.5","side":""}` for a token with NO order book — the EMPTY SIDE is the tell
**Confirmed live (2026-07-21, prod, plausibility survey; probe-verified on 3 tokens):** for a
never-traded/delisted token whose `book` endpoint answers "No orderbook exists", `last-trade-price`
returns `{"price":"0.5","side":""}` — a real trade always carries side BUY/SELL. The 1.10.0
settled-leg rule routes dead-book legs to last_trade believing it is "an OBSERVED datum"; for
bookless tokens the endpoint FABRICATES, one tier below the midpoint-0.5 lie (entry below). At
discovery: **17/17 last_trade-sourced watched legs stored exactly 0.5** (LeBron 6 OPEN placeholder
legs, world-cup 10+1 pending legs) — zero real values in the tier. Display was shielded ONLY by a
coincidence: every such leg carried a placeholder-style label ("Team A", "Any Other …") that the
categorical placeholder filter drops — one REAL label on a bookless leg puts a fabricated ~50%
into the sum, the de-vig, and the board lead. **The discriminator is the side field, never the
price value** (a genuine 0.5 trade has a side). Status: **FIXED** — core witness guard shipped
on `fix/last-trade-witness-guard` (methodology 1.12.0): `fetchLastTradePrice` (core/fetch.js,
the single choke point all 5 shape fetchers share) now returns `null` and warns loud
(`[last-trade] fabricated (side:"")`) unless `side` is 'buy'/'sell', case-insensitive; `null`
flows into the existing skip machinery, never a value substitution. Population measured at fix
time: **369 fabricated legs across 15 boards, 4 display-visible on filterless ladders**. The 10
world-cup legs were remediated by the 1.11.0 resolved-transition rebuild; LeBron's 6 OPEN legs
now skip loud instead of storing a fabricated 0.5.

## CLOB midpoint returns a SYNTHETIC 0.5 for an empty book on a settled/closed leg — midpoint-present ≠ midpoint-trustworthy
**Confirmed live (2026-07-16, prod):** Norway (eliminated, `closed=true`, `uma=resolved`,
settled `["0","1"]` = P(win) 0) displayed at **50%** — because CLOB's `midpoint` endpoint
answered `{"mid":"0.5"}` for a token whose `book` endpoint, same instant, showed **0 bids and
0 asks**. The fallback chain trusted midpoint-present and recorded 0.5 as `clob_midpoint`; the
existing "missing CLOB midpoint = empty book → last_trade" gotcha covers midpoint-ABSENT, not
midpoint-LYING. Population at discovery: 2 legs across all 76 prod markets, in TWO shapes
(world-cup-winner categorical · spacex-closing-…-ipo-month threshold_ladder) — the shared
pricing chain, not a categorical quirk. Related sub-case, same root: a settled leg priced from
a stale `last_trade` (Italy: 2.7% where settled truth is 0). **A settled leg must be priced
from its own settled truth (`outcomePrices` via the label-aligned `settledYesStr` reader —
null-not-zero), never from any live quote.** TWO traps inside that rule: (1) `outcomePrices`
on an OPEN leg mirrors LIVE prices (Spain, mid-final: `["0.5835","0.4165"]`) — it is
settlement truth ONLY under `umaResolutionStatus='resolved'`; (2) the danger is one
coincidence away from fabrication: had the board's raw sum landed inside [0.8, 1.25], the
phantom 0.5 would have entered the de-vig and distorted every outcome.

## Pre-0010 cached browse markets that RESOLVE before re-browse 422 FOREVER — class census'd and CLEARED (2026-07-15)
The resolved-with-prior serve path freezes the STORED record as authoritative and never
recomputes — so a browse market cached before the 0010 confidence split that resolves before
anyone re-browses it fails current-schema validation (422, graceful UI, no fabrication) on
every subsequent view, permanently. OPEN old-shape markets SELF-HEAL (serve recomputes and
re-caches); only resolved ones fossilize. Census (prod, 2026-07-15): exactly 2 old-shape
latest snapshots existed, 1 was the fossil (cleared via `gc-browse-markets --id` + re-browse,
rebuilt valid), 1 self-healed on probe — **the class is now EMPTY on both envs and cannot
refill** (all writes are new-shape). If a future breaking derived reshape ships, this class
re-opens: re-run the census (old-shape latest snapshot ∧ resolved) or ship the design-gated
serve-path self-heal on the futures list. Related: "A breaking `derived` reshape also
invalidates STORED FINAL records" below — this is that gotcha's browse-market corollary.

## Playwright screenshot 5s cap → in-page html-to-image workaround (proven ×7) + password-less dev login
A backgrounded browser throttles rAF, so Playwright's "element stable" wait starves and
screenshots hit the 5s backend cap. Workaround (now proven ×12 across two sessions): inject
`html-to-image` from unpkg via browser_evaluate, `toJpeg(document.documentElement, {quality:
~0.45, pixelRatio: 1})` → dataURL → save via evaluate's `filename` param → base64-decode in
Bash → Read the jpeg. Login without typing credentials into the form: programmatic GoTrue
sign-in in a Node script (the verify-script pattern) → write the session as the
`sb-<ref>-auth-token` cookie (`'base64-' + base64url(JSON.stringify(session))`, chunk at
~3000 chars to `.0/.1` names if longer) via document.cookie → navigate; SSR middleware
accepts it.

## Gamma/wording parse traps that feed the guard — endDates and deadline text
(1) Gamma per-leg `endDate` can be STALE or TIED across legs (fed-rate-cut: five legs shared
one date) and occasionally wrong — never trust it alone; the guard uses it only as a
CROSS-CHECK and only when mostly-distinct (≥0.8 distinct fraction). (2) parseByDeadline digit
traps, each caught by a permanent test: "by January 2026" must not read day=20 from the year
(digit-boundary); "by July 4th, 2026" must not lose the year to the ordinal (RT-3); numeric
"by 6/30/2026" and "by Q3 2026" must parse to DISTINCT keys or the nested detector goes blind
(RT-1). Wording is the load-bearing signal — parser gaps become fabrication paths.

## The exclusivity guard's fall-through could reproduce the fabrication it exists to prevent (RT-1/RT-2)
**A guard is only as good as its worst untested branch (INC 7 red-team, 2026-07-14).** Two
confirmed fabrication paths lived INSIDE assessExclusivity's own branch order: RT-1 — numeric
("by 6/30/2026") and quarter ("by Q3 2026") deadlines all collapsed to the bare-year fallback's
ONE parse key, so the distinct-deadline requirement went blind and the board fell through to the
sum test, where an in-band sum de-vigged a time-CDF into a PMF; RT-2 — a dated-dominated board
with a single >2.5pp stale-quote inversion failed text-monotone and fell through the same way.
Fixed at methodology 1.9.0 (no-fall-through rule + numeric/quarter/ordinal parsing), locked by
5 permanent tests in test/exclusivity-guard.test.js (RT-1, RT-1b, RT-2, RT-3, shared-deadline
regression). **Any change to assessExclusivity's branch order must re-run these 5 tests** — the
asymmetry principle ("every misclassification degrades to raw") is a property of the branch
ORDER, not of any single branch.

## DO NOT RE-WATCHLIST `strc-hits-100-by-20260618001620693` on dev (un-watchlisted 2026-07-14, INC 7 triage)
**Severity call P2, disposition executed (dev ref `dxoyxjxcfbgygvjvrrfk`; 1 personal watchlist
row deleted; 16 history rows + `markets` row KEPT):** the board is the NAMED deadline-ladder
tripwire — three legs at ONE price level ($100) across three deadlines, stored as a
threshold_ladder of identical thresholds, i.e. a meaningless degenerate curve snapshotted on
every batch. Exposure was dev-only (never on prod), which is what holds it at P2. The honest
shape is the time-CDF EPIC; until then the board is browse-only. The INC 7 [shape-tripwire]
(duplicate_thresholds) now logs loudly if this family is ever computed again — including when
a user re-adds one. See the TRIPWIRE entry below for the family.

## GC-browse residual race (ACCEPTED v1, operator ruling 2026-07-13) — exact conditions + the v2 fix
`scripts/gc-browse-markets.mjs` re-checks the watchlists immediately before each delete, but the
re-check and the `delete from markets` are TWO statements: a watchlist INSERT that commits in the
window between them is FK-cascade-deleted together with the market (all four FKs onto
`markets(id)` cascade). Triggering it requires a user to watchlist a market that NOBODY has
viewed in ≥30 days (the retention window is the real shield — `last_checked_at` is bumped on
every serve) in that same instant. Accepted for v1 by explicit operator ruling. **v2 (do not
build until ruled needed):** a migration-defined SQL function doing scan+delete in ONE
transaction/statement (`delete … where not exists (select 1 from watchlists …)`), service-role
only. Related trap the gate caught at birth: the frozen record's `markets.id` is the EVENT SLUG
`spacex-ipo-closing-market-cap-above`, NOT the internal config id `spacex-ipo-market-cap` —
HARD_EXCLUDE pins both; never "protect SpaceX" by the config id alone.

## TRIPWIRE — "browse=cache" is proven at 4 days post-resolution ONLY; CLOB history has a REAL horizon and the failure is SILENT
Do not let "browse = cache" harden into "forever, at any age". Pricesmart experiment
(2026-07-13, prod): deleting a resolved browse market and re-browsing regenerated the record
(deployed `/api/market`, settled outcomePrices) AND all 6 history rows, same dates, 0 failed —
**4 days after resolution**. The horizon probe (same date): CLOB `prices-history` returns full
curves for closed markets ending ≥ ~Nov 2023 (`ilya-still-at-openai-on-jan-1`, 46 points) and
**HTTP 200 with ZERO points** for older ones (2011→early-2023 enders all empty) — an era
boundary (pre-CLOB/AMM markets), not — so far — a rolling window, but rolling deletion is NOT
disproven. **The failure mode is silent: the record regenerates, the chart comes back empty,
nobody notices.** The guard: GC's per-market report prints `RESOLVED <n>d ago` (or `age
UNKNOWN — regeneration not guaranteed`) so the operator sees the actual risk before typing
--apply. If a resolved browse market older than the proven range matters, probe its legs'
prices-history BEFORE GC'ing it.
**Retention point 2 (2026-07-15, prod):** `what-price-will-bitcoin-hit-in-june-2026`, a touch
board ~2.5 weeks post-resolution, rebuilt **30 history rows where 29 existed** (2026-06-02→07-01,
0 failed — the rebuild recovered a day the original capture missed). Proven range now: 4 days
AND ~2.5 weeks post-resolution; the ~Nov-2023 era boundary stands as the only observed cliff.

## The frozen record's `markets.id` is the EVENT SLUG, not the config id — this trap will bite again
`markets.id` = `spacex-ipo-closing-market-cap-above` (the event slug; dev AND prod verified
2026-07-13). The internal config id `spacex-ipo-market-cap` (core/fetch.js ASSET.id) does NOT
exist as a markets row. INC 6's HARD_EXCLUDE was originally pinned to the config id alone —
i.e. the guard protecting the frozen provenance anchor pointed at a row that isn't there, and
only the watchlist check stood between GC and SpaceX. The verify gate caught it at birth
(operator's approved design had the same blind spot). Rule: anything that must protect or
target the frozen record BY ID uses the event slug — and any id-pinned guard gets a gate check
that the pinned id actually EXISTS in the table it guards.

## reconstruct-guarded-history: re-run counts are NOT an idempotency check (two artifacts)
(1) The per-row skip tests `derived.exclusivity` PRESENCE, which conflates "not yet processed"
with "processed → verdict exclusive" (the 1.8.0 schema is exclusivity XOR PMF, so
exclusive-verdict rows carry NO block). After the 2026-07-13 prod apply (1241 reconstructed),
a re-run reports `reconstructed=421` FOREVER — those are rows whose OWN raw sums sit in the
[0.8,1.25] band and legitimately rebuilt to unguarded PMFs (verified: all stamped 1.8.0 with
raw_probability). Re-applying rewrites identical content; the counter is noise, not drift.
(2) The market-level probe verdict reads `rows[rows.length-1]` of an UNORDERED select with
live gamma — it can flip between runs (prod: who-will-trump-nominate flipped non_exclusive →
exclusive, +9 skipped). Consequence is bounded (the probe only gates which boards get per-row
treatment; each row's stored verdict comes from its own data), but do not read re-run counts
as a health signal — verify content (methodology stamp + raw_probability), not counters.

## DO NOT RE-WATCHLIST `next-openai-model-arena-debut-685` on dev (un-watchlisted 2026-07-13, operator order)
**Why it's off the watchlist (dev ref `dxoyxjxcfbgygvjvrrfk`; 1 personal + 1 org row deleted;
its 62 reconstructed history rows and `markets` row are KEPT for browse reuse):** the board is
a THRESHOLD-NESTED family member ("1450+/1470+…" cumulative legs — one of the two unmodeled
families from the 5.6 exclusivity survey). Today its verdict happens to flip EXCLUSIVE at
settled sums ≈1.02, so the de-vig (÷1.02 ≈ raw) is de-minimis — but that is a COINCIDENCE of
current prices, not a property of the board: as legs settle or prices move, the verdict can
flip and future cron rows would alternate between guarded-raw and de-vigged PMFs, polluting
the history with mode churn for a structure the pipeline cannot honestly model yet. The honest
state is browse-only until the time-CDF/nested-shape EPIC ships a real cumulative shape.
Re-adding it makes the cron resume snapshotting it (allWatchedMarketIds reads the watchlists)
and re-creates exactly this problem.

## TRIPWIRE — the DEADLINE-LADDER shape gap: "hit $X by <date₁…dateₙ>" boards have NO honest shape
**Named tripwire (2026-07-13, INC 5 survey; deliberately NOT fixed by the reach/dip classifier):**
events whose legs share ONE price level across MULTIPLE deadlines ("Will STRC hit $100 by
June 30 / Sep 30 / Dec 31?", `when-will-bitcoin-hit-150k`) fit NO existing shape: touch math
(high/low series over LEVELS) cannot express them — dedup would collapse identical strikes —
and survival parses them into a DEGENERATE ladder of identical thresholds. Bare "hit" is
deliberately not a touch verb for exactly this reason (plus direction ambiguity — see
TOUCH_VERB_RE in core/fetch.js). **The tripwire, DISPOSITIONED at INC 7 (2026-07-14):**
`strc-hits-100-by-20260618001620693` — P2 (dev-only exposure), un-watchlisted (see its own
entry above); the [shape-tripwire] duplicate-thresholds warn (core/snapshot.js, INC 7) now
logs the family loudly wherever it's computed. If a user adds another "hit $X by dates" board,
it still looks wrong but no longer silently. The fix remains a NEW SHAPE (deadline ladder /
cumulative touch-in-time) — the time-CDF EPIC. The related some($-leg) looseness (one stray
"$1m before GTA VI" leg flipping a categorical to survival) was **FIXED at 5.5**: survival now
requires ALL legs $-worded, mixed boards are 'unsupported' (typed 422, no write) — proven live
on the GTA VI board and exact-asserted in test/market-shape.test.js.

## verify-history needs a RUNNING server — and its positive path TRIGGERS a real snapshot batch
**Symptom (mis-filed as "crash" until 2026-07-13):** with no server it died on an unhandled
`ECONNREFUSED ::1:3001` stack trace and everyone read it as broken code. It was never broken —
it had simply NEVER BEEN RUN (needs `BASE_URL` + a live server + `CRON_SECRET`); on its first
real run (2026-07-13, production build, fresh port 3617) it passed 22/22, including provenance
re-hash on ALL 10 watched markets' stored history records and the market_history deny-all RLS
check. Now preflights reachability → clean exit 2 with the recipe (the full recipe lives in the
script header). Two standing cautions:
1. The POS check runs a REAL `/api/snapshot` batch against whatever project the server points
   at — only ever run it at DEV. Resolved markets (incl. frozen SpaceX) are skipped by the
   route (verified: SpaceX snapshot fetched_at unchanged after the run).
2. Fresh, never-used port + `rm -rf .next` first — the stale-build trap has produced false
   green in this repo before.

## verify-phase2-binary's fixtures are LIVE gamma markets — check gamma before suspecting code
The LADDER no-regression fixture is the resolved SpaceX event (`spacex-ipo-closing-market-cap-above`,
chosen 2026-07-13 after the previous fixture rotted: `will-wti-hit-week-of-june-22-2026` was BOTH a
dated weekly slug AND a directional_touch market by construction — "hit (HIGH)/(LOW)" wording —
so the survival assertions could never pass). The gate therefore depends on gamma continuing to
serve that resolved event. Stable since inception; `seed-spacex.mjs` shares the dependency and
fails loudly first; `LADDER_SLUG`/`BINARY_SLUG` overrides exist. **If this gate goes red, check
gamma BEFORE suspecting code.** (All verify-* gates are integration gates by construction — a
hermetic recorded-fixture design is a parked future item, not this pass.)

## Running the signup verify gates against PROD needs a real-MX domain + Confirm-email OFF for the window
**Symptom (bit the prod standup, 2026-07-10):** all deny-path checks passed but every positive
signup failed — `@example.com` is rejected by prod's stricter email-deliverability validation
(no usable MX; dev only format-checks), and retries tripped "email rate limit exceeded" (each
positive signUp SENDS a confirmation email BEFORE the scripts' service-role admin-confirm runs;
prod's send limit is tiny on built-in SMTP). **Recipe that works:** toggle **Confirm email OFF**
(Dashboard → Authentication → Sign In/Up → Email) for the run window → `TEST_EMAIL_DOMAIN=gmail.com`
(passes MX validation; with autoconfirm NO emails are actually sent, so no strangers get mail and
no rate limit) → run gates → toggle back ON. The login checks never need an inbox in ANY posture —
both scripts admin-confirm via `svc.auth.admin.updateUserById(uid, { email_confirm: true })` before
`signInWithPassword`. A tripped email rate limit is per-hour; with confirm OFF it doesn't apply.

## `REVOKE EXECUTE ... FROM PUBLIC` on a function strips authenticated's IMPLICIT access too — and whether anything survives is PROJECT-DEPENDENT
**Symptom (bit prod 2026-07-10; dev passed the identical migration):** on prod, approve/reject and
the pending-profile check all failed with `permission denied for function is_org_admin /
admin_of_pending_profile` (42501) surfacing THROUGH RLS policy evaluation — while dev ran the same
paths green (45/45 gate + real browser flows). **Cause:** 0012 revoked EXECUTE `from public, anon`
on the two admin helpers with a comment claiming "these keep authenticated EXECUTE" — false. A
function's default EXECUTE lives on **PUBLIC**; `authenticated` usually has no direct ACL entry, so
revoking PUBLIC strips it. Dev survived only because ITS project's `ALTER DEFAULT PRIVILEGES`
config had handed `authenticated` a DIRECT grant at CREATE FUNCTION time; prod's project config
doesn't do that. **Lessons:**
1. **Never rely on implicit grants surviving a PUBLIC revoke — grant explicitly to every role that
   needs access** (0013 did this for `rotate_org_join_code`, which is exactly why rotation worked
   on prod while approve/reject died — that asymmetry was the diagnostic fingerprint).
2. Supabase projects DIFFER in their function default-privilege config — dev passing a
   grant-sensitive migration proves nothing about prod. The check:
   `select has_function_privilege('authenticated', 'public.fn(sig)', 'EXECUTE')` — but note it
   returns true via PUBLIC too; the decisive test is a real non-owner session (rpc call as
   `authenticated`).
3. A permission error on a function inside a POLICY expression fails the WHOLE query — a "profile
   leak" symptom can actually be a 42501 the caller swallowed. Interpolate raw errors in gates.
Fixed: explicit grants added to 0012 (idempotent), applied manually to prod, and to dev so it no
longer depends on the project-level default.

## PLATFORM FACT (verified empirically 2026-07-10): a GoTrue Before-User-Created hook that ERRORS fails CLOSED
**The F1 experiment (operator-mandated, dev project):** the hook was temporarily replaced with a
function that unconditionally `RAISE`s; an unlisted-email signup then returned **HTTP 500, message
`"{}"` (opaque — the exception text is NOT surfaced), no user object, no session, and NO auth.users
row**. So the enabled-hook failure matrix is:
- hook enabled + returns error object → **403, deny** (normal path);
- hook enabled + throws → **500, deny** (fail CLOSED — this experiment);
- hook **never enabled** → **fails OPEN silently** (the 0003 warning; still the only dangerous state,
  and `verify-phase2b-auth.mjs`'s negative check is the standing proof it's enabled).
The production hook (0013) still wraps its body in `exception when others → generic 403` — now known
to be defense-in-depth + UX (deterministic friendly 403 instead of an opaque 500), not the sole barrier.

## A rail-level "empty state" early-return silently unmounted an entire feature (pending/admin UI)
**Symptom (caught ONLY by browser verification, 2026-07-10):** all RLS/API gates green (45/45), yet
the pending-approval banner, Personal/Org toggle, and admin approval panel never rendered.
**Cause:** `WatchlistRail` returned the "No markets yet" empty state when `rows.length === 0` and
never mounted `WatchlistRows` — which owns that org-membership UI. A brand-new pending/invited user
BY DEFINITION has an empty watchlist, so the bug hit exactly the personas the feature served, while
every fixture-rich test path looked fine. **Lesson:** an early-return empty state must only replace
the LIST it describes, never the component subtree carrying unrelated UI; and server-side gates can
all be green while the UI never issues the query (the `PendingNotice` effect never mounted — network
trace showed zero `org_membership` calls). Fixed `17fcda4`: WatchlistRows always mounts and renders
the onboarding copy itself.

## Post-0010 stale verify gates: scripts asserting the pre-split `d.confidence.tier` shape
The 0010/0011 confidence split (`confidence.{reliability,liquidity}.{tier,reasons}`) left older
verify scripts asserting the pre-split `d.confidence.tier` — permanently red with a "confidence
undefined" signature against records that are actually correct. `verify-2c3-detail` was fixed
(2026-07-10, `07684a1`); **`verify-phase2-binary` still has the same stale check (line ~40) plus two
failing ladder-record checks, and `verify-history` crashes with an uncaught exception — both
pre-existing, flagged and NOT fixed by the invites session (compute-pipeline surface, needs its own
pass).** If a verify script reports missing confidence on a record the app renders fine, check the
script's shape assumptions before suspecting the data.

## Playwright MCP: browser_close drops the auth session; fullPage misses the detail pane; no `npm run start`
**Symptom (bit the design-overhaul session, 2026-07-07):** three small traps in the browser/verify loop.
1. **`browser_close` wipes the Playwright context's Supabase session** — every later navigation
   307s to `/login`, and there are no credentials a session may enter (hard rule). Keep the tab/
   context open for the whole session if authenticated verification is still needed; once closed,
   visual verification of authed pages becomes an OPERATOR step (structural/code verification only).
2. **`fullPage: true` screenshots do NOT capture the detail pane** — `.terminal` is a 100vh grid and
   `.detail` is its own `overflow-y: auto` scroll container, so "full page" is just the viewport.
   Scroll the inner container instead (`browser_evaluate` →
   `document.querySelector('[data-field="…"]').scrollIntoView()`), then screenshot the viewport.
3. **There is no `start` npm script** — `npm run start` errors "Missing script"; use
   `npx next start -p 3000` after `next build` (and remember the shared-`.next` rule: never while
   `next dev` runs; a killed `next start` can leave an orphaned `next-server` worker holding :3000
   that the predev guard then correctly flags — `pkill -f next-server` too).

## touch-record boundLabel hardcodes $ — will break on %-unit touch markets
core/touch-record.js hardcodes the '$' prefix in boundLabel construction.
No live %-unit touch market currently exists so there is zero current impact.
When the first %-unit touch market is added: fix boundLabel to read the
market's unit_prefix (same as the percent-bucket fix pattern).
Detection: a touch market whose labels display '$' when % is expected.

## A conflict-IGNORING upsert makes "re-seed" a silent no-op when the conflict key never changes
**Symptom (found 2026-07-06, explains weeks of red C4):** `scripts/seed-spacex.mjs` reported "✓ seeded"
but the stored row kept the STALE pre-split schema — the documented remediation for the verify-phase2a
C4 failure ("re-run the seed") could never have worked. **Reality:** `lib/cache.mjs writeRecord` upserts
`market_snapshots` with `{ onConflict: 'market_id,fetched_at', ignoreDuplicates: true }`, and a frozen
record's `fetched_at` NEVER changes — so every re-seed hit the conflict and was silently dropped. The
seed's own comment claimed "Idempotent: re-running upserts the same row", which was false in the
update-sense. **Lesson:** `ignoreDuplicates: true` means INSERT-or-NOTHING, not INSERT-or-UPDATE — a
"refresh this row" path over an immutable conflict key needs update-on-conflict semantics. Fixed via a
`writeRecord(..., { replace: true })` option used ONLY by the seed (every other caller keeps
ignore-duplicates, preserving "a re-compute at the same instant must not duplicate"). When a documented
remediation "doesn't take", verify the write actually LANDED (re-read the row) before re-running it.

## Gamma touch events carry DUPLICATE strikes with CONTRADICTORY settlements — dedup to the current board
**Symptom (bit live, 2026-07-06):** the rebuilt resolved record for `si-hit-jun-2026` narrated
"touched HIGH $80…$110" right next to a table showing those same HIGH levels settled No — and its
history chart legend read "P(touch ≥ $90) · 100%" against a current record saying 0%. **Reality:** a
touch leg settles Yes EARLY the moment it touches (its `closedTime` = the touch date; slug gets a
numeric suffix), and Polymarket RE-LISTS a fresh strike at the same level measuring from re-listing —
so one gamma event legitimately carries two "hit (HIGH) $110" legs, one Yes-in-January, one
No-at-window-end. Both settlements are "true" for their own observation windows; displaying both is
incoherent. **Lesson:** `fetchTouchMeta` now dedups per (side, level) via `dedupTouchLegs` — a
still-tradeable leg wins (it IS the current board); among closed legs the latest `closedTime` wins
(matches what Polymarket's own UI reports as the final state). Live, probe, backfill, and
resolved-no-prior paths all inherit. **Backfilled history rows written BEFORE this fix still carry the
duplicate legs** — purge + re-backfill any affected market (si-hit was rebuilt: 187 rows, 21 unique
strikes). If another shape ever grows early-settled re-listed legs, the same dedup posture applies.

## `raw_inputs` has a SCHEMA-WIDE `minItems:1` — it's not just a per-kind `markets`/`outcomes` constraint
**Symptom (hit extending `buildMinimalResolvedRecord` to categorical, 2026-07-06):** assumed a categorical
minimal record could degrade to an EMPTY distribution when every leg's settled price was unparseable —
`parseCategoricalOutcomes([])`/`shannonEntropy([])` both degrade gracefully (no crash, `dominant_outcome:
null`, `entropy:0`), and the categorical schema branch's own `outcomes` field has no `minItems`. But
`validateRecord` still threw: `schema /snapshot/raw_inputs must NOT have fewer than 1 items` — the
TOP-LEVEL `snapshot.raw_inputs` array (required by EVERY record, independent of `derived.kind`) has its
OWN `minItems:1` in `docs/api/v1/schema.json`, unrelated to any per-kind field's own constraints.
**Lesson:** a shape's own `derived.*` fields degrading gracefully to empty does NOT mean the WHOLE record
validates on zero usable legs — check `raw_inputs`' constraint too (it's schema-wide, not kind-scoped).
For `buildMinimalResolvedRecord`'s ladder/touch/categorical builders, an all-unparseable leg set now
throws the SAME honest 409 as the ladder/touch shapes (which needed it for their OWN minItems reasons
anyway) — never a record with an empty `raw_inputs`. Binary is exempt: it always emits exactly 2 rows
(YES+NO) with a `'0'` fallback midpoint, so it never hits zero. Grep the schema's `minItems` before
assuming a "can this be empty?" answer generalizes across nesting levels. See [[decisions]]
"Resolved-no-prior 409 fix EXTENDED to all 5 shapes".

## A "minimal" resolved record can't invent a `tier:'RESOLVED'`, and `Number(null)` is `0` not `NaN`
**Symptom (both bit while building `buildMinimalResolvedRecord`, 2026-07-06):** two traps when hand-building a
synthetic record for a resolved-no-prior binary market from gamma's settled `outcomePrices`.
1. **`confidence.*.tier` is a strict enum.** The intuitive "minimal resolved record" sets
   `confidence.reliability.tier = 'RESOLVED'` (and liquidity), but `docs/api/v1/schema.json` locks tier to
   `enum:["high","medium","low"]` — so `validateRecord` throws `schema …/tier must be equal to one of the
   allowed values`. There is NO "resolved" tier. The record MUST use a real tier; the settled-honest pick is
   reliability **high** (the outcome is final, not an estimate) + liquidity **low** (can't transact). Same
   applies to any place tempted to add a synthetic tier/status into a schema-constrained enum field.
2. **`Number(null) === 0` (not `NaN`), so a null-price short-circuit is REQUIRED before `Number()`.** A price
   parser `const num = (s) => { const n = Number(s); return Number.isFinite(n) ? n : null; }` returns **0** for
   a missing price (`Number(null)`/`Number(undefined)` → `0`/`NaN`… `Number(null)` is 0!), silently
   FABRICATING a 0% probability instead of `null`. Guard null FIRST:
   `(s) => { if (s == null) return null; const n = Number(s); return Number.isFinite(n) ? n : null; }`.
   A defensive test (malformed gamma → probability should be `null`) is what caught it — assert the *absence*
   of data yields `null`, never `0`. `Number('')` is also 0, and `Number('  ')` is 0 — trim/guard blanks too
   if they can occur. (Schema allows `probability: null`, so the honest null passes validation.)
**Lesson:** when synthesizing a record to pass `validateRecord`, (a) never invent an enum value — read the
schema's `enum` first; (b) any `Number(x)` over possibly-absent API data needs an explicit null/blank guard
BEFORE the coercion, or a "no data" case becomes a confident `0`. See [[decisions]] "Resolved markets with NO
prior now build a minimal record…".

## History rows can't distinguish bucket_pmf from survival — `fineKind` falls back to 'survival'
**Symptom (caught during the 2026-07-06 multi-series design, not a bite):** the plan called for a
bucket-only IQR band on the history chart, but a Bitcoin bucket market's `market_history.kind` reads
**'survival'**. `fineKind(record)` (lib/market-history.mjs) returns `derived.market_shape ?? 'survival'`,
and `market_shape` is only set on SOME records (it was added omit-when-absent for parity — see "Adding
a field to derived[] breaks the frozen SpaceX parity gate"); backfill-reconstructed rows in particular
don't carry it. So any HISTORY-side branch keyed on bucket-vs-survival silently routes bucket markets
down the survival path.
**Lesson:** treat survival+bucket as ONE shape ('ladder') anywhere that reads history rows; branch on
the SERVED record's `derived` (which the detail view has) when the distinction truly matters. The IQR
band was attached to the shared ladder path for exactly this reason (it's meaningful for both). If a
future feature genuinely needs the split in history, fix `writeHistory` to stamp the shape first and
accept that old rows stay ambiguous.

## A gamma leg with no `clobTokenIds` crashes `ids[0]` — an untraded/placeholder rung, not a broken market
**Symptom (bit prod, 2026-07-03):** searching `what-will-gold-gc-hit-by-end-of-december` 500'd with
`Cannot read properties of undefined (reading '0')` at `core/fetch.js` `fetchTouchMeta`. The market
is a perfectly valid directional_touch (7 "(HIGH) hit $X" legs); but leg 0 (`hit (HIGH) $5,000`) is an
UNTRADED PLACEHOLDER — gamma lists it with **no `clobTokenIds`** (null / field absent). It parsed fine
as a touch leg (has "(HIGH)" + "$"), so it wasn't filtered; then the inline
`typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds` left `ids`
**undefined**, and `token_id: ids[0]` threw a bare `TypeError` (no `.code`) → `statusFor` → **HTTP 500**.
**Reality:** the SAME unguarded `ids[0]` lived in ALL 5 meta parsers (`fetchMarketMeta`/`Binary`/
`Bucket`/`Touch`/`Categorical`). A leg with no clobTokenIds has no order book → it can't be priced,
so it must be DROPPED, not crashed on. **Lesson:** never index a gamma leg's tokens without guarding a
missing list. Fixed via shared `parseClobTokenIds(m)` (returns null for absent/empty/malformed, never
throws); the 4 multi-leg parsers `.filter(Boolean)` out no-token legs (market loads from its tradeable
legs); the single-leg binary can't skip → throws a clean **integer-`code`-404** (NOT
`MarketNotInCatalogError`, whose `.code` is the STRING `'23503'` → `statusFor` would map it to 500,
not 404 — check `Number.isInteger(err.code)` when picking an error to surface). SpaceX byte-identical
(all its legs have tokens → the filter is identity → parity GATE 2 green). Merged main `4b02cc2`.

## `supabase.auth.getSession()` trusts the cookie UNVERIFIED — use `getUser()` for any server-side trust decision
**Symptom (Vercel warning, 2026-07-03):** "Using the user object as returned from
`supabase.auth.getSession()` could be insecure. Use `supabase.auth.getUser()` instead." Real: the only
remaining `getSession()` call was `lib/watchlist.mjs` `currentUid` — it read `data.session.user.id`
(which fires the warning) and used that uid BOTH to gate auth (NotAuthenticatedError) AND as the
`user_id`/`added_by` on the write. `getSession()` only READS the cookie and trusts it without
verification; `getUser()` makes a live call that cryptographically verifies the JWT with the auth
server. **Reality:** `middleware.ts` + `app/(app)/layout.tsx` already used `getUser()` correctly — the
watchlist helper was the straggler. The DB-level guard (RLS `with check (… = auth.uid())`) would have
rejected a forged uid anyway, but the pre-RLS identity + the auth gate must still be honest.
**Lesson:** on the SERVER (middleware, Server Components, Server Actions, Route Handlers) use
`getUser()` whenever the return identifies/guards a user; keep `getSession()` only for a client-side
component or when you need JUST the `access_token` for a downstream call (no trust decision). New
shape: `const { data:{ user }, error } = await sb.auth.getUser(); if (error || !user) …` — fail CLOSED.
`getUser()` costs a network round-trip (~50-100ms) — fine at an auth boundary, never per-row/in a loop.
Merged main `67a1b89`.

## A breaking `derived` reshape also invalidates STORED FINAL records — the freeze path revalidates them
**Symptom (verify-phase2a C4, found 2026-07-02):** the C4 cache-poison check (claim SpaceX OPEN →
the serve must probe, catch resolution, and re-freeze) returned `lifecycle_state: undefined` — the
serve 422'd "Record invalid". **Reality:** `freezePriorRecord` (lib/compute.mjs) re-validates the
PRIOR record against the CURRENT schema before re-freezing, and the dev-seeded SpaceX row still
carries the PRE-SPLIT schema-1.3.0 single-tier confidence — the Increment-A artifact migration
covered the COMMITTED files (latest.json regenerated, history-full.json split in place; see the
existing entry below) but nobody re-seeded the DB. Any market whose stored record predates a
breaking reshape will 422 exactly at its freeze transition (resolution day — when the record
matters most). A characterization test locks the failure mode (test/coverage-gaps.test.js).
**Lesson:** a breaking `derived` reshape has THREE artifact surfaces, not two: code + fixtures,
committed `docs/api/v1/` files, **and stored DB records — above all the cache-final RESOLVED rows,
which no cron ever recomputes**. Re-seed them (dev + prod) as part of the reshape. Fix here:
operator re-runs `scripts/seed-spacex.mjs` (the seed source, latest.json, already has the new shape).

## A propagation pass must sweep EVERY display surface AND the backfill mirror — grep the pattern, don't trust the feature list
**Symptom (found 2026-07-02):** the percent-bucket pass (UK GDP) updated `fmtMoney/fmtRange/
impliedMedianLabel/DistributionSVG` but SIX more surfaces still hardcoded `'$'` adjacent to the
ladder unit (modeBucket, detailNarrative deltas, settlementZoneLabel, the Biggest Movers rung
label, HistoryChart's dual-tooltip/right-axis/legend/single-axis, TrendHistory's velocity/
dispersion magnitudes) → "$1–2%"-style mixed units; AND the backfill mirror (`fetchBackfillMeta`/
`bucketRecord`) never got the percent update at all — hardcoded `unit_prefix '$'`, a `v > 0`
boundary filter that drops 0/negative rungs, and an open-bottom leg's `lo = -Infinity` landing in
hashed raw_inputs (`JSON.stringify(-Infinity)` → `null` → a broken canonical).
**Lesson:** when a unit/shape rule changes, `grep -rn '\\$\\$\\{' `-style for the OLD pattern across
components/ + lib/ AND check the parallel backfill assemblers (lib/backfill*.mjs mirror the live
fetchers by construction — every live-path rule change must be mirrored or the reconstruction
diverges). The `-Infinity` case is the worst kind: it hashes and stores without erroring.

## Redefining a base TABLE via migration does NOT propagate to a dependent VIEW — `*` is frozen at create time
**Symptom (bit prod, 2026-07-01):** migration 0010 added `reliability_tier/score` + `liquidity_tier/score`
to `market_snapshots`, and its comment asserted "market_latest is `select distinct on (market_id) *`, so
the new columns surface automatically — no view recreation needed." **They did not.** Prod 500'd with
`Could not find the 'liquidity_score' column` on any read of the new columns through the view; dev was worse
(the view AND the table probed as not having the columns — a stale PostgREST cache reports the same
`column ... does not exist` error whether the column is truly absent or just uncached).
**Reality:** a Postgres view defined with `select *` has its `*` **expanded into an explicit column list
at CREATE time and frozen**. Adding columns to the base table afterwards changes the table, not the view —
the view keeps returning exactly the columns that existed when it was created. `alter table add column`
never touches the view. Two more traps ride along: (1) **`CREATE OR REPLACE VIEW` can only APPEND columns**
(it re-expands `*` and adds the 4 new ones at the end — fine here because `add column` appends); REMOVING
columns (the down-migration, going 18→14) needs **DROP + CREATE**. (2) **DROP+CREATE RESETS grants**
(`CREATE OR REPLACE` preserves them) — so a dropped-and-recreated view must be re-`grant`ed, and re-created
with `security_invoker = on` again or it silently reverts to owner-runs (the 2a RLS-bypass gotcha).
**Lesson:** after any `alter table` that a view should expose, add an explicit `CREATE OR REPLACE VIEW`
(same `select *` text re-expands it) in the SAME migration, and finish with `notify pgrst, 'reload schema'`
so PostgREST drops its stale cache — otherwise the API keeps reporting `column does not exist` even once the
column is really there. Never trust "`select *` will pick it up." Fixed in `0011_market_latest_view_refresh.sql`
(0010's comment corrected in place). A view-refresh down-migration must run BEFORE the column-drop down or the
view dependency blocks the drop. See [[decisions]] "A Postgres VIEW bypasses table RLS unless security_invoker".

## A server-rendered SVG can carry an interactive client overlay — pass it as `children`, keep props serializable
**Pattern (backfill-observability-chart-hover pass, not a bite):** to add hover/crosshair interactivity to
charts that are SERVER components (`DistributionSVG`, the touch `RangeBar`) WITHOUT making the whole chart
client-side, wrap the server `<svg>` in a client overlay component (`ChartCrosshair`, `'use client'`) and
pass the server SVG as `children`. RSC allows a client component to render server children, so the SVG
structure stays server-rendered; only the thin overlay (pointer capture + crosshair line + HTML tooltip)
ships JS. **Two constraints make it work:** (1) the overlay is a second absolutely-positioned `<svg>` with
the SAME viewBox and `preserveAspectRatio="none"`, so a pointer maps to viewBox-x by a plain ratio
(`((clientX-rect.left)/rect.width)*vbW`) — no SVG matrix math, and it aligns because every chart SVG is
`width:100%;height:auto` (rendered aspect == viewBox aspect). (2) **NOTHING that crosses the server→client
boundary may be a function** — so the crosshair takes serializable data only: `snap` mode gets
pre-formatted `{x, payload}` anchors; `interpolate` mode gets numeric arrays + a `{prefix,suffix,digits,scale}`
format spec and does the lerp+format client-side. A `resolve(x)=>tooltip` closure would have been cleaner
but is NOT serializable from a server component. **No hydration risk:** hover state starts null → SSR and
first client render both omit the tooltip (match); the crosshair marks are `<line>/<rect>/<circle>` (no SVG
`<text>`, so the single-string-child trap below doesn't apply); tooltips are plain HTML `<div>`. The pure
math (bracket/snap/tick-spacing/level-interp/format) lives in `lib/chart-hover.mjs` + is unit-tested
(`test/chart-hover.test.js`) — the interactive part stays an operator/browser gate. Categorical bars are
HORIZONTAL, so they use per-ROW hover (nearest-Y), not the x-crosshair — don't force every chart through the
axis-crosshair; match the interaction to the layout. See [[decisions]] and `lib/touch-rangebar.mjs` (same
pure-geometry-extracted-for-test precedent).

## A breaking `derived` SHAPE change must also update the committed `docs/api/v1/` artifacts the tests validate
**Symptom (hit during the confidence split):** after reshaping `derived.confidence` to `{reliability,
liquidity}`, three tests failed that had nothing obviously to do with the change — `firewall.test.js`
and `analytics-scenarios.test.js` (`schema /snapshot/derived/confidence must have required property
'reliability'`) and `history-invariants.test.js` (`history … missing confidence.reliability.tier`).
**Reality:** those tests load the COMMITTED published artifacts as real-data fixtures — `latest.json`
(run through `validateRecord` → schema) and `history-full.json` (run through `validateHistoryEntry`).
A breaking shape change to `derived` makes the OLD-shape committed artifacts fail the CURRENT validators.
`snapshot.js` can't regenerate them offline (it needs live gamma). So you must transform the artifacts:
- `latest.json` is the current record → RECOMPUTE its confidence from its own `raw_inputs` (it shares
  SpaceX's `raw_sha256`, so it reproduces cleanly) and replace only the confidence sub-block.
- `history-full.json` is HISTORICAL → do NOT re-derive (re-deriving without each day's original
  `raw_inputs` downgrades captured live-spread confidence to price-only — a dishonest rewrite). SPLIT
  the existing reasons IN PLACE: every historical reason here is a reliability signal, liquidity = the
  `deep books` default. Preserves each captured tier exactly.
- `history.csv` only gets a CSV-safety/field-count check → leave it (tier strings stay CSV-safe).
**Lesson:** a breaking `derived` reshape is not just code + the frozen fixture — grep `docs/api/v1/`
for the field and transform every committed artifact a test reads, choosing RECOMPUTE (current record)
vs IN-PLACE SPLIT (historical, un-reconstructable) per whether the source inputs still exist. See
[[decisions]] "Confidence SPLIT into two independent tiers".

## Changing a `.mjs` function signature breaks the consuming `.tsx` via JSDoc — update `@param`, not just the body
**Symptom (hit during the confidence split):** `core/` unit tests + `node --test` were all green and
`scoreConfidence` etc. were fully migrated, but `npx tsc --noEmit` then failed in the React layer:
`Object literal may only specify known properties, and 'reliabilityTier' does not exist in type '{ …
confidenceTier?: string … }'` at `BinaryDetailView.tsx`/`CategoricalDetailView.tsx`/`MarketDetailView.tsx`.
**Reality:** `lib/format-detail.mjs` is plain JS, but its exported functions are TYPED FOR TS CONSUMERS
BY THEIR JSDOC. I renamed the `binaryNarrative({…confidenceTier})` param in the function body but left
the `* @param {string|null} [o.confidenceTier]` JSDoc — so TS still inferred the OLD param object type
and rejected the new `reliabilityTier`/`liquidityTier` keys the `.tsx` call sites now pass. The runtime
was correct; only the TS contract (the JSDoc) was stale.
**Lesson:** when you change a `.mjs` function's destructured params, update its `@param` JSDoc IN THE
SAME EDIT — that JSDoc is the type contract the `.tsx` callers compile against. `node --test` won't
catch it (no type-check); `tsc --noEmit` / `next build` will. Run tsc after any `.mjs` signature change
that a component imports, not just the unit tests.

## A NEW always-present field on `derived` breaks SpaceX Gate 2 — omit-when-absent or compute display-side
**Symptom (anticipated + avoided, repeatedly, across the analytical-depth epic):** the SpaceX parity gate
`phase1-spacex-parity.test.js` **Gate 2 `deepEqual`s the ENTIRE `derived` block** (rebuilt from the frozen
inputs) against the frozen oracle. So adding ANY field that is always present on `derived` — `liquidity`
(windowed volume), `days_to_expiry`, etc. — makes SpaceX's rebuilt derived differ from the frozen one and
**fails Gate 2**, even though the value is "correct".
**Reality:** there are only two parity-safe ways to surface a new derived signal:
1. **OMIT-WHEN-ABSENT** — set the field only when its INPUT is present, and ensure SpaceX's Gate-2 replay
   has no such input. Gate 2 rebuilds `live` purely from the frozen `raw_inputs` (`{token_id, threshold,
   midpoint, best_bid, best_ask, volume}`), which carry NO windowed volume → `derived.liquidity` is
   omitted on SpaceX → byte-identical. This is why windowed volume + confidence's windowed signal are
   guarded `if (liquidity)` / `windowedVolumeSignal(null) === null`, and the score blend only adds its 5th
   term when present. (Same family as `near_settlement` omit-when-false and `midpoint_source`-in-raw_inputs.)
2. **COMPUTE DISPLAY-SIDE** — when the value is always derivable (e.g. days-to-expiry from `asset.resolves`),
   compute it at RENDER (`format-detail.daysToExpiryLabel`) and never put it in `derived` at all. The
   prompt's "add `derived.days_to_expiry` like midpoint_source" is a CATEGORY ERROR: midpoint_source lives
   in `raw_inputs` (ignored by the hash, ABSENT from derived) — it was never deep-equal'd. days_to_expiry
   on `derived` WOULD be, and SpaceX legitimately has one (can't omit-when-false).
**Lesson:** before adding a `derived` field, ask "is SpaceX's frozen replay guaranteed not to have this?"
If no → compute it display-side. A CONFIDENCE input (windowed volume, days-to-expiry) is fine to USE at
compute time without STORING it, as long as SpaceX's specific inputs make it a no-op (SpaceX: no windowed
→ null signal; ~550d → spread multiplier ×1.0). Re-run the parity gate after ANY `core/snapshot.js`,
`core/confidence.js`, or builder change — it caught nothing here because every addition followed this rule.

## Summed per-leg windowed volume EQUALS the event-level windowed volume (gamma) — sum legs, uniformly
**Symptom (measured, not bitten — pinned during Increment 1):** Gamma returns windowed volume at BOTH the
event level (`ev.volume24hr`) and per leg (`m.volume24hr`). The question was which to use for the aggregate
`derived.liquidity`. Measured across Anthropic/Fed/Silver: **Σ(per-leg `volume24hr`) == `ev.volume24hr`
to the cent (Δ 0.0%)**, same for `volume1wk`. So summing the per-leg windowed values is the authoritative
aggregate — and it's UNIFORM across all 5 market types (the meta fetchers already iterate legs), avoiding
ev-level plumbing that differs per fetcher. `aggregateLiquidity(legs)` sums; per-rung 24h for the table
is a `by_threshold` map keyed by the DERIVED rung (ladder: `threshold`; bucket: `lo/divisor`).
**Lesson:** for a multi-leg disjoint-market event, per-leg windowed volumes sum to the event total — don't
plumb the event-level field separately. (Verify with a quick `curl` if a new field's summation is ever in
doubt; gamma's disjoint Yes/No legs make the sum exact.)

## TWO `next dev` on one `.next` wedges everything — now blocked by a `predev` guard
**Symptom:** a second `next dev` started while one was running. Next silently falls back to the
next port (3000 → 3001), but BOTH share this project's single `.next` dir → webpack-runtime 500s,
stale-404s, and eventually EVERY route hangs (`curl 000`, 60s timeouts). It has masqueraded as
"`/api/search` hangs" and other phantom bugs, and recurred 3+ times across sessions (incl. mid-audit,
where it caused a FALSE "search is broken" finding — after recovery the search returned 200/580ms).
**Reality:** the corruption is the SHARED `.next`, not the second port. The processes look like two
pairs in `ps` (`next dev` parent + `next-server` worker each); `lsof -ti tcp:3000` + `tcp:3001` both
listen.
**Lesson / MITIGATION (now in place):** a **`predev` npm hook** (`scripts/predev-guard.mjs`) aborts
`npm run dev` when the intended PORT is already LISTENing or a `next dev` process exists, with a
"restart cleanly" message; bypass with `DEV_GUARD=off`. To recover a wedged env:
`pkill -f "next dev"; pkill -f "next-server"; rm -rf .next; npm run dev`. Same family as the
"Stale `.next` runs old middleware/build" trap below — **never run `next build` while `next dev` is
live** either (it writes the same `.next`). When a route mysteriously hangs, suspect a second server
BEFORE the route's code.

## A sourceable `.env.local` (`export KEY=val`) breaks a naive manual dotenv parse
**Symptom:** `scripts/check-backfill-status.mjs` (and `seed-history-dev.mjs`) reported
"SUPABASE_URL / SERVICE_ROLE_KEY not set" even though both were in `.env.local` and even after
`source .env.local`.
**Reality:** the `.env.local` lines are `export SUPABASE_URL=…` (so the file is `source`-able). The
manual parser split on the first `=` WITHOUT stripping the leading `export `, so it set
`process.env["export SUPABASE_URL"]` and the real `SUPABASE_URL` stayed unset. (`source` alone also
doesn't help a `node` child unless the vars are exported — which is why the file uses `export`.)
**Lesson:** a hand-rolled `.env` parser must **strip a leading `export `** before the key (and trim
+ unquote the value). Fixed in both scripts. If a script can't see creds that are "clearly there,"
check for `export `/quotes/`KEY = val` spacing before assuming the file is missing them.

## Audit DOM sweeps must scope to `[data-zone="detail-view"]` — the rail shares `data-field` names
**Symptom:** the live-market audit reported "detail implied median shows `—`" (F3) and "rail≠detail
confidence" (F4). Both were FALSE — detail-scoped, the median was `$2.10T` and confidence `HIGH`,
matching the rail.
**Reality:** the audit used `document.querySelector('[data-field="median"]')` / `'[data-field=
"confidence"]'` UNSCOPED. The watchlist rail rows use the SAME `data-field` names as the detail and
come FIRST in DOM order, so the selector grabbed the rail's first row (a categorical with `—`), not
the detail headline.
**Lesson:** when auditing the detail view, scope every query to `[data-zone="detail-view"] …`. A
genuinely-real rail finding hid underneath (categorical/null-median rail headline `—`, fixed via
`market-scan.headlineDisplay`) — so the artifact wasn't pure noise, but the "detail is broken"
framing was wrong. Re-measure with a scoped selector before reporting a cross-component discrepancy.

## CLOB prices-history: finer fidelity silently truncates depth; daily buckets align by DATE not timestamp
**Symptom (measured, not bitten — pinned during the backfill design):** building the history
backfill, the intuition "use a fine fidelity for resolution, `interval=max` for depth" is wrong on
both counts. `GET https://clob.polymarket.com/prices-history?market=<token>&interval=max&fidelity=N`
returns `{history:[{t,p}]}` where: with `fidelity=1` or `60` you get only the **last ~17 days**
(2569 / 430 points), while `fidelity=1440` (daily) returns the **FULL history to market creation**
(SpaceX: 162 daily points back to its first trade). So daily is the ONLY full-depth option — and
it's also exactly what a daily backfill wants. Second trap: the daily bucket `t` lands a few
SECONDS past 00:00 UTC and the exact second VARIES per token, so matching legs of one market by raw
`t` nearly always fails (two SpaceX legs shared only 36/160 raw timestamps) — but flooring each `t`
to its UTC DATE aligns them (159/161 shared dates). A token also occasionally skips a date (gap) and
only HAS data from its first trade onward.
**Reality:** `interval=max` caps the point count, so a finer fidelity trades depth for resolution;
and the per-bucket timestamp is not on a shared global grid to the second. The endpoint is also
behind Cloudflare (`cf-cache-status: HIT`, no rate-limit headers) and 403s the default urllib UA —
use `curl`/`fetch` with a UA. There is NO batch endpoint: one call per token (N calls/market).
**Lesson:** for any per-day reconstruction, fetch `interval=max&fidelity=1440` and key the series by
**UTC date** (`core/price-history.utcDate` → last point per date per token), forward-filling per-leg
gaps; never intersect raw `t`. `p` is a single price (no bid/ask, no per-day volume) → backfilled
rows carry `best_bid/ask=null, volume=null` and hash exactly like the live `last_trade` path. See
[[decisions]] "History backfill on add".

## A synthetic OPEN fixture market can't be served live — anchor cached_at/last_checked_at in the FUTURE
**Symptom:** the detail view runs the AUTHORITATIVE `serveMarket()` (not the rail's plain cache
read), which for an OPEN market either PROBEs gamma (within TTL, not probed in 60s) or RECOMPUTEs
(past the 15min TTL). A synthetic `dev-*` id has no live gamma event → the probe/recompute 502/404s
→ the detail won't render. So a dev fixture market that's OPEN appears to work for ~60s after
seeding (SERVE_FRESH while `last_checked_at` is recent) and then breaks — too fragile for a gate.
**Reality (`decide-cache-action.decideBeforeProbe`):** the ONLY no-network serve paths are
(1) `RESOLVED` → SERVE_FINAL forever, and (2) OPEN with `age = now − cached_at < TTL` AND
`now − last_checked_at < PROBE_TTL(60s)` → SERVE_FRESH. Setting BOTH `market_snapshots.cached_at`
and `markets.last_checked_at` to a FAR-FUTURE timestamp makes `age` and the probe-age permanently
NEGATIVE (< their thresholds) → SERVE_FRESH every time, zero network, while the market stays
semantically OPEN (the real Phase-3 "accruing history" scenario). RESOLVED would also avoid the
network but a "resolved" market that's "collecting history" is self-contradictory.
**Lesson:** to seed a serveable OPEN fixture, `writeRecord` it then UPDATE those two timestamps to
the future (`scripts/seed-history-dev.mjs`). Keep the fixture's PURE generators exported + guard the
`run()`/DB side with `import.meta.url === pathToFileURL(process.argv[1]).href`, so a unit test can
import the exact rows the seed inserts and prove the derived values offline (no DB) — the gate
numbers can't drift from the fixture. (`.env.local` is NOT reliable for the service-role key across
machines — the seed/Playwright stay an OPERATOR live gate, same as the Phase-1 history gate.)

## A bearer-authed API route gets session-redirected to /login by the auth middleware
**Symptom:** the new `/api/snapshot` cron route's own auth worked (401 without the bearer, 200
with it in isolation), but the actual batch never ran — a correct-bearer call returned the
**login page HTML** instead of the batch JSON, so `res.json()` blew up in the verify script.
Caught by the Phase 1 live gate (`scripts/verify-history.mjs`), not by any offline test.
**Reality:** `middleware.ts`'s matcher runs on `/api/snapshot`, and the public exception was
`pathname.startsWith('/api/market')` ONLY. The cron route is authenticated by a **CRON_SECRET
bearer, not a Supabase session cookie** — so to the session-auth middleware it looked
unauthenticated → `NextResponse.redirect('/login')`. `fetch` follows the redirect → the caller
gets login HTML with a 200. The route handler never executed; its own bearer check never ran.
**Lesson:** any route whose auth is NOT the session cookie (a bearer-authed cron, a public
no-store data route) must be EXCLUDED from the session-auth middleware — extend the exception
(`isNonSessionApi = startsWith('/api/market') || startsWith('/api/snapshot')`). The route's own
guard is then the gate. This is the same family as the prod-only failure modes the live gates
exist to catch — an offline build/tsc is green while the deployed/served behavior is broken;
run the live gate before declaring a cron route done. (`/signup` had the mirror-image need: it
must be treated as an AUTH route so an unauthenticated invitee can reach it.)

## Adding a field to derived[] breaks the frozen SpaceX parity gate (deep-equal) — omit-when-false
**Symptom:** (anticipated + avoided) adding `derived.near_settlement` to the ladder record would
have failed `phase1-spacex-parity.test.js` Gate 2 — it `deepEqual`s the ENTIRE derived block
(incl. confidence) against the frozen oracle, so an extra `near_settlement: false` key on SpaceX
is a diff, even though no value changed.
**Reality:** the parity gate is byte/structure-exact, not "values that exist match". A NEW additive
field on `derived` is still a structural change to SpaceX's frozen block. (This is why `lifecycle`
lives OUTSIDE `derived`, and why `market_shape` was only set for bucket markets.)
**Lesson:** when adding a `derived` field that only applies to SOME markets, **set it only when
truthy/relevant and OMIT it otherwise** (`if (_nearSettled) derived.near_settlement = true;`), so
the frozen-record shape is unchanged. Equally, any change to a SCORING formula (confidence) must be
gated so SpaceX's specific inputs don't trigger it (SpaceX is ~18mo from expiry → never
near-settled → carve-out never fires). Re-run the parity gate after ANY `core/snapshot.js` or
`core/confidence.js` change — it's the load-bearing guard, not a formality. See [[decisions]]
"Near-settlement … CONFINED to that path".

## TypeScript drops a narrowing inside a closure over a MUTABLE object property
**Symptom:** `next build` failed (tsc) on `HistoryChart.tsx`: `'sel.days' is possibly 'null'`
inside a `.filter(...)` callback, even though the line was `sel.days == null ? A : B` and the
closure was in the `B` (non-null) branch.
**Reality:** `sel.days` is a mutable property (`{days: number|null}[]`), and TS conservatively
drops a property narrowing when it's read inside a CLOSURE (the callback could run later, after the
property changed). Narrowing a `const` local persists; narrowing a mutable property access does not.
**Lesson:** hoist the narrowed value to a `const` BEFORE the closure (`const days = sel.days; …
days == null ? A : days * X`) — then the narrowing holds inside the callback. (tsc caught this at
build, not in `next dev`/the editor — run `next build` or `tsc --noEmit` before declaring UI done.)

## The survival pipeline silently mis-modeled non-survival markets (plausible-but-WRONG numbers)
**Symptom:** Bitcoin's detail showed "$53.58T" (should be $K); Anthropic showed median $1.84T
with mean $54.25T (a 30× ratio that screams "the math is broken"); WTI/Silver showed duplicate
thresholds (">$90" twice) and 12+ rows at an identical P(>X). No crash — just wrong numbers a
quant would trust.
**Reality (measured from live gamma):** `kindFromMarkets` labeled ANY multi-leg market with a
`$` in `markets[0].question` a 'ladder', and the survival math assumed every leg is P(value >
X). Only SpaceX-style "above $X" markets are that. Bitcoin/Anthropic are **bucket PMFs**
("between $X and $Y" / "less than" / "or greater") — each leg is P(in bucket), not P(>X).
WTI/Silver are **directional-touch** ("(LOW)/(HIGH) hit $X") — P(touch ≥/≤ X), tent-shaped,
non-monotone. The default parser `\$(\d+\.?\d*)` compounded it: it took the FIRST number,
dropping thousands-commas ("$56,000"→56) and unit suffixes ("$53.58K"→53.58, "$1.5T"→1.5), so a
mixed-unit ladder ("$600B" parsed 600 next to "$1.5T" parsed 1.5) blew the mean up via the
survival top-tail term (≈800·0.07). Duplicate thresholds were "(LOW)$90"/"(HIGH)$90"→both 90 and
"less than $56,000"/"between $56,000…"→both 56.
**Lesson:** The dangerous failure is a plausible WRONG number, not a crash. Before "fixing"
duplicate-threshold collisions (dedup) or a broken mean (trimmed mean), check whether the market
is even a survival ladder — it usually isn't. MODEL the shape (bucket → derive survival from the
PMF; touch → implied 50%-crossover range), don't patch survival-pipeline symptoms. Shape
detection MUST run before any threshold parse (a bucket market's "not IPO" leg and a categorical
leg both throw "Cannot parse threshold"). Fixed via the 5-type taxonomy (see [[decisions]]
"Market shape taxonomy"); SpaceX stays a pinned survival ladder, frozen hash byte-identical.

## A missing CLOB midpoint means an EMPTY book (not a one-sided book) — fall back to last_trade
**Symptom:** `core/fetch.js` threw `No midpoint for token X` and failed the WHOLE market
when ANY single rung lacked a midpoint — breaking live, active commodity ladders (Silver
XAGUSD, WTI) that have one or more illiquid rungs.
**Reality (measured against live CLOB):** when `/midpoints` omits a token, the orderbook is
**empty** — `/prices` returns NO best_bid AND NO best_ask, `/midpoint` → "No orderbook
exists", `/book` is empty. The intuitive fallback `(bid+ask)/2` almost never applies (there's
no bid/ask). Across WTI+Silver weekly+WTI monthly, **all 9 no-midpoint rungs had only a
`last-trade-price`** (deep ITM/OTM near-settled rungs, e.g. >$75 WTI pinned at 0.999). So the
fix's load-bearing tier is **`last_trade_price`**, not bid/ask. Priority: `clob_midpoint` →
`bid_ask_mean` → single side → **`last_trade`** → skip the rung → fail only if ALL rungs are
dead. Skipping a *middle* rung punches a hole in the CDF, so `last_trade` (keeps the rung) is
tried before skip.
**Provenance tradeoff (deliberate):** `raw_inputs` records `midpoint_source` (+ `last_trade_price`
when used) so an auditor sees exactly how each midpoint was derived — but these fields are
**NOT** in `canonicalizeRawInputs`, so the **hash recipe is untouched** and the **frozen SpaceX
`raw_sha256` stays byte-identical** (`c1be52e4…b89003`; SpaceX is cache-final and never
recomputed, and all its rungs are real midpoints → no fallback branch runs). Consequence: the
resolved midpoint **value** is tamper-evident (it IS hashed), but the **source label** is
metadata (not hashed). Accepted to keep the recipe stable. Confidence degrades honestly:
"N rung(s) priced from last trade (no live book)" / "M rung(s) excluded (no price)".
**Lesson:** don't assume a missing midpoint leaves a usable book — it usually doesn't. When
adding provenance fields to `raw_inputs`, keep them OUT of the canonicalizer or you silently
break every stored hash. Verify the frozen parity gate after ANY `core/fetch.js` change.

---

## SVG `<text>`/`<title>` with adjacent dynamic+static children mis-hydrates — use ONE string child
**Symptom:** the 2c.3 detail page threw React **"Hydration failed because the server rendered HTML didn't
match the client"**, the tree bottoming out at a distribution-SVG `<title>` (`+ {"<$1"}`). It rendered fine
visually (React regenerates the subtree client-side) but logged a console error every load. Easy to misread
as the **stale-`.next`/stale-tab** noise that appears alongside it (versioned `_next/static/*.js?v=…` 404s) —
those vanish on a clean reload; the hydration error did NOT, so it was real.
**Reality:** SVG `<text>`/`<title>` with MULTIPLE adjacent children mixing expressions and literals
(`{g}%`, `median ${m}{unit}`, `{label}{unit} · {pct}%`) serialize with text-segment markers that the browser's
SVG text-node parsing normalizes differently than React's client render → node-count mismatch → hydration
fails. The values were fully deterministic (no Date/random) — the structure, not the data, was the bug.
**Lesson:** inside SVG `<text>`/`<title>` (and the same family: `<option>`, `<textarea>`), make the content a
**single string child** — one template literal: `{`median $${m}${unit}`}` not `median ${m}{unit}`. To triage a
hydration error: clean-reload first to clear stale-asset 404 noise; if it persists, read the tree path React
prints — it names the exact offending node. (Caught by the Playwright console check, not the build — `next
build`/tsc are both clean with this latent bug. Same stale-artifact-vs-real-bug discrimination as the edge/
.next family above.)

## Vercel's @vercel/next builder does NOT honor `outputFileTracingIncludes` — bundle data, don't readFileSync
**Symptom:** a Next route handler (`app/api/market/route.ts`) ran `core/` which `readFileSync`'d
`core/methodology.json` at runtime. `next.config` had `outputFileTracingIncludes: { '/api/market':
['./core/**', …] }`. Locally everything looked right — the route's `.nft.json` listed the files AND
`output:'standalone'` copied them into the deployable output. But the **deployed Vercel function 500'd**
with `ENOENT … /vercel/path0/core/methodology.json`. Two next.config attempts (key, then
`outputFileTracingRoot` pin) both failed on deploy while passing locally.
**Reality:** Vercel's `@vercel/next` builder packages functions differently from `next build` /
`output:standalone` — it does **not** reliably bundle the extra files declared in
`outputFileTracingIncludes`. So a local trace/standalone check is **NOT** a faithful proxy for what
Vercel deploys. (The 2a raw-function `vercel.json functions.includeFiles` worked, but that mechanism
does not carry over to Next-managed route handlers.)
**Lesson (durable fix):** for serverless route handlers, **don't `readFileSync` at runtime — `import`
the data so the bundler inlines it into the JS** (`import x from './x.json' with { type: 'json' }`).
Dynamic `readdirSync` over a dir → a static manifest module that imports each file
(`core/markets/manifest.mjs`). Then there is no file read → no trace dependency → no ENOENT, on any
platform. Confirm locally by grepping the built `.next/server/app/**/route.js` for the inlined data and
that **no `readFileSync`** of it remains (the `.nft.json` may still *list* the source file — harmless,
since nothing opens it). Preserve fresh-object-per-call semantics with `structuredClone` (verify the
frozen parity hash is unchanged — it was). See [[decisions]] Phase 2c.

## Stale `.next` runs old middleware/build — `rm -rf .next` when switching build↔dev or changing runtime
**Symptom:** added `export const config = { runtime: 'nodejs' }` to `middleware.ts`; `next build`
produced a correct Node middleware bundle, but `next dev` still ran it on **edge-server** (env undefined,
500). Earlier in the same saga, env/runtime fixes "didn't take" until `.next` was cleared. Cost several
round-trips chasing config when the code was already right.
**Reality:** `next dev` compiles middleware lazily and **reuses a stale `.next`**; interleaving
`next build` and `next dev` in the same `.next` leaves mixed/stale artifacts (stale edge middleware,
stale env inlining). The config was correct the whole time.
**Lesson:** after changing middleware **runtime**/config, env wiring, or `next.config`, **`rm -rf .next`
then restart** — don't trust a warm `.next`. Confirm the middleware runtime with a temp
`console.log(process.env.NEXT_RUNTIME)` (expect `nodejs`) **before** running gates, rather than
discovering via a 500. This is the **same stale-artifact family** as the Vercel-edge-replay, the
http.server browser cache, and the deploy-timing traps — when a config change "doesn't take," suspect a
stale build cache before the config.

## Vercel edge-caches `public, max-age` responses and replays them — the function never runs
**Symptom:** Phase 2a live verify C2 failed: a 2nd `/api/market` call within TTL returned
`cached:false` on a market that was genuinely OPEN — but with the SAME `fetched_at` as call #1 and
NO new snapshot row. By elimination from the committed code, NO serve path can emit
`OPEN + cached:false + same-fetched_at + no-new-row` — the function did **not run** on call #2.
**Reality:** `api/market.mjs` set `Cache-Control: public, max-age=30` on 200s. **Vercel's Edge Network
caches a `public, max-age` response and replays it** (confirmed by `x-vercel-cache: HIT` on call #2,
`MISS` on call #1). Call #1 was a miss → ran the function → returned `cached:false` → the edge cached
THAT response for 30s → every repeat within the window got the replayed body, function skipped. The
Supabase cache, serve path, and `cached` flag were all CORRECT — only the CDN layer lied.
**The real danger isn't the flag — it's resolution correctness:** edge-replaying a response **bypasses
the per-call resolution probe** (`decideBeforeProbe → PROBE → probeLifecycle`), so a market that
resolved after caching could be served as **OPEN** for the whole cache window — the exact stale-live
gap C4 exists to prevent. Unacceptable for a fund-facing feed even at 30s.
**Lesson:** `/api/market` must **NOT** be HTTP-cached — set `Cache-Control: no-store`. The Supabase
cache (server-side, consulted on every real invocation) is the cost layer; the per-call probe is the
correctness layer; HTTP caching skips both. When a REPEAT call behaves suspiciously, **check
`x-vercel-cache`** before suspecting your logic. **Third instance** of caching-masquerading-as-logic-bug
(see "Playwright verified a STALE page" and "Deploy timing masquerades as a data bug").

## A Postgres VIEW bypasses table RLS unless security_invoker=on (Supabase "Unrestricted")
**Symptom:** `markets`/`market_snapshots` show RLS-locked, but Supabase flags the `market_latest`
VIEW as "Unrestricted" — and `anon` can read every underlying row through it via PostgREST.
**Reality:** A view runs with its OWNER's privileges by default (security-definer style). Created in the
SQL editor → owned by `postgres`, which owns the base tables, and **RLS is not enforced for a table's
owner** → the view sees all rows. Combined with Supabase's default `anon` SELECT grant on new `public`
objects, anon reads the whole table through the view. RLS on the base table only protects DIRECT
access by non-owner roles (anon), not access via an owner-run view.
**Lesson:** Add `with (security_invoker = on)` to every view over an RLS table (PG 15+) so it runs as
the QUERYING role and inherits the table's RLS. Then anon→0 rows, service-role→all rows, and a later
public-SELECT policy flows through automatically. Fix in the migration; patch a live view with
`alter view public.<v> set (security_invoker = on);`. (Fallback on PG<15: revoke anon/authenticated
SELECT on the view.)

## Vercel functions need core/ JSON files bundled (readFileSync at runtime)
**Symptom (anticipated):** a deployed `api/market.mjs` could 500 with ENOENT — `core/validate.js`
(`docs/api/v1/schema.json`) and `core/market-config.js` (`core/markets/*.json`,
`core/methodology.json`, `core/assumptions.json`) read those files via `readFileSync` at runtime, and
Vercel's bundler won't trace a dynamic `readdirSync`/templated path.
**Fix:** `vercel.json` `functions["api/market.mjs"].includeFiles = "{core/**,docs/api/v1/schema.json}"`
bundles them. If you add a function that imports `core/`, add the same includeFiles. Confirm on the
first deploy (call the function; an ENOENT means the glob missed a file). `pinnedConfigFor` wraps its
`readdirSync` in try/catch → falls back to the generic default rather than crashing.

## A RESOLVED Polymarket market returns NO CLOB midpoints — classify before fetching prices
**Symptom:** `scripts/snapshot.js` crashed live with `No midpoint for token …`; the old v1 cron had
been failing on every run. (2026-06-17, when SpaceX actually resolved.)
**Reality:** Once a market resolves, trading ends and `POST /midpoints` returns `{}` — `fetch.js`
threw on the first missing midpoint. Gamma still serves the event with `closed:true` +
`umaResolutionStatus:"resolved"` + settled `outcomePrices` (["1","0"]/["0","1"]); only CLOB is empty.
Note `active` stays `true` and `endDate` can be far-future even after resolution — they are NOT
resolution signals.
**Lesson:** Classify lifecycle from **gamma meta BEFORE any CLOB call** (`fetchEventStatus` →
`classifyLifecycle`); if the market is not OPEN, **freeze** the prior record instead of price-fetching
it. Use `closed` + `umaResolutionStatus` (not `active`/`endDate`). The realized outcome is the rung
where `outcomePrices` settled to "1" (SpaceX: >$2T Yes, >$2.2T No → cap in $2.0–2.2T). See
[[decisions]] two-stage resolution.

## Playwright "verified" a STALE page — browsers heuristically cache python http.server
**Symptom:** Edited `docs/index.html`, navigated to it via Playwright, ran a behavior test — and the
NEW code wasn't there (`load.toString()` showed the pre-edit function). The failure-semantics test
"failed" against code that didn't contain the fix. Cost real time (2026-06-12).
**Reality:** `python3 -m http.server` sends no cache headers, so the browser applies HEURISTIC
caching and can serve the previously-loaded page on re-navigation. The disk file was correct the
whole time.
**Lesson:** After editing a served file, verify on a FRESH port (or with a cache-busting query) and
*assert the code under test is actually present* (`/silent && LATEST/.test(load.toString())`) before
trusting any behavioral result. Source-level node tests (test/dashboard-contract.test.js) don't have
this problem — trust them over a possibly-cached browser when they disagree.

## "Re-run jobs" replays the workflow at the ORIGINAL commit — not your YAML fix
**Symptom:** Fixed a bug in `.github/workflows/update.yml`, pushed it, then clicked GitHub's
**"Re-run jobs" / "Re-run failed jobs"** on the failed run — and it failed the **same way**, as if the
fix never landed. (Cost real time today.)
**Reality:** Re-running a run replays the workflow **at the exact commit SHA the original run used**, with
the original workflow file and event payload. A workflow YAML change pushed afterward is **not** picked
up by re-running — re-run is "retry this historical run", not "run latest".
**Lesson:** After editing a workflow file, trigger a **fresh** run, never "Re-run jobs":
`gh workflow run update.yml -f mode=snapshot` (or the **Run workflow** button on the Actions tab). The
fresh dispatch checks out the latest `main` and uses the updated YAML. Verify the run's commit SHA is
your fix, not the old one.

## Verifier: price-match window ≠ liveness window (two different horizons)
**Symptom:** `scripts/verify-accuracy.js` returned **FAIL** on a correct, recently-published snapshot
because one thin mid-tail threshold (`$2.6T`) had drifted ~5pt since publish.
**Reality:** The first cut used **one** 26h window and asserted the published raw_prob should match the
live CLOB midpoint within ±2pt for anything <26h old. But markets move several points intraday — a 2pt
match is only meaningful while a snapshot is **minutes-to-a-few-hours** old. The fix splits two
distinct horizons: **price-match** (≤ ~3h, `PRICE_MATCH_WINDOW_H` — strict ±2pt is a hard PASS/FAIL)
vs **liveness/stale** (> `STALENESS_WINDOW_H`, shared with the dashboard via `core/freshness.js`;
50h under the old daily cadence, **17h** since the 2026-06-12 2h-cadence migration — derived from
the schedule, see [[decisions]]).
Between them ("aged") deltas are reported **descriptively as expected market drift, never a FAIL**.
**Lesson:** Don't conflate "is the price still accurate?" (hours) with "is the pipeline alive?" (days).
And **never widen the ±2pt tolerance** to make aged data pass — that blinds the check to real source
errors; bound *when* the strict check applies instead. Canonical green path: **snapshot, then verify
while seconds-old** → tight match → exit 0 (the CI pattern). See [[decisions]] freshness policy.

## memory.sh prints a stale hardcoded "ASTROPHYSICS APPLET" briefing
**Symptom:** At session start, `bash ~/.claude/memory.sh` printed a project-status block for a
DIFFERENT project — "ASTROPHYSICS APPLET", `vlbi-react/`, "Prof. Cardenas-Avendano", an angular-size
meeting — none of which exist in polymarket-tracker.
**Reality:** `~/.claude/memory.sh` reads THIS repo's real git state (branch/commits are correct) but
then echoes a **hardcoded prose block** left over from a previous project. The git facts are live; the
narrative is contaminated/stale.
**Lesson:** Trust `primer.md` + `.workflows/_knowledge/*` for project state, **not** the memory.sh
prose block. The script's static "PROJECT STATUS" text needs fixing (it's in `~/.claude/`, outside this
repo). Don't act on the astrophysics briefing — it's not this project.

## Deploy timing masquerades as a data bug
**Symptom:** Dashboard showed "Unable to load current data" / "Run backfill to populate history."
**Reality:** Not a data bug — GitHub Pages was mid-deploy and briefly serving a 404 for
`data.json`/the API; the local files and repo were correct the whole time.
**Lesson:** Before diagnosing a "broken data" report, fetch the LIVE artifact and check HTTP status,
and **wait for Pages to propagate** (poll `latest.json` until the new `methodology_version`/content
appears — usually <90s). Also: `load()` now separates fetch failure from render failure so a render
bug can't masquerade as a load failure.

## Pinned dep versions can be unbuildable on the local Node
**Symptom:** `npm install` failed compiling `better-sqlite3` 9.x against Node 25.
**Fix:** Bumped to `better-sqlite3` 12.x (has prebuilds for current Node). Same class of risk for any
native module.
**Lesson:** Pin exact versions, but **verify `npm ci` is clean on the actual Node in use** before
trusting a pin. A spec's pinned version may predate your runtime.

## The cron bot commits to main — rebase before pushing
**Symptom:** `git push` rejected ("fetch first"); the automated snapshot bot
(`polymarket-tracker[bot]`, "chore: snapshot …") had committed to `main` while you worked.
**Fix:** `git fetch` → `git rebase origin/main`; conflicts are only in **generated** files
(`docs/api/v1/**`, baked `docs/index.html`/`note.html`) → take your version
(`git checkout --theirs <file>` during rebase) → `git rebase --continue` → **re-run
`node scripts/snapshot.js`** to regenerate a consistent state → amend → push.
**Lesson:** Always `git fetch`/rebase before pushing. Snapshot cron is **every 2h, 12:00–00:00 UTC**
(`0 0,12,14,16,18,20,22 * * *`, since 2026-06-12 — was daily 14:00); the 14:30 + 21:00 runs are
**weekday-only** email runs (`* * 1-5`). At 7 bot commits/day the rebase-before-push discipline
matters MORE, not less.
**RESOLVED in CI (2026-06-08):** `update.yml`'s commit step now **self-heals** — it fetches +
`git rebase -X theirs FETCH_HEAD` + pushes, retrying up to 5×, and a `concurrency: snapshot-commit`
group serializes runs (proven green, run 27154304762). You still rebase manually for your OWN pushes.

## pm2 was decommissioned — do NOT re-add it
**Symptom:** (Would cause) duplicate daily runs / double commits.
**Reality:** Production scheduling moved from local **pm2** to **GitHub Actions** (`update.yml`,
3 crons). `ecosystem.config.cjs` remains only as a local fallback artifact.
**Lesson:** Don't `pm2 start` the tracker on the server expecting it to be "the" scheduler — Actions
owns it. Re-adding pm2 = two schedulers = duplicate snapshots.

## Snapshot bakes the HTML — re-read before editing index.html/note.html
**Symptom:** `Edit` failed with "File has been modified since read" right after running
`node scripts/snapshot.js`.
**Reality:** `renderers/dashboard.js` `bakeFallback()` rewrites the `<!--BAKE:…-->` regions of
`docs/index.html` and `docs/note.html` on every snapshot run.
**Lesson:** If you run snapshot, **re-Read** those HTML files before the next Edit. Also: bake uses a
**function** replacement (not a string) so a value containing `$` (e.g. "$2.19T") isn't mangled as a
regex backreference — don't revert that.

## Validation that recomputes invariants from inputs can be tautological
**Symptom:** A "bucket probabilities sum to 1.0" check passed even on corrupted data.
**Reality:** Recomputing buckets from `prob` always telescopes to 1.0 — it caught nothing.
**Lesson:** Validate the **stored** values (`bucket_prob`) and their **consistency** with `prob`, not
a fresh recomputation. (Fixed in `core/validate.js`.)
