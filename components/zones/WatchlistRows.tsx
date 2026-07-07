'use client';
// components/zones/WatchlistRows.tsx — the rail's interactive row list (Zone 1).
//
// Receives ALREADY-ASSEMBLED light scan rows (lib/market-scan.assembleScanRows) from
// the WatchlistRail Server Component — no fetching, no secrets, no raw record here.
// Responsibilities: (1) SELECTION — set ?m=<market_id> so Zone 2 (2c.3) can read it
// server-side, and visibly mark the selected row; (2) render the dense pills using the
// EXISTING globals.css semantic tokens (confidence / delta / lifecycle / stale) — no
// new colors; (3) compute FRESHNESS client-side (live `now`), mirroring docs/index.html
// renderFreshness, so the stale pill is honest and there's no SSR hydration mismatch.

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { removeMarket } from '@/app/(app)/actions';
import { KBD } from './kbd';

export interface ScanRow {
  market_id: string;
  title: string;
  kind: 'binary' | 'threshold_ladder' | 'directional_touch' | 'categorical';
  scopes: Array<'personal' | 'org'>;
  personal: boolean;
  org_id: string | null;
  org_ids: string[]; // every org this market is shared in (drives the Personal/Org toggle filter)
  median_display: string; // probability % for binary, $median for ladder (kind-formatted server-side)
  // Two-dimension confidence (0010): reliability (trustworthy number) + liquidity (can transact).
  // Null for a pre-split row → that dot renders neutral ("—").
  reliability_tier: 'high' | 'medium' | 'low' | null;
  liquidity_tier: 'high' | 'medium' | 'low' | null;
  lifecycle_state: 'OPEN' | 'CLOSED_PENDING' | 'RESOLVED' | null;
  is_final: boolean;
  stale_after: string | null;
  fetched_at: string | null;
  delta_display: string | null;
  delta_dir: 'up' | 'down' | 'flat';
  volume: number | null; // Enh 2: drives the volume tint
  volume_24hr: number | null; // Increment 1: 24h primary liquidity signal
  near_settlement: boolean; // Enh 2: near-settlement clock
  has_scan: boolean;
}

const CONF_LABEL: Record<string, string> = { high: 'HIGH', medium: 'MED', low: 'LOW' };

