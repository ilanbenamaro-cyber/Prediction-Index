-- 0013 — self-service invites, part 2 of 3: the AUTH GATE. Rewrites the
-- Before-User-Created hook (three acceptance paths) and handle_new_user
-- (atomic consumption + provisioning), and adds the org-code rotation RPC.
-- Requires 0012 (tables, status column, helpers). 0014 (RLS sweep) follows.
--
-- Design: docs/design/self-service-invites-design.md §6 (operator-approved v2).
--
-- LOAD-BEARING SPLIT — validate-in-hook, consume-in-trigger:
--   The hook only READS (never writes, never raises — see the F1 wrapper), so a
--   code is never burned by a signup that fails downstream (duplicate email →
--   GoTrue's obfuscated fake-success creates no user and fires no trigger; email
--   deliverability rejections likewise). Consumption + provisioning happen in
--   handle_new_user, in the SAME TRANSACTION as the auth.users insert: the atomic
--   UPDATE ... WHERE consumed_at IS NULL claims the code, and any unredeemable
--   leftover (double-redeem race loser, rotation between hook and trigger) hits
--   RAISE → the user insert ROLLS BACK → fail CLOSED (GoTrue surfaces a 500
--   "Database error saving new user"; acceptable for a razor-thin race).
--
-- ⚠ APPLY 0013 AND 0014 TOGETHER on a live project: between them, a pending
--   membership could exist while is_org_member is still status-blind (0002 body),
--   briefly granting a pending signup active-like reads. Dev-only transient; do
--   not leave a live project sitting between 0013 and 0014.
--
-- CREATE OR REPLACE preserves the hook function's ACLs (supabase_auth_admin
-- execute, 0003) AND its dashboard hook registration (same pg-functions URI) —
-- no dashboard change needed. The on_auth_user_created trigger keeps pointing at
-- handle_new_user by name.

-- ── 1. signup gate: three paths, deny by default, NEVER raises ──
create or replace function public.hook_restrict_signup_to_allowlist(event jsonb)
  returns jsonb
  language plpgsql
  security definer set search_path = ''
as $$
declare
  v_email text;
  v_code  text;
begin
  v_email := lower(event->'user'->>'email');

  -- Path 1 (operator override, unchanged 0003 behavior): explicit allowlist hit.
  -- Priority means: allowlisted email + a code → allowlist wins, code untouched.
  if v_email is not null and exists (
       select 1 from public.allowed_emails where email = v_email
     ) then
    return '{}'::jsonb;                       -- allow → user is created
  end if;

  v_code := public.normalize_invite_code(event->'user'->'user_metadata'->>'invite_code');
  if v_code is not null then
    -- Path 2: single-use invite code — VALIDATE only; consumption is atomic in
    -- handle_new_user. Distinct used/expired messages are reachable only by a
    -- holder of the exact ~79-bit string; an enumerator learns nothing but "invalid".
    if exists (select 1 from public.invite_codes where code = v_code) then
      if exists (select 1 from public.invite_codes
                 where code = v_code and consumed_at is not null) then
        return jsonb_build_object('error', jsonb_build_object(
          'message', 'This invite code has already been used.', 'http_code', 403));
      end if;
      if exists (select 1 from public.invite_codes
                 where code = v_code and expires_at <= now()) then
        return jsonb_build_object('error', jsonb_build_object(
          'message', 'This invite code has expired — ask for a new one.', 'http_code', 403));
      end if;
      return '{}'::jsonb;
    end if;
    -- Path 3: org join code (the CURRENT code only; rotation kills the old one)
    if exists (select 1 from public.org_join_codes where code = v_code
                 and (expires_at is null or expires_at > now())) then
      return '{}'::jsonb;
    end if;
    if exists (select 1 from public.org_join_codes where code = v_code) then
      return jsonb_build_object('error', jsonb_build_object(
        'message', 'This invite code has expired — ask for a new one.', 'http_code', 403));
    end if;
    return jsonb_build_object('error', jsonb_build_object(
      'message', 'Invalid invite code.', 'http_code', 403));
  end if;

  -- DENY BY DEFAULT — generic, reveals nothing (message unchanged from 0003)
  return jsonb_build_object('error', jsonb_build_object(
    'message', 'Access is invite-only — ask your administrator to add your email.',
    'http_code', 403));
