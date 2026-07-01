'use client';
// components/zones/MarketSearch.tsx — Zone 3 search+add, the command-bar island.
// Keyboard-first: ⌘/Ctrl-K focuses, ↑/↓ move, Enter SELECTS (previews) a result, Esc dismisses,
// click-outside closes. Debounced fetch to the /api/search proxy (no direct gamma call).
//
// Issues 1 + 4 (UX pass): selecting a result no longer auto-adds. A click/Enter PREVIEWS it
// (highlights + opens an action bar) WITHOUT committing; the user then presses an explicit
// per-scope button — "Add to Watchlist"/"Personal" plus one button per org they belong to — which
// runs the addMarket server action (compute-then-add) for that scope and navigates to the detail.
// This replaces the old auto-add-on-click + scope <select> dropdown.

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { addMarket } from '@/app/(app)/actions';
import { KBD } from './kbd';
import { fmtVolHuman } from '@/lib/format-detail.mjs';
import type { SearchResult, MarketType } from '@/app/api/search/route';

const DEBOUNCE_MS = 250;
const MIN_Q = 2;

// Enh 5: friendly type chips so the market shape is legible BEFORE the add attempt.
const TYPE_LABEL: Record<MarketType, string> = {
  binary: 'YES/NO', survival: 'LADDER', bucket_pmf: 'PMF', directional_touch: 'RANGE', categorical: 'CATEGORICAL',
};

export function MarketSearch({ orgs }: { orgs: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [selected, setSelected] = useState<SearchResult | null>(null); // the PREVIEWED result (not yet added)
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const primaryBtnRef = useRef<HTMLButtonElement>(null);

  // ⌘/Ctrl-K focuses the search line.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(true);
        inputRef.current?.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Click-outside closes the overlay.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  // Enh 8: the global Esc handler closes the overlay even when the input isn't focused
  // (the input's own onKeyDown still handles Esc while typing).
  useEffect(() => {
    function onEsc() { setOpen(false); }
    window.addEventListener(KBD.escape, onEsc);
    return () => window.removeEventListener(KBD.escape, onEsc);
  }, []);

  // When a result is previewed, move focus to the primary add button so a keyboard user can
  // commit with one more Enter (browse → select → add, all from the keyboard).
  useEffect(() => {
    if (selected) primaryBtnRef.current?.focus();
  }, [selected]);

  // Debounced search via the proxy; abort the in-flight request on each keystroke.
  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_Q) { setResults([]); setLoading(false); return; }
    setLoading(true);
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal });
        const data = (await res.json()) as { results?: SearchResult[] };
        setResults(Array.isArray(data.results) ? data.results : []);
        setHighlight(0);
      } catch {
        if (!ctrl.signal.aborted) setResults([]);
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [query]);

  /** Preview a result: highlight + open the action bar. Does NOT add (Issue 1). */
  function preview(r: SearchResult) {
    if (pending) return;
    setError(null);
    setSelected(r);
  }

  /** Explicit commit for a scope (Issue 4): null = personal, else the org id. */
  function commit(orgId: string | null) {
    if (pending || !selected) return;
    const slug = selected.slug;
    setError(null);
    startTransition(async () => {
      const res = await addMarket(slug, orgId);
      if (res.ok && res.slug) {
        setOpen(false); setQuery(''); setResults([]); setSelected(null);
        router.push(`/?m=${encodeURIComponent(res.slug)}`); // rail already revalidated; open the detail
      } else {
        setError(res.error ?? 'could not add market');
      }
    });
  }

  function onQueryChange(v: string) {
    setQuery(v);
    setOpen(true);
    setSelected(null); // a new query invalidates any previewed result
    setError(null);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(h + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); const r = results[highlight]; if (r) preview(r); } // select, not add
    else if (e.key === 'Escape') {
      if (selected) { setSelected(null); inputRef.current?.focus(); } // step back to browsing
      else { setOpen(false); inputRef.current?.blur(); }
    }
  }

  const showOverlay = open && (loading || results.length > 0 || error != null || (query.trim().length >= MIN_Q));
  const orgless = orgs.length === 0;

  return (
    <div className="cmdbar-search-wrap" ref={containerRef}>
      <div className="cmdbar-search" onClick={() => { setOpen(true); inputRef.current?.focus(); }}>
        <span className="faint mono">/</span>
        <input
          ref={inputRef}
          className="cmdbar-input mono"
          placeholder="search markets…  (⌘K)"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          data-field="search-input"
          aria-label="Search markets"
        />
      </div>

      {showOverlay && (
        <div className="search-overlay" role="listbox" data-field="search-overlay">
          {loading && <div className="search-state faint">searching…</div>}
          {!loading && results.length === 0 && query.trim().length >= MIN_Q && !error && (
            <div className="search-state faint">no markets found</div>
          )}
          {results.map((r, i) => (
            <button
              key={r.slug}
              type="button"
              role="option"
              aria-selected={selected?.slug === r.slug}
              className={`search-row${i === highlight ? ' is-highlighted' : ''}${selected?.slug === r.slug ? ' is-selected' : ''}`}
              data-field="search-row"
              data-slug={r.slug}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => preview(r)}
              disabled={pending}
            >
              <span className={`wl-dot ${r.closed ? 'state-resolved' : 'state-open'}`} aria-hidden="true" />
              <span className="search-title">{r.title}</span>
              {r.type && (
                <span className={`search-type${r.type === 'categorical' ? ' is-categorical' : ''}`} data-field="search-type">
                  {TYPE_LABEL[r.type]}
                </span>
              )}
              {r.category && <span className="search-cat faint">{r.category}</span>}
              {r.volume != null && <span className="search-vol faint num">{fmtVolHuman(r.volume)}</span>}
            </button>
          ))}

          {/* Issue 1 + 4: explicit add action bar — appears only once a result is PREVIEWED. Each
              button independently commits compute-then-add for its scope (no dropdown, no auto-add). */}
          {selected && (
            <div className="search-actionbar" data-field="search-actionbar">
              <span className="search-action-label faint">
                Add <span className="search-action-market">{selected.title}</span> to
              </span>
              <div className="search-action-btns">
                <button
                  ref={primaryBtnRef}
                  type="button"
                  className="search-add-btn is-primary"
                  data-field="add-personal"
                  onClick={() => commit(null)}
                  disabled={pending}
                >{orgless ? 'Add to Watchlist' : 'Personal'}</button>
                {orgs.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    className="search-add-btn"
                    data-field="add-org"
                    data-org-id={o.id}
                    onClick={() => commit(o.id)}
                    disabled={pending}
                  >{o.name}</button>
                ))}
              </div>
              {pending && <span className="search-state faint" data-field="search-adding">adding…</span>}
            </div>
          )}

          {error && <div className="search-error" data-field="search-error">{error}</div>}
        </div>
      )}
    </div>
  );
}
