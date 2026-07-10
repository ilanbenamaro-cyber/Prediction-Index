-- 0014 DOWN — restores the 0002 bodies of is_org_member/shares_org VERBATIM
-- (status-blind) and removes the approval policies + grants.
-- ⚠ If 0013 is still applied, pending rows would see org data after this down —
--   apply 0013_down as well (the two travel together, both directions).

drop policy profiles_select_admin_pending on public.profiles;
drop policy orgmem_delete_self  on public.org_membership;
drop policy orgmem_delete_admin on public.org_membership;
drop policy orgmem_update_admin on public.org_membership;
drop policy orgmem_select_self  on public.org_membership;

revoke delete          on public.org_membership from authenticated;
revoke update (status) on public.org_membership from authenticated;

-- 0002 bodies, verbatim:
create or replace function public.is_org_member(p_org uuid)
  returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.org_membership
    where org_id = p_org and user_id = (select auth.uid())
  );
$$;

create or replace function public.shares_org(p_other uuid)
  returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.org_membership a
    join public.org_membership b using (org_id)
    where a.user_id = (select auth.uid()) and b.user_id = p_other
  );
$$;