exception when others then
  -- F1: this hook is the sole gate for the no-code path — a runtime error inside
  -- it must be structurally a DENY, never a pass-through to GoTrue's unverified
  -- hook-error semantics.
  return jsonb_build_object('error', jsonb_build_object(
    'message', 'Access is invite-only — ask your administrator to add your email.',
    'http_code', 403));
end;
$$;

-- ── 2. provisioning: consume + provision atomically with the user insert ──
create or replace function public.handle_new_user()
  returns trigger
  language plpgsql
  security definer set search_path = ''
as $$
declare
  v_email text;
  v_org   uuid;
  v_role  public.org_role;
  v_code  text;
  v_hit   text;
begin
  -- explicit guard (F8): a user with no email (e.g. anonymous auth, if ever
  -- enabled) must never consume a code or gain provisioning — fail closed, loudly.
  if new.email is null then
    raise exception 'email is required for provisioning';
  end if;
  v_email := lower(new.email);
  -- display_name capped at 80 chars (F8: unbounded attacker-controlled metadata)
  insert into public.profiles (id, email, display_name)
    values (new.id, v_email,
            nullif(left(trim(new.raw_user_meta_data->>'display_name'), 80), ''))
    on conflict (id) do nothing;

  -- Path 1: allowlist (operator override) → ACTIVE membership, exactly as 0003
  select org_id, role into v_org, v_role
    from public.allowed_emails where email = v_email;
  if v_org is not null then
    insert into public.org_membership (org_id, user_id, role)   -- status defaults 'active'
      values (v_org, new.id, v_role)
      on conflict (org_id, user_id) do nothing;
    update public.allowed_emails set consumed_at = now()
      where email = v_email and consumed_at is null;
    return new;
  end if;

  v_code := public.normalize_invite_code(new.raw_user_meta_data->>'invite_code');
  if v_code is not null then
    -- Path 2: ATOMIC single-use claim (row lock; the race loser matches 0 rows
    -- after the winner commits — READ COMMITTED re-evaluates the WHERE)
    update public.invite_codes
       set consumed_at = now(), consumed_by = new.id
     where code = v_code and consumed_at is null and expires_at > now()
     returning code into v_hit;
    if v_hit is not null then
      return new;                       -- solo access: profile only, NO membership row
    end if;
    -- Path 3: org join code → PENDING membership (expiry re-checked: a hook-time
    -- pass does not exempt a code that expired between hook and trigger)
    select org_id into v_org from public.org_join_codes
      where code = v_code and (expires_at is null or expires_at > now());
    if v_org is not null then
      insert into public.org_membership (org_id, user_id, role, status)
        values (v_org, new.id, 'member', 'pending')
        on conflict (org_id, user_id) do nothing;
      return new;
    end if;
    -- A code was supplied but is no longer redeemable (race lost / rotated /
    -- expired between hook and trigger): FAIL CLOSED — abort the user insert.
    raise exception 'invite code is no longer valid';
  end if;

  return new;  -- no code, no allowlist: admin-API-created user → profile only (as 0003)
end;
$$;

-- ── 3. org-code rotation (org admins; also usable at first issuance) ──
create function public.rotate_org_join_code(p_org uuid, p_expires_days int default null)
  returns text
  language plpgsql volatile
  security definer set search_path = ''
as $$
declare
  v_code text;
begin
  if not public.is_org_admin(p_org) then
    raise exception 'not an organization admin' using errcode = '42501';
  end if;
  v_code := public.new_invite_token();
  insert into public.org_join_codes (org_id, code, expires_at, rotated_at, rotated_by)
    values (p_org, v_code,
            case when p_expires_days is null then null
                 else now() + make_interval(days => p_expires_days) end,
            now(), (select auth.uid()))
  on conflict (org_id) do update
    set code = excluded.code, expires_at = excluded.expires_at,
        rotated_at = now(), rotated_by = excluded.rotated_by;
  return v_code;
end;
$$;

-- grant hygiene (F6): strip default PUBLIC execute; the function self-guards via
-- is_org_admin, so authenticated may call it (non-admins get 42501).
revoke execute on function public.rotate_org_join_code(uuid, int) from public, anon;
grant  execute on function public.rotate_org_join_code(uuid, int) to authenticated, service_role;
