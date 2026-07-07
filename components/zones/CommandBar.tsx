// components/zones/CommandBar.tsx — top command bar. Houses Zone 3 (search) as a
// terminal-style command input (keeps the detail zone maximally wide), plus brand +
// the signed-in user / logout. The MarketSearch island (⌘K) NAVIGATES to a result's
// detail page (compute-then-serve); adding to a watchlist is a separate explicit action
// on the detail page (AddToWatchlist), so no org/scope picker is needed here.
import { LogoutButton } from '@/components/LogoutButton';
import { MarketSearch } from '@/components/zones/MarketSearch';

export function CommandBar({ userEmail }: { userEmail: string }) {
  return (
    <header className="cmdbar cmdbar-row">
      <div className="cmdbar-brand">
        <span className="num">PREDICTION INDEX</span>
      </div>

      <MarketSearch />

      <div className="cmdbar-user">
        <span className="mono faint" title={userEmail}>{userEmail}</span>
        <LogoutButton />
      </div>

      <style>{`
        .cmdbar-row { display:flex; align-items:center; gap:var(--sp-4); padding:0 var(--sp-4); }
        .cmdbar-brand { display:flex; align-items:center; font-size:var(--fs-tiny); font-weight:600;
          letter-spacing:1.2px; white-space:nowrap; }
        /* the brand mark echoes the split signal bar: two 3x12 bars, amber + blue */
        .cmdbar-brand::before { content:''; display:inline-block; width:8px; height:12px;
          margin-right:var(--sp-2); flex:0 0 auto;
          background:linear-gradient(to right,
            var(--accent-amber) 0 3px, transparent 3px 5px, var(--accent-blue) 5px 8px); }
        .cmdbar-brand .num { color:var(--accent-amber); font-family:var(--font-mono); }
        .cmdbar-user { display:flex; align-items:center; gap:var(--sp-3); margin-left:auto;
          font-size:var(--fs-micro); max-width:40vw; overflow:hidden; }
        .cmdbar-user span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      `}</style>
    </header>
  );
}
