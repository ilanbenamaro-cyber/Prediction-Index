-- 0012 — self-service invites, part 1 of 3: SCHEMA ONLY. Additive; changes NO
-- behavior for existing users (the hook/trigger still run their 0003 bodies until
-- 0013, and every existing RLS policy/helper is untouched until 0014).
--
-- Design: docs/design/self-service-invites-design.md (v2, operator-approved,
-- Opus round-1 findings integrated — F-numbers below refer to that ledger).
--
-- ⚠ ORDERING IS LOAD-BEARING (F7): enum + status column BEFORE the helpers that
--   read status; helpers BEFORE the policy that calls them. 0013 (hook/trigger)
--   and 0014 (RLS sweep) depend on this file. Supabase runs each migration in a
--   transaction, so a half-apply rolls back cleanly.
--
-- ⚠ LOCKOUT SEQUENCING: org_membership.status is added NOT NULL DEFAULT 'active',
--   which atomically backfills every EXISTING member as 'active' — nobody
--   (including the operator) loses access. The default deliberately stays
--   'active': the only client-reachable insert path into org_membership is the
--   SECURITY DEFINER trigger (no INSERT policy exists), so the default is
--   reachable only by service-role/trigger code; 0013's trigger writes 'pending'
--   EXPLICITLY for the org-code path. Status-less inserts in seed/verify scripts
--   keep working unchanged.

-- gen_random_bytes lives in pgcrypto (enabled by default on Supabase; idempotent guard)
create extension if not exists pgcrypto with schema extensions;

-- ── membership state machine: pending → active (admin approve, 0014) ──
create type public.membership_status as enum ('pending','active');
alter table public.org_membership
  add column status public.membership_status not null default 'active';

-- ── code utilities: ONE canonical generator + ONE canonical normalizer ──
-- 16 chars from a 31-char alphabet (no 0/O/1/I/L) ≈ 79 bits. Canonical stored
-- form is dashless uppercase; display layers add XXXX-XXXX-XXXX-XXXX dashes.
create function public.new_invite_token()
  returns text
  language plpgsql volatile
  security definer set search_path = ''
as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';  -- 31 chars, unambiguous
  raw   bytea;
  v_out text := '';
  i     int;
begin
  raw := extensions.gen_random_bytes(16);
  for i in 0..15 loop
    v_out := v_out || substr(alphabet, (get_byte(raw, i) % 31) + 1, 1);
  end loop;
  return v_out;
end;
$$;

-- uppercase + strip every non-alphanumeric (dashes, spaces); empty → NULL.
-- Non-string JSON smuggled into user_metadata arrives as its text form and
-- normalizes to a non-matching string — "Invalid invite code", never a RAISE (F8).
create function public.normalize_invite_code(p text)
  returns text
  language sql immutable
  security definer set search_path = ''
as $$
  select nullif(upper(regexp_replace(coalesce(p, ''), '[^0-9A-Za-z]', '', 'g')), '');
$$;

-- ── admin helpers (SECURITY DEFINER: policies on org_membership must not recurse
--    into their own RLS — same pattern as 0002's is_org_member/shares_org) ──
create function public.is_org_admin(p_org uuid)
  returns boolean
  language sql stable
  security definer set search_path = ''
as $$
  select exists (
    select 1 from public.org_membership
    where org_id = p_org and user_id = (select auth.uid())
      and role = 'admin' and status = 'active'
  );
$$;

-- viewer is an ACTIVE ADMIN of an org where the target profile is PENDING —
-- powers the 0014 profiles policy that lets admins (only) read pending members'
-- name/email for the approval panel.
create function public.admin_of_pending_profile(p_profile uuid)
  returns boolean
  language sql stable
  security definer set search_path = ''
as $$
  select exists (
    select 1 from public.org_membership pm
    where pm.user_id = p_profile and pm.status = 'pending'
      and exists (
        select 1 from public.org_membership me
        where me.org_id = pm.org_id and me.user_id = (select auth.uid())
          and me.role = 'admin' and me.status = 'active'
      )
  );
$$;

-- ── single-use invite codes (solo access; operator-issued; service-role only) ──
create table public.invite_codes (
  code        text primary key,                 -- canonical 16-char dashless form
  note        text,                             -- operator note: who this is for
  expires_at  timestamptz not null,             -- default 7 days, set at creation
  consumed_at timestamptz,                      -- atomic claim stamp (0013 trigger)
  consumed_by uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

-- ── org join codes: exactly ONE active code per org (PK = org_id); rotation
--    replaces it in place, killing the old code instantly ──
create table public.org_join_codes (
  org_id     uuid primary key references public.organizations(id) on delete cascade,
  code       text not null unique,
  expires_at timestamptz,                       -- NULL = no expiry (product default);
                                                -- settable at rotation (F2 lever)
  rotated_at timestamptz not null default now(),
  rotated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ── RLS + grants: deny-by-default, same posture as allowed_emails ──
alter table public.invite_codes   enable row level security;  -- NO policies → client-deny
alter table public.org_join_codes enable row level security;
grant all on public.invite_codes, public.org_join_codes to service_role;
grant select on public.org_join_codes to authenticated;       -- RLS narrows to admins:
create policy ojc_select_admin on public.org_join_codes
  for select to authenticated using ( (select public.is_org_admin(org_id)) );

-- ── grant hygiene (F6): CREATE FUNCTION defaults EXECUTE to PUBLIC — strip it
--    explicitly on every new function, then grant back only what each needs. ──
revoke execute on function public.new_invite_token()             from public, anon, authenticated;
grant  execute on function public.new_invite_token()             to service_role;
revoke execute on function public.normalize_invite_code(text)    from public, anon, authenticated;
-- (normalize_invite_code is called only by the 0013 DEFINER hook/trigger, as owner)
revoke execute on function public.is_org_admin(uuid)             from public, anon;
revoke execute on function public.admin_of_pending_profile(uuid) from public, anon;
-- ⚠ The PUBLIC revoke above ALSO strips authenticated's IMPLICIT execute (a function's
-- default EXECUTE lives on PUBLIC; roles rarely hold direct entries). Whether anything
-- survives depends on the project's ALTER DEFAULT PRIVILEGES config — which DIFFERS
-- between Supabase projects (bit prod 2026-07-10; dev only worked by accident — see
-- gotchas). RLS policies evaluate these helpers as the QUERYING role, so authenticated
-- needs an EXPLICIT grant; both are auth.uid()-parameterized booleans with no data reach.
grant  execute on function public.is_org_admin(uuid)             to authenticated;
grant  execute on function public.admin_of_pending_profile(uuid) to authenticated;
