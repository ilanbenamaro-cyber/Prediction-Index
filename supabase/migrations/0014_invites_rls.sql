-- 0014 — self-service invites, part 3 of 3: the RLS SWEEP. Makes every org-data
-- path require status='active' and adds the approval state machine's policies.
-- Requires 0012 (status column, helpers) and 0013 (which starts writing
-- 'pending' rows). ⚠ Apply together with 0013 — see 0013's header warning.
--
-- Design: docs/design/self-service-invites-design.md §4–5 (operator-approved v2).
--
-- THE CHOKE POINT: is_org_member and shares_org are the only two places the
-- existing policies read org_membership. Adding status='active' INSIDE these two
-- SECURITY DEFINER helpers fixes, in one stroke: org_select_member,
-- orgmem_select_member, ow_select_member, ow_insert_member, ow_delete_member,
-- profiles_select_self_or_coorg — and everything downstream of them
-- (my_visible_watchlist is security_invoker; readScan derives ids only from it).
--
-- A PENDING member's exact reach after this file: own membership row
-- (orgmem_select_self — powers the "pending approval" banner), full personal
-- watchlist, and NOTHING org — not even the org's name.
--
-- STATE MACHINE (all other transitions impossible):
--   pending → active   admin UPDATE (approve; WITH CHECK pins status='active' — F5)
--   pending → ∅        admin DELETE (reject) or self DELETE (cancel)
--   active  → ∅        admin DELETE (remove) or self DELETE (leave)
-- Accepted edges (documented, not blocked): an admin may remove another admin;
-- the last admin may leave, orphaning admin functions (operator repair = one
-- service-role UPDATE). Blocked HERE, not in the UI: self-approval, active→pending
-- demotion, role changes (no column grant), any client INSERT (no policy).

-- ── 1. the two choke-point helpers become status-aware ──
create or replace function public.is_org_member(p_org uuid)
  returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.org_membership
    where org_id = p_org and user_id = (select auth.uid()) and status = 'active'
  );
$$;

create or replace function public.shares_org(p_other uuid)
  returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.org_membership a
    join public.org_membership b using (org_id)
    where a.user_id = (select auth.uid()) and b.user_id = p_other
      and a.status = 'active' and b.status = 'active'
  );
$$;

-- ── 2. own-row visibility: a pending user must be able to SEE that they are
--       pending (orgmem_select_member no longer covers them) ──
create policy orgmem_select_self on public.org_membership
  for select to authenticated using ( user_id = (select auth.uid()) );

-- ── 3. approve: STATUS IS THE ONLY UPDATABLE COLUMN — the column-level grant is
--       the escalation guard (role/org_id/user_id updates → permission denied
--       regardless of any policy). WITH CHECK pins the NEW row to 'active' (F5):
--       the UPDATE is APPROVE-ONLY; active→pending demotion is unreachable.
--       user_id <> auth.uid() kills self-approval outright. ──
grant update (status) on public.org_membership to authenticated;
create policy orgmem_update_admin on public.org_membership
  for update to authenticated
  using      ( (select public.is_org_admin(org_id)) and user_id <> (select auth.uid()) )
  with check ( (select public.is_org_admin(org_id)) and user_id <> (select auth.uid())
               and status = 'active' );

-- ── 4. reject/remove (admin) + cancel/leave (self) ──
grant delete on public.org_membership to authenticated;
create policy orgmem_delete_admin on public.org_membership
  for delete to authenticated
  using ( (select public.is_org_admin(org_id)) and user_id <> (select auth.uid()) );
create policy orgmem_delete_self on public.org_membership
  for delete to authenticated using ( user_id = (select auth.uid()) );

-- ── 5. approval panel data: active ADMINS (only) read PENDING members' profiles.
--       Policies OR together — this extends profiles_select_self_or_coorg, which
--       (via the tightened shares_org) no longer exposes pending members to
--       ordinary active members. ──
create policy profiles_select_admin_pending on public.profiles
  for select to authenticated using ( (select public.admin_of_pending_profile(id)) );
