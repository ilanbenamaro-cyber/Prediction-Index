'use client';
// app/(auth)/login/page.tsx — login-only shell (2c.1). Email+password against the
// invite-only Supabase Auth built in 2b. No public signup here — access is
// allowlist-gated; a signup / invite-acceptance form is the fast-follow.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }
    router.push('/');
    router.refresh();
  }

  return (
    <main className="login-wrap">
      <form className="login-card" onSubmit={onSubmit}>
        <div className="login-brand">
          <span className="num">PREDICTION INDEX</span>
        </div>
        <div className="login-sub label">Verified prediction-market signal · invite-only</div>

        <label className="login-field">
          <span className="label">Email</span>
          <input type="email" autoComplete="email" required value={email}
            onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="login-field">
          <span className="label">Password</span>
          <input type="password" autoComplete="current-password" required value={password}
            onChange={(e) => setPassword(e.target.value)} />
        </label>

        {error && <div className="login-err">{error}</div>}

        <button className="login-btn" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <div className="login-foot faint">Have an invite? <Link href="/signup">Accept it here</Link></div>
      </form>

      <style>{`
        .login-wrap { display:flex; align-items:center; justify-content:center; height:100vh; padding:24px; }
        .login-card { width:340px; background:var(--bg-card); border:1px solid var(--border);
          border-radius:var(--radius); padding:28px 26px; display:flex; flex-direction:column; gap:14px; }
        .login-brand { font-size:var(--fs-lg); font-weight:700; letter-spacing:0.5px; }
        .login-brand .num { color:var(--accent-amber); font-family:var(--font-mono); }
        .login-sub { margin-top:-8px; margin-bottom:6px; }
        .login-field { display:flex; flex-direction:column; gap:5px; }
        .login-field input { background:var(--bg); border:1px solid var(--border); color:var(--text);
          border-radius:var(--radius-sm); padding:9px 11px; font-size:var(--fs-body); font-family:var(--font-mono); }
        .login-field input:focus { outline:none; border-color:var(--border-strong); }
        .login-err { color:var(--c-low); font-size:var(--fs-tiny); }
        .login-btn { margin-top:6px; background:var(--accent-amber); color:#1a1a18; border:none;
          border-radius:var(--radius-sm); padding:10px; font-size:var(--fs-body); font-weight:700;
          cursor:pointer; transition:opacity var(--t-fast) var(--ease); }
        .login-btn:disabled { opacity:0.6; cursor:default; }
        .login-foot { font-size:var(--fs-micro); text-align:center; margin-top:2px; }
      `}</style>
    </main>
  );
}
