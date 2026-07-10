'use client';
// components/zones/PendingMembers.tsx — org-admin approval panel (self-service invites, §7.2).
//
// SECURITY MODEL: every mutation here (approve/reject/rotate) is enforced by Postgres RLS
// (migrations 0012–0014: orgmem_update_admin, orgmem_delete_admin, ojc_select_admin,
// profiles_select_admin_pending, rpc rotate_org_join_code). The admin check performed in this
// component is a COURTESY that hides the panel for non-admins — it is NEVER the guard. A
// non-admin who somehow renders this panel (stale client state, forged prop) still cannot
// mutate anything: RLS returns zero rows / 42501 regardless of what the UI thinks.
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

interface PendingRow {
  user_id: string;
  created_at: string;
  display_name: string | null;
  email: string | null;
  busy: boolean;
}

type PanelState =
  | { kind: 'loading' }
  | { kind: 'not-admin' }
  | { kind: 'error'; message: string }
  | { kind: 'ready' };

function fmtDate(iso: string): string {
  return iso.slice(0, 10); // YYYY-MM-DD — the timestamp is already ISO 8601 from Postgres
}

function dashed(code: string): string {
  return code.replace(/(.{4})(?=.)/g, '$1-');
}

export function PendingMembers({ orgId }: { orgId: string }) {
  const [panel, setPanel] = useState<PanelState>({ kind: 'loading' });
  const [pending, setPending] = useState<PendingRow[]>([]);
  const [joinCode, setJoinCode] = useState<{ code: string; expiresAt: string | null } | null>(null);
  const [hasJoinCode, setHasJoinCode] = useState(false);
  const [rotateArmed, setRotateArmed] = useState(false);
  const [rotateBusy, setRotateBusy] = useState(false);
  const [rotateHint, setRotateHint] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);

  // ONE effect per orgId — resolves the user, courtesy-checks admin, then loads pending
  // members + the join code in parallel. `cancelled` guards every state update against the
  // orgId-switch race (rapid toggling the org selector must not let a stale load clobber
  // a newer one).
  useEffect(() => {
    let cancelled = false;
    setPanel({ kind: 'loading' });
    setPending([]);
    setJoinCode(null);
    setHasJoinCode(false);
    setRotateArmed(false);
    setRotateHint(null);
    setMutationError(null);

    const supabase = createClient();

    (async () => {
      try {
        // Fail closed: any error resolving the user → render nothing.
        const { data: userData, error: userError } = await supabase.auth.getUser();
        if (cancelled) return;
        if (userError || !userData.user) {
          setPanel({ kind: 'not-admin' });
          return;
        }
        const uid = userData.user.id;

        // Courtesy check ONLY — hides the panel for non-admins. RLS is the real guard on
        // every mutation and every admin-only read below.
        const { data: own, error: ownError } = await supabase
          .from('org_membership')
          .select('role, status')
          .eq('org_id', orgId)
          .eq('user_id', uid)
          .maybeSingle();
        if (cancelled) return;
        if (ownError) {
          setPanel({ kind: 'error', message: ownError.message });
          return;
        }
        if (!own || own.role !== 'admin' || own.status !== 'active') {
          setPanel({ kind: 'not-admin' });
          return;
        }

        const [pendingRes, joinRes] = await Promise.all([
          supabase
            .from('org_membership')
            .select('user_id, created_at')
            .eq('org_id', orgId)
            .eq('status', 'pending'),
          supabase
            .from('org_join_codes')
            .select('code, expires_at')
            .eq('org_id', orgId)
            .maybeSingle(),
        ]);
        if (cancelled) return;
        if (pendingRes.error) {
          setPanel({ kind: 'error', message: pendingRes.error.message });
          return;
        }
        if (joinRes.error) {
          setPanel({ kind: 'error', message: joinRes.error.message });
          return;
        }

        const rows = pendingRes.data ?? [];
        const ids = rows.map((r) => r.user_id);
        let profileById = new Map<string, { display_name: string | null; email: string | null }>();
        if (ids.length > 0) {
          // admin-only read via profiles_select_admin_pending — a missing profile (deleted,
          // race, or the read simply not matching) must never crash the panel; it renders —.
          const { data: profs, error: profError } = await supabase
            .from('profiles')
            .select('id, display_name, email')
            .in('id', ids);
          if (cancelled) return;
          if (profError) {
            setPanel({ kind: 'error', message: profError.message });
            return;
          }
          profileById = new Map((profs ?? []).map((p) => [p.id, { display_name: p.display_name, email: p.email }]));
        }

        setPending(
          rows.map((r) => ({
            user_id: r.user_id,
            created_at: r.created_at,
            display_name: profileById.get(r.user_id)?.display_name ?? null,
            email: profileById.get(r.user_id)?.email ?? null,
            busy: false,
          }))
        );
        if (joinRes.data) {
          setHasJoinCode(true);
          setJoinCode({ code: joinRes.data.code, expiresAt: joinRes.data.expires_at });
        } else {
          setHasJoinCode(false);
          setJoinCode(null);
        }
        setPanel({ kind: 'ready' });
      } catch (e) {
        if (cancelled) return;
        setPanel({ kind: 'error', message: e instanceof Error ? e.message : 'failed to load panel' });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [orgId]);

  async function approve(userId: string) {
    setPending((rows) => rows.map((r) => (r.user_id === userId ? { ...r, busy: true } : r)));
    setMutationError(null);
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from('org_membership')
        .update({ status: 'active' })
        .eq('org_id', orgId)
        .eq('user_id', userId)
        .select();
      // Zero returned rows means RLS's orgmem_update_admin policy filtered the write (not an
      // admin, or targeting self) — treat identically to an explicit error.
      if (error || !data || data.length === 0) {
        setMutationError('approve failed — not permitted?');
        setPending((rows) => rows.map((r) => (r.user_id === userId ? { ...r, busy: false } : r)));
        return;
      }
      setPending((rows) => rows.filter((r) => r.user_id !== userId));
    } catch (e) {
      setMutationError(e instanceof Error ? e.message : 'approve failed — not permitted?');
      setPending((rows) => rows.map((r) => (r.user_id === userId ? { ...r, busy: false } : r)));
    }
  }

  async function reject(userId: string) {
    setPending((rows) => rows.map((r) => (r.user_id === userId ? { ...r, busy: true } : r)));
    setMutationError(null);
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from('org_membership')
        .delete()
        .eq('org_id', orgId)
        .eq('user_id', userId)
        .select();
      // Zero returned rows means RLS's orgmem_delete_admin policy filtered the write.
      if (error || !data || data.length === 0) {
        setMutationError('reject failed — not permitted?');
        setPending((rows) => rows.map((r) => (r.user_id === userId ? { ...r, busy: false } : r)));
        return;
      }
      setPending((rows) => rows.filter((r) => r.user_id !== userId));
    } catch (e) {
      setMutationError(e instanceof Error ? e.message : 'reject failed — not permitted?');
      setPending((rows) => rows.map((r) => (r.user_id === userId ? { ...r, busy: false } : r)));
    }
  }

  // Two-step inline confirm — browser confirm() dialogs are banned in this repo. First click
  // arms (auto-disarms after 4s); second click fires the RPC (self-guards with 42501 server-side
  // for non-admins — this is the courtesy path, not the guard).
  function onRotateClick() {
    if (!rotateArmed) {
      setRotateArmed(true);
      setTimeout(() => setRotateArmed(false), 4000);
      return;
    }
    setRotateArmed(false);
    void doRotate();
  }

  async function doRotate() {
    setRotateBusy(true);
    setMutationError(null);
    const wasExisting = hasJoinCode;
    try {
      const supabase = createClient();
      const { data, error } = await supabase.rpc('rotate_org_join_code', { p_org: orgId });
      if (error || !data) {
        setMutationError(error?.message ?? 'rotate failed — not permitted?');
        return;
      }
      setHasJoinCode(true);
      setJoinCode({ code: data, expiresAt: null });
      setRotateHint(wasExisting ? 'previous code is dead' : null);
    } catch (e) {
      setMutationError(e instanceof Error ? e.message : 'rotate failed — not permitted?');
    } finally {
      setRotateBusy(false);
    }
  }

  if (panel.kind === 'loading' || panel.kind === 'not-admin') return null;

  return (
    <div className="pm-panel" data-field="pending-panel">
      {panel.kind === 'error' && (
        <div className="pm-err" data-field="pending-error">✗ {panel.message}</div>
      )}
      {panel.kind === 'ready' && (
        <>
          <div className="pm-row" data-field="join-code-row">
            <span className="label">JOIN CODE</span>
            {hasJoinCode && joinCode ? (
              <>
                <span data-field="join-code">
                  {dashed(joinCode.code)}
                  {joinCode.expiresAt ? ` · expires ${fmtDate(joinCode.expiresAt)}` : ''}
                </span>
                <button
                  type="button"
                  className="pm-act"
                  onClick={onRotateClick}
                  disabled={rotateBusy}
                  data-field="join-rotate"
                >
                  {rotateBusy ? 'rotating…' : rotateArmed ? 'CONFIRM ROTATE?' : 'ROTATE'}
                </button>
              </>
            ) : (
              <>
                <span data-field="join-code">none</span>
                <button
                  type="button"
                  className="pm-act"
                  onClick={onRotateClick}
                  disabled={rotateBusy}
                  data-field="join-rotate"
                >
                  {rotateBusy ? 'creating…' : rotateArmed ? 'CONFIRM ROTATE?' : 'CREATE'}
                </button>
              </>
            )}
            {rotateHint && <span className="faint">{rotateHint}</span>}
          </div>

          {mutationError && (
            <div className="pm-err" data-field="pending-mutation-error">✗ {mutationError}</div>
          )}

          {pending.length > 0 && (
            <>
              <div className="label" data-field="pending-header">PENDING — {pending.length}</div>
              {pending.map((r) => (
                <div className="pm-row" data-field="pending-row" key={r.user_id}>
                  <span className="pm-name">{r.display_name ?? '—'}</span>
                  <span className="pm-email faint">{r.email ?? '—'}</span>
                  <span className="pm-date">{fmtDate(r.created_at)}</span>
                  <button
                    type="button"
                    className="pm-act"
                    onClick={() => approve(r.user_id)}
                    disabled={r.busy}
                    data-field="pending-approve"
                  >
                    APPROVE
                  </button>
                  <button
                    type="button"
                    className="pm-act pm-act-danger"
                    onClick={() => reject(r.user_id)}
                    disabled={r.busy}
                    data-field="pending-reject"
                  >
                    REJECT
                  </button>
                </div>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}
