'use client';
// components/LogoutButton.tsx — clears the Supabase session and re-protects the app
// (proven by the logout half of scripts/verify-2c1-authgate.mjs / the browser flow).
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export function LogoutButton() {
  const router = useRouter();
  async function onLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  }
  return (
    <button className="logout-btn" type="button" onClick={onLogout}>
      sign out
      <style>{`
        .logout-btn { background:transparent; border:none; color:var(--text-muted);
          padding:4px 0; font-family:var(--font-mono); font-size:var(--fs-micro);
          text-transform:uppercase; letter-spacing:var(--track-label); cursor:pointer;
          transition:color var(--t-fast) var(--ease); }
        .logout-btn:hover { color:var(--text); }
      `}</style>
    </button>
  );
}
