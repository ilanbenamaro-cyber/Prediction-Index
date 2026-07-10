-- 0013 DOWN — restores the 0003 bodies of the hook + handle_new_user VERBATIM
-- (allowlist-only gate, no code paths) and drops the rotation RPC.
-- CREATE OR REPLACE preserves ACLs + the dashboard hook registration both ways.
-- ⚠ Apply 0014_down FIRST if 0014 was applied.

-- ── 1. signup gate: 0003 body (allowlist-only, deny by default) ──
create or replace function public.hook_restrict_signup_to_allowlist(event jsonb)
  returns jsonb
  language plpgsql
  security definer set search_path = ''      -- runs as owner; pin search_path
as $$
declare
  v_email text;
begin
  -- DENY BY DEFAULT: a missing/null/empty/malformed email yields no match below,
  -- so it falls through to the reject branch. Allow ONLY on explicit allowlist hit.
  v_email := lower(event->'user'->>'email');
  if v_email is not null and exists (
       select 1 from public.allowed_emails where email = v_email
     ) then
    return '{}'::jsonb;                       -- allow → user is created
  end if;
  -- Generic message: never reveals allowlist contents or near-matches.
  return jsonb_build_object(
    'error', jsonb_build_object(
      'message', 'Access is invite-only — ask your administrator to add your email.',
      'http_code', 403
    )
  );                                          -- reject → NO auth.users row created
end;
$$;

-- ── 2. auto-provision: 0003 body (allowlist-only provisioning) ──
create or replace function public.handle_new_user()
  returns trigger
  language plpgsql
  security definer set search_path = ''
as $$
declare
  v_email text;
  v_org   uuid;
  v_role  public.org_role;
begin
  v_email := lower(new.email);
  -- idempotent: this trigger fires for admin-created users too
  insert into public.profiles (id, email)
    values (new.id, v_email)
    on conflict (id) do nothing;
  -- provision membership from the allowlist entry, if one exists
  select org_id, role into v_org, v_role
    from public.allowed_emails where email = v_email;
  if v_org is not null then
    insert into public.org_membership (org_id, user_id, role)
      values (v_org, new.id, v_role)
      on conflict (org_id, user_id) do nothing;
    update public.allowed_emails set consumed_at = now()
      where email = v_email and consumed_at is null;
  end if;
  return new;
end;
$$;

-- ── 3. rotation RPC ──
drop function public.rotate_org_join_code(uuid, int);
