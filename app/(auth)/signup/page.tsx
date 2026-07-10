'use client';
// app/(auth)/signup/page.tsx — invite-acceptance / signup (Enh 6, extended by the
// self-service-invites design, migrations 0012-0014).
//
// Access is a THREE-PATH gate, evaluated server-side by the Before User Created auth
// hook + handle_new_user trigger — this form never decides access, it only submits:
//   1. allowlist match (operator override, unchanged)         → active org membership
//   2. single-use invite code (optional "code" field)         → solo account, no org
//   3. org join code (same field, different table)            → pending org membership
//   4. none of the above                                      → generic invite-only 403
// Three UI outcomes, all surfaced explicitly:
//   • rejected (any of the three code states, or the generic gate) → mapSignupError message;
//   • confirm-email ON (prod) → no session returned → "check your email to confirm";
//   • confirm-email OFF (dev) → a session is returned → straight into the app.
// Mirrors the login page (anon browser client, never the service-role key).
import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { mapSignupError } from '@/lib/signup-errors.mjs';

function SignupForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState(() => searchParams.get('code') ?? '');
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false); // confirm-email posture (prod) → check inbox
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // URL hygiene (Opus F3): an org join code is a reusable secret. Once it has
    // pre-filled the field, strip it from the address bar so it doesn't linger in
    // browser history or get copy-pasted around with the URL.
    if (searchParams.get('code')) {
      window.history.replaceState(null, '', '/signup');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const trimmedCode = code.trim();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          display_name: name.trim(),
          // never store an empty invite_code key — an absent key means "no code
          // supplied" to the hook/trigger, distinct from an empty-string code.
          ...(trimmedCode ? { invite_code: trimmedCode } : {}),
        },
      },
    });
    if (error) {
      setError(mapSignupError(error.message));
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
              <span className="label">Name</span>
              <input type="text" required maxLength={80} autoComplete="name" data-field="signup-name"
                value={name} onChange={(e) => setName(e.target.value)} />
            </label>
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
            <label className="login-field">
              <span className="label">Invite or organization code · optional</span>
              <input type="text" autoComplete="off" spellCheck={false} placeholder="XXXX-XXXX-XXXX-XXXX"
                data-field="signup-code" value={code}
                onChange={(e) => setCode(e.target.value)} />
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
        .login-field input[data-field="signup-code"] { text-transform:uppercase; letter-spacing:0.5px; }
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

export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupForm />
    </Suspense>
  );
}
