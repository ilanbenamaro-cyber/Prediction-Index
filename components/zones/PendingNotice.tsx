'use client';
// components/zones/PendingNotice.tsx — the pending MEMBER's banner (self-service invites, §7.3).
//
// Deliberately generic: a pending member cannot read the org's name (organizations has no
// RLS grant for them — RLS, not a UI choice), so this banner never says which org. We do not
// widen visibility just to make a friendlier message.
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

export function PendingNotice() {
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();

    (async () => {
      try {
        // Fail closed: any error resolving the user → render nothing.
        const { data: userData, error: userError } = await supabase.auth.getUser();
        if (cancelled) return;
        if (userError || !userData.user) {
          setPending(false);
          return;
        }
        // orgmem_select_self scopes this to exactly the caller's own rows.
        const { data, error } = await supabase
          .from('org_membership')
          .select('org_id')
          .eq('user_id', userData.user.id)
          .eq('status', 'pending');
        if (cancelled) return;
        setPending(!error && !!data && data.length > 0);
      } catch {
        if (!cancelled) setPending(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (!pending) return null;
  return <div className="wl-pending-note" data-field="pending-notice">ORG ACCESS PENDING APPROVAL</div>;
}
