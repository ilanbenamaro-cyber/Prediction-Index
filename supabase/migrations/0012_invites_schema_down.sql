-- 0012 DOWN — reverses 0012_invites_schema.sql exactly (schema part only).
-- ⚠ Apply 0014_down and 0013_down FIRST if they were applied: the 0014 policies
--   and 0013 functions reference the objects dropped here.
-- pgcrypto is deliberately NOT dropped (shared, enabled by default on Supabase).

drop policy ojc_select_admin on public.org_join_codes;

drop table public.org_join_codes;
drop table public.invite_codes;

drop function public.admin_of_pending_profile(uuid);
drop function public.is_org_admin(uuid);
drop function public.normalize_invite_code(text);
drop function public.new_invite_token();

alter table public.org_membership drop column status;
drop type public.membership_status;