/** Compact 24h volume for the rail liquidity chip ($52K / $1.2M / $478). */
function fmtVol24(v: number | null): string | null {
  if (v == null) return null;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${Math.round(v / 1e3)}K`;
  return `$${Math.round(v)}`;
}
const LIFECYCLE_CLASS: Record<string, string> = { OPEN: 'state-open', CLOSED_PENDING: 'state-pending', RESOLVED: 'state-resolved' };

function ageLabel(hours: number): string {
  if (!isFinite(hours) || hours < 1) return 'just now';
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Freshness is time-dependent → computed from the PARENT's single client clock (live `now`,
 *  null pre-mount) to stay honest and avoid a hydration mismatch. A RESOLVED market is DONE,
 *  not stale: it shows muted plain text and is excluded from the stale calc entirely. The
 *  lifecycle check takes PRIORITY over stale_after — a resolved market can never be stale,
 *  even if a stale_after somehow lingers or is_final wasn't set (defence against divergence). */
function Freshness({ now, staleAfter, fetchedAt, isFinal, lifecycleState }:
  { now: number | null; staleAfter: string | null; fetchedAt: string | null; isFinal: boolean; lifecycleState: ScanRow['lifecycle_state'] }) {
  if (lifecycleState === 'RESOLVED' || isFinal) {
    return <span className="wl-fresh"><span className="wl-resolved-pill" title="market resolved — final record">resolved</span></span>;
  }
  if (now == null || !fetchedAt) return <span className="wl-fresh" suppressHydrationWarning />; // pre-mount: no SSR clock
  const ageH = (now - Date.parse(fetchedAt)) / 3_600_000;
  const stale = staleAfter != null && now > Date.parse(staleAfter);
  return (
    <span className={`wl-fresh ${stale ? 'is-stale' : 'faint'}`}>
      {ageLabel(ageH)}{stale && <span className="wl-stale-pill"> stale</span>}
    </span>
  );
}

/** Signature element: the split signal bar's per-segment colors. Reliability (top) and
 *  liquidity (bottom) tier → semantic token; unknown half → structural border gray; a
 *  RESOLVED/final market carries no live signal → both segments go faint gray. */
const TIER_VAR: Record<string, string> = { high: 'var(--c-high)', medium: 'var(--c-med)', low: 'var(--c-low)' };
function signalBarVars(r: ScanRow): { rel: string; liq: string } {
  if (r.lifecycle_state === 'RESOLVED' || r.is_final) return { rel: 'var(--text-faint)', liq: 'var(--text-faint)' };
  return {
    rel: r.reliability_tier ? TIER_VAR[r.reliability_tier] : 'var(--border-strong)',
    liq: r.liquidity_tier ? TIER_VAR[r.liquidity_tier] : 'var(--border-strong)',
  };
}

type View = { mode: 'personal' } | { mode: 'org'; orgId: string };

export function WatchlistRows({ rows, orgs = [] }: { rows: ScanRow[]; orgs?: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  const selected = useSearchParams().get('m');
  const [removing, startRemove] = useTransition();
  // ONE client clock for the whole rail (staleness both fades the signal bar and drives the
  // freshness text) — null until mount so SSR and first client render agree (no hydration skew).
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  // A failed remove (expired session, RLS denial) must be visible — silently doing nothing
  // teaches the user the × is broken. Cleared on the next attempt.
  const [removeError, setRemoveError] = useState<string | null>(null);

  // Item 3: Personal/Org toggle. Pure client-side filter over the union rows we already have
  // (each row carries `personal` + `org_ids`). Default is Personal; the toggle is hidden when the
  // user has no orgs (the list is then just their personal watchlist, unchanged).
  const [view, setView] = useState<View>({ mode: 'personal' });
  const activeOrg = view.mode === 'org' ? view.orgId : null;
  const filtered = rows.filter((r) => (view.mode === 'personal' ? r.personal : r.org_ids.includes(view.orgId)));

  // Keyboard navigation (Enh 8): a focus CURSOR distinct from the URL selection — J/K move
  // it, Enter opens it. A ref backs the window listeners (no stale closures); state drives
  // the .wl-focused highlight. The cursor starts on the selected row.
  const [focus, setFocus] = useState(-1);
  const focusRef = useRef(-1);
  const setF = (n: number) => { focusRef.current = n; setFocus(n); };
  // Keyboard nav operates over the CURRENTLY-VISIBLE (filtered) rows. A ref holds the latest
  // filtered list so the window listeners stay stable (no re-subscribe per render).
  const filteredRef = useRef(filtered);
  filteredRef.current = filtered;
  const viewKey = view.mode === 'org' ? `org:${view.orgId}` : 'personal';

  useEffect(() => {
    const i = filteredRef.current.findIndex((r) => r.market_id === selected);
    setF(i); // -1 when nothing is selected / not in the current scope
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, viewKey, filtered.length]);

  useEffect(() => {
    function scrollTo(id: string) {
      document.querySelector(`[data-zone="rail-list"] [data-market-id="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    }
    function onNav(e: Event) {
      const list = filteredRef.current;
      if (list.length === 0) return;
      const dir = ((e as CustomEvent).detail?.dir ?? 1) as number;
      const cur = focusRef.current;
      const next = cur < 0 ? (dir > 0 ? 0 : list.length - 1)
        : Math.max(0, Math.min(list.length - 1, cur + dir));
      setF(next);
      scrollTo(list[next].market_id);
    }
    function onOpen() {
      const list = filteredRef.current;
      const i = focusRef.current;
      if (i >= 0 && list[i]) router.push(`/?m=${encodeURIComponent(list[i].market_id)}`, { scroll: false });
    }
    function onEscape() { setF(-1); }
    window.addEventListener(KBD.nav, onNav);
    window.addEventListener(KBD.open, onOpen);
    window.addEventListener(KBD.escape, onEscape);
    return () => {
      window.removeEventListener(KBD.nav, onNav);
      window.removeEventListener(KBD.open, onOpen);
      window.removeEventListener(KBD.escape, onEscape);
    };
  }, [router]);

  function remove(r: ScanRow) {
    // Remove from the CURRENTLY-VIEWED scope: Personal view → the personal entry; an org view →
    // that org's entry. (A market on both lists is removed only from the list you're looking at.)
    const orgId = view.mode === 'personal' ? null : view.orgId;
    setRemoveError(null);
    startRemove(async () => {
      const res = await removeMarket(r.market_id, orgId);
      if (!res.ok) setRemoveError(res.error ?? 'could not remove from watchlist');
    });
  }

  const orgName = (id: string | null) => orgs.find((o) => o.id === id)?.name ?? 'Org';
  return (
    <>
      {orgs.length > 0 && (
        <div className="wl-toggle" role="group" aria-label="watchlist scope" data-field="rail-scope-toggle">
          <button
            type="button"
            className={`wl-toggle-btn${view.mode === 'personal' ? ' is-active' : ''}`}
            aria-pressed={view.mode === 'personal'}
            onClick={() => setView({ mode: 'personal' })}
            data-field="scope-personal"
          >Personal</button>
          {orgs.length === 1 ? (
            <button
              type="button"
              className={`wl-toggle-btn${view.mode === 'org' ? ' is-active' : ''}`}
              aria-pressed={view.mode === 'org'}
              onClick={() => setView({ mode: 'org', orgId: orgs[0].id })}
              data-field="scope-org"
            >{orgs[0].name}</button>
          ) : (
            <select
              className={`wl-toggle-select${view.mode === 'org' ? ' is-active' : ''}`}
              value={activeOrg ?? ''}
              onChange={(e) => setView({ mode: 'org', orgId: e.target.value })}
              aria-label="select an org watchlist"
              data-field="scope-org-select"
            >
              <option value="" disabled>Org ▾</option>
              {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          )}
        </div>
      )}
      {removeError && (
        <div className="wl-error faint" role="alert" data-field="remove-error">✗ {removeError}</div>
      )}
      {filtered.length === 0 ? (
        <div className="empty" data-zone="rail-empty-scope">
          {view.mode === 'personal'
            ? 'No markets in your personal watchlist.'
            : `No markets in ${orgName(activeOrg)}'s watchlist.`}
        </div>
      ) : (
    <ul className="wl-list" data-zone="rail-list">
      {filtered.map((r, i) => {
        const isSel = r.market_id === selected;
        const isFocus = i === focus;
        const relLabel = r.reliability_tier ? CONF_LABEL[r.reliability_tier] : '—';
        const liqLabel = r.liquidity_tier ? CONF_LABEL[r.liquidity_tier] : '—';
        const lifeClass = r.lifecycle_state ? LIFECYCLE_CLASS[r.lifecycle_state] : 'is-flat';
        // Signature element: the split signal bar (reliability top / liquidity bottom) replaces
        // the two confidence dots, the volume-tint gradient, and the state pill boxes. Rendered
        // as an absolutely-positioned ::before (NOT border-left — that would enter the box model
        // and shift the row layout). Staleness fades the bar: aged data = attenuated signal.
        const bar = signalBarVars(r);
        const resolved = r.lifecycle_state === 'RESOLVED' || r.is_final;
        const stale = !resolved && now != null && r.stale_after != null && now > Date.parse(r.stale_after);
        return (
          <li key={r.market_id} className="wl-li">
            <Link
              href={`/?m=${encodeURIComponent(r.market_id)}`}
              scroll={false}
              className={`wl-row${isSel ? ' wl-selected' : ''}${isFocus ? ' wl-focused' : ''}${stale ? ' is-stale-row' : ''}`}
              style={{ ['--sig-rel' as string]: bar.rel, ['--sig-liq' as string]: bar.liq }}
              title={`Reliability ${relLabel} · Liquidity ${liqLabel}`}
              aria-current={isSel ? 'true' : undefined}
              data-market-id={r.market_id}
              data-selected={isSel ? 'true' : undefined}
              data-focused={isFocus ? 'true' : undefined}
              data-reliability={r.reliability_tier ?? undefined}
              data-liquidity={r.liquidity_tier ?? undefined}
            >
              <div className="wl-row-top">
                <span className={`wl-dot ${lifeClass}`} title={r.lifecycle_state ?? 'unknown'} aria-hidden="true" />
                {r.near_settlement && <span className="wl-near" title="near settlement" aria-label="near settlement">◐</span>}
                <span className="wl-title" title={r.title}>{r.title}</span>
                {r.kind === 'binary' && <span className="wl-chip label" title="binary (Yes/No) market">Y·N</span>}
                {r.scopes.includes('org') && <span className="wl-chip label" title="shared org watchlist">ORG</span>}
              </div>
              <div className="wl-row-data num">
                <span className="wl-median" data-field="median">{r.median_display}</span>
                <span className={`wl-delta is-${r.delta_dir}`} data-field="delta">{r.delta_display ?? '—'}</span>
                {/* Increment 1: 24h volume — the primary liquidity signal (recent, not all-time). */}
                {fmtVol24(r.volume_24hr) && (
                  <span className="wl-vol24 faint" data-field="volume-24h" title="24h volume (recent liquidity)">{fmtVol24(r.volume_24hr)}/24h</span>
                )}
                <Freshness now={now} staleAfter={r.stale_after} fetchedAt={r.fetched_at} isFinal={r.is_final} lifecycleState={r.lifecycle_state} />
              </div>
            </Link>
            <button
              type="button"
              className="wl-remove"
              onClick={() => remove(r)}
              disabled={removing}
              title="remove from watchlist"
              aria-label={`remove ${r.title}`}
              data-field="remove-btn"
              data-market-id={r.market_id}
            >
              ×
            </button>
          </li>
        );
      })}
    </ul>
      )}
    </>
  );
}
