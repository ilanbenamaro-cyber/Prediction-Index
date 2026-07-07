'use client';
// components/zones/MarketSearch.tsx — Zone 3 search, the command-bar island.
// Keyboard-first: ⌘/Ctrl-K focuses, ↑/↓ move, Enter opens the result, Esc dismisses,
// click-outside closes. Debounced fetch to the /api/search proxy (no direct gamma call).
//
// Selecting a result NAVIGATES to ?m=<slug> (compute-then-serve on the detail page) — it does
// NOT add the market to any watchlist. Landing on the detail page only computes + serves the
// verified record (DetailData → serveMarket, which populates the catalog); adding is a separate,
// explicit action on the detail page (see AddToWatchlist). Browsing never mutates the watchlist.

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { KBD } from './kbd';
import { fmtVolHuman } from '@/lib/format-detail.mjs';
import type { SearchResult, MarketType } from '@/app/api/search/route';

const DEBOUNCE_MS = 250;
const MIN_Q = 2;

// Enh 5: friendly type chips so the market shape is legible BEFORE opening it.
const TYPE_LABEL: Record<MarketType, string> = {
  binary: 'YES/NO', survival: 'LADDER', bucket_pmf: 'PMF', directional_touch: 'RANGE', categorical: 'CATEGORICAL',
};

export function MarketSearch() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

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

  // FIX 5: close the overlay AND clear the query — every close path (click-outside, both Escape
  // handlers, selecting a result) must leave the search line empty. Previously only open_() (result
  // selection) cleared it, so Escape (or any other close) left the typed text sitting in the input;
  // the next ⌘K session then appended to that stale text ("bitcoin" + "kraken" → "bitcoinkraken").
  function closeSearch() {
    setOpen(false); setQuery(''); setResults([]);
  }

  // Click-outside closes the overlay.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) closeSearch();
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  // Enh 8: the global Esc handler closes the overlay even when the input isn't focused
  // (the input's own onKeyDown still handles Esc while typing).
  useEffect(() => {
    function onEsc() { closeSearch(); }
    window.addEventListener(KBD.escape, onEsc);
    return () => window.removeEventListener(KBD.escape, onEsc);
  }, []);

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

  /** Open a result: navigate to its detail (compute-then-serve). Does NOT add to any watchlist. */
  function open_(r: SearchResult) {
    closeSearch();
    router.push(`/?m=${encodeURIComponent(r.slug)}`);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(h + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); const r = results[highlight]; if (r) open_(r); }
    else if (e.key === 'Escape') { closeSearch(); inputRef.current?.blur(); }
  }

  const showOverlay = open && (loading || results.length > 0 || (query.trim().length >= MIN_Q));

  return (
    <div className="cmdbar-search-wrap" ref={containerRef}>
      <div className="cmdbar-search" onClick={() => { setOpen(true); inputRef.current?.focus(); }}>
        <span className="faint mono">/</span>
        <input
          ref={inputRef}
          className="cmdbar-input mono"
          placeholder="search markets…  (⌘K)"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          data-field="search-input"
          aria-label="Search markets"
        />
      </div>

      {showOverlay && (
        <div className="search-overlay" role="listbox" data-field="search-overlay">
          {loading && <div className="search-state faint">searching…</div>}
          {!loading && results.length === 0 && query.trim().length >= MIN_Q && (
            <div className="search-state faint">no markets found</div>
          )}
          {results.map((r, i) => (
            <button
              key={r.slug}
              type="button"
              role="option"
              aria-selected={i === highlight}
              className={`search-row${i === highlight ? ' is-highlighted' : ''}`}
              data-field="search-row"
              data-slug={r.slug}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => open_(r)}
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
        </div>
      )}
    </div>
  );
}
