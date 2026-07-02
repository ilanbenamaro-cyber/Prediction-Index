'use client';
// app/(app)/error.tsx — the dashboard segment's error boundary (defense-in-depth).
//
// Every data path already degrades explicitly (DetailData returns DetailError on a non-200;
// the rail catches + renders its own error state) — this boundary is the LAST line so an
// unanticipated render/runtime throw shows a terminal-styled recovery card instead of
// Next's default error page (which, in dev, is a raw stack a user should never see).
// The error is logged for the server/console trail; the digest ties it to server logs.

import { useEffect } from 'react';

export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('[dashboard-error-boundary]', error);
  }, [error]);

  return (
    <div className="empty wl-error" data-zone="dashboard-error" role="alert">
      Something went wrong rendering this view.
      {error.digest && <div className="faint mono" style={{ marginTop: 6 }}>ref {error.digest}</div>}
      <div style={{ marginTop: 10 }}>
        <button type="button" className="cat-more" onClick={reset} data-field="error-retry">↻ try again</button>
      </div>
    </div>
  );
}
