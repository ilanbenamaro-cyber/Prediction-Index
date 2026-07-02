// components/zones/WatchlistRail.tsx — Zone 1 (watchlist rail), 2c.2.
//
// A Server Component: it fetches the caller's visible watchlist (lib/watchlist
// .listVisible — RLS-scoped) then reads the scan data for EXACTLY those markets
// (lib/market-scan.readScan — service-role, but bounded to the visible ids: the
// firewall). The cache is the ONLY source — no /api/market fan-out, no resolution
// probe; the authoritative probed serve stays in Zone 2 for the selected market.
//
// The data fetch lives in an async child under <Suspense> so the shell streams a
// skeleton first (the real "loading" state). Empty + error are explicit, never a crash.
import { Suspense } from 'react';
import { createClient } from '@/lib/supabase/server';
import { listVisible } from '@/lib/watchlist.mjs';
import { readScan } from '@/lib/market-scan.mjs';
import { WatchlistRows, type ScanRow } from './WatchlistRows';

export function WatchlistRail({ orgs = [] }: { orgs?: Array<{ id: string; name: string }> }) {
  return (
    <aside className="rail" data-zone="rail">
      <div className="zone-head">Watchlist</div>
      <Suspense fallback={<RailSkeleton />}>
        <RailData orgs={orgs} />
      </Suspense>
    </aside>
  );
}

async function RailData({ orgs }: { orgs: Array<{ id: string; name: string }> }) {
  let rows: ScanRow[];
  try {
    const supabase = await createClient();
    const visible = await listVisible(supabase); // RLS-scoped union view
    rows = (await readScan(visible)) as ScanRow[]; // bounded to visible ids (firewall)
  } catch (err) {
    // Surface, never swallow: log server-side, render an explicit error state.
    console.error('[watchlist-rail] scan read failed:', err);
    return (
      <div className="empty wl-error" data-zone="rail-error">
        Couldn’t load your watchlist.<br />Retry shortly.
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="empty" data-zone="rail-empty">
        No markets yet.<br />Search a market, open it, and add it from its header.
      </div>
    );
  }
  return <WatchlistRows rows={rows} orgs={orgs} />;
}

function RailSkeleton() {
  return (
    <ul className="wl-list" data-zone="rail-skeleton" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <li key={i} className="wl-row wl-skel">
          <div className="wl-skel-bar wl-skel-title" />
          <div className="wl-skel-bar wl-skel-data" />
        </li>
      ))}
    </ul>
  );
}
