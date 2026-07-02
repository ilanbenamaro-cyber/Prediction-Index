'use client';
// components/zones/AddToWatchlist.tsx — the detail-header "Add to Watchlist" control (Item 2).
//
// Adding is an EXPLICIT action on the detail page (search only navigates now). This control adapts
// to the user's org membership:
//   • 0 orgs → a single "Add to Watchlist" button (personal).
//   • 1 org  → two buttons: "Add to Personal" / "Add to {OrgName}".
//   • 2+ orgs → a target picker (Personal + each org) with a single "Add" confirm.
// A target the market is ALREADY on renders as a "✓ On …'s watchlist" chip instead of an add
// control. Uses the same addMarket server action as before — only the UI trigger is new. addMarket
// re-runs the verified serve (compute-then-add ordering) and revalidates the rail on success.

import { useState, useTransition } from 'react';
import { addMarket } from '@/app/(app)/actions';

export interface Membership { personal: boolean; orgIds: string[] }

export function AddToWatchlist({ slug, orgs, initial }:
  { slug: string; orgs: Array<{ id: string; name: string }>; initial: Membership }) {
  const [personal, setPersonal] = useState(initial.personal);
  const [orgIds, setOrgIds] = useState<string[]>(initial.orgIds);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Every add target: personal + each org, tagged with current membership.
  const targets = [
    { key: 'personal', label: 'Personal', chip: 'your', member: personal },
    ...orgs.map((o) => ({ key: o.id, label: o.name, chip: `${o.name}'s`, member: orgIds.includes(o.id) })),
  ];
  const members = targets.filter((t) => t.member);
  const open = targets.filter((t) => !t.member);

  // 2+ orgs: which target the picker has selected (default to the first still-addable one).
  const [picked, setPicked] = useState<string>('');
  const effective = open.find((t) => t.key === picked) ? picked : (open[0]?.key ?? '');

  function commit(key: string) {
    if (pending || !key) return;
    const orgId = key === 'personal' ? null : key;
    setError(null);
    startTransition(async () => {
      const res = await addMarket(slug, orgId);
      if (res.ok) {
        if (orgId == null) setPersonal(true);
        else setOrgIds((ids) => (ids.includes(orgId) ? ids : [...ids, orgId]));
      } else {
        setError(res.error ?? 'could not add to watchlist');
      }
    });
  }

  const usePicker = orgs.length >= 2 && open.length > 0;

  return (
    <div className="detail-add" data-field="add-to-watchlist">
      {/* already-on chips */}
      {members.map((t) => (
        <span key={t.key} className="detail-added" data-field="added-chip" data-target={t.key}>
          ✓ On {t.chip} watchlist
        </span>
      ))}

      {/* 2+ orgs: pick a target, then Add */}
      {usePicker && (
        <span className="detail-add-picker">
          <select
            className="detail-add-select mono"
            value={effective}
            onChange={(e) => setPicked(e.target.value)}
            disabled={pending}
            aria-label="Add to which watchlist"
            data-field="add-target"
          >
            {open.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
          <button type="button" className="detail-add-btn is-primary" onClick={() => commit(effective)} disabled={pending} data-field="add-confirm">
            {pending ? 'adding…' : 'Add'}
          </button>
        </span>
      )}

      {/* 0–1 orgs: one button per still-addable target */}
      {!usePicker && open.map((t) => (
        <button
          key={t.key}
          type="button"
          className={`detail-add-btn${t.key === 'personal' ? ' is-primary' : ''}`}
          onClick={() => commit(t.key)}
          disabled={pending}
          data-field="add-btn"
          data-target={t.key}
        >
          {pending ? 'adding…' : orgs.length === 0 ? 'Add to Watchlist' : `Add to ${t.label}`}
        </button>
      ))}

      {error && <span className="detail-add-error" role="alert" data-field="add-error">{error} <button type="button" className="detail-add-retry" onClick={() => commit(usePicker ? effective : (open[0]?.key ?? ''))}>retry</button></span>}
    </div>
  );
}
