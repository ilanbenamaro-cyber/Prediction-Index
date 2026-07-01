// app/(app)/layout.tsx — the authenticated terminal shell: command bar (Zone 3
// search lives here) + watchlist rail (Zone 1) + market detail (Zone 2). The auth
// gate is enforced in middleware.ts (unauth → /login before this renders); we also
// re-read the user server-side to render the chrome (email, logout).
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { CommandBar } from '@/components/zones/CommandBar';
import { WatchlistRail } from '@/components/zones/WatchlistRail';
import { KeyboardShortcuts } from '@/components/zones/KeyboardShortcuts';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login'); // defense-in-depth; middleware already guards

  // The user's orgs (RLS-scoped) drive the rail's Personal/Org toggle (Item 3).
  const { data: orgRows } = await supabase.from('organizations').select('id, name');
  const orgs = (orgRows ?? []).map((o) => ({ id: o.id as string, name: (o.name as string) ?? 'Org' }));

  return (
    <div className="terminal">
      <KeyboardShortcuts />
      <CommandBar userEmail={user.email ?? ''} />
      <WatchlistRail orgs={orgs} />
      <main className="detail" data-zone="detail">{children}</main>
    </div>
  );
}
