'use client';
// app/(auth)/signup/page.tsx — invite-acceptance / signup (Enh 6).
//
// Access is INVITE-ONLY: the Supabase "Before User Created" auth hook (migration 0003)
// rejects any email not on the operator allowlist BEFORE an auth.users row is created. So
// this form just calls auth.signUp — the server-side hook is the gate, not client logic.
// Three outcomes, all surfaced explicitly:
//   • not allowlisted  → the hook rejects → friendly "invite-only" message;
//   • confirm-email ON (prod) → no session returned → "check your email to confirm";
//   • confirm-email OFF (dev) → a session is returned → straight into the app.
// Mirrors the login page (anon browser client, never the service-role key).
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';

/** Map the hook's rejection to a human message; pass other errors through. */
function mapError(message: string): string {
  if (/invite|allow|not permitted|403|denied/i.test(message)) {
    return 'This email isn’t on the invite list. Access is invite-only — contact your administrator.';
  }
  return message;
}

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false); // confirm-email posture (prod) → check inbox
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) {
      setError(mapError(error.message));
      setBusy(false);
      return;
    }
    if (data.session) {
      // confirm-email OFF (dev) — the hook accepted + provisioned; we're signed in.
      router.push('/');
      router.refresh();
      return;
    }
    // confirm-email ON (prod) — account created, awaiting email confirmation.
    setConfirm(true);
    setBusy(false);
  }

  return (
    <main className="login-wrap">
      <form className="login-card" onSubmit={onSubmit}>
        <div className="login-brand">
          <span className="num">PREDICTION INDEX</span>
        </div>
        <div className="login-sub label">Accept your invite · invite-only access</div>

        {confirm ? (
          <div className="login-ok" data-field="signup-confirm">
            Account created. Check <b>{email}</b> for a confirmation link to finish signing in.
          </div>
        ) : (
          <>
            <label className="login-field">
              <span className="label">Email</span>
              <input type="email" autoComplete="email" required value={email}
                onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="login-field">
              <span className="label">Password</span>
              <input type="password" autoComplete="new-password" required minLength={8} value={password}
                onChange={(e) => setPassword(e.target.value)} />
            </label>

            {error && <div className="login-err" data-field="signup-error">{error}</div>}

            <button className="login-btn" type="submit" disabled={busy}>
              {busy ? 'Creating account…' : 'Accept invite'}
            </button>
          </>
        )}

        <div className="login-foot faint">
          Already have an account? <Link href="/login">Sign in</Link>
        </div>
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
        .login-ok { color:var(--text); font-size:var(--fs-tiny); line-height:var(--lh-prose);
          background:var(--bg); border:1px solid var(--border); border-radius:var(--radius-sm); padding:11px; }
        .login-btn { margin-top:6px; background:var(--accent-amber); color:#1a1a18; border:none;
          border-radius:var(--radius-sm); padding:10px; font-size:var(--fs-body); font-weight:700;
          cursor:pointer; transition:opacity var(--t-fast) var(--ease); }
        .login-btn:disabled { opacity:0.6; cursor:default; }
        .login-foot { font-size:var(--fs-micro); text-align:center; margin-top:2px; }
      `}</style>
    </main>
  );
}
