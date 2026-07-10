# Self-Service Invites — Phase 1 Design (v2, post-Opus review)

Status: PROPOSED — Opus adversarial review integrated (§12); awaiting operator approval. Nothing here is applied.
Author: Fable (design/orchestration) · Date: 2026-07-10 · Target migration: `0012_self_service_invites.sql`

## 0. Verified mechanics (Context7, current docs)

- `supabase.auth.signUp({ email, password, options: { data: {...} } })` stores `data` in
  `auth.users.raw_user_meta_data`.
- The **Before User Created** hook receives `{ metadata, user }` where `user` is the prospective
  user object **including `user_metadata`** — so the code travels as
  `event->'user'->'user_metadata'->>'invite_code'`. Rejection format is unchanged:
  `{"error": {"http_code": 403, "message": "..."}}`.
- In the after-insert trigger the same value is `new.raw_user_meta_data->>'invite_code'`.
- `CREATE OR REPLACE` on `hook_restrict_signup_to_allowlist` keeps the function's grants AND its
  dashboard hook registration (same `pg-functions://postgres/public/...` URI) — **no dashboard
  change needed** where the hook is already enabled.
- Belt-and-braces: `verify-invite-flows.mjs` asserts the metadata→hook transport end-to-end as its
  first positive check; if a GoTrue version ever stopped passing metadata to the hook, valid codes
  would be rejected (fail CLOSED, loudly), never accepted silently.

## 1. Acceptance model — three paths, deny by default

Order of evaluation in the hook (first hit wins; everything else → reject):

1. **allowed_emails match** (existing operator override — byte-for-byte unchanged behavior).
   Provisioning: active membership from the allowlist row, `consumed_at` stamped. Priority means:
   allowlisted email + a code → allowlist wins, the code is NOT consumed.
2. **Single-use invite code** → account with profile only, **no org membership** (solo access).
3. **Org join code** → account + `org_membership` row with `status='pending'`.
4. No match → generic 403 `"Access is invite-only — ask your administrator to add your email."`

**Validate-in-hook, consume-in-trigger.** The hook only VALIDATES (exists / not consumed / not
expired) and never writes. Consumption + provisioning happen atomically in `handle_new_user`
(after-insert on `auth.users`, same transaction as user creation). Rationale:

- A code is never burned by a signup that subsequently fails (duplicate email → GoTrue's
  obfuscated fake-success creates no user, fires no trigger, consumes nothing; email
  deliverability validation failures likewise).
- The double-redeem race closes at the trigger: `UPDATE ... WHERE consumed_at IS NULL RETURNING`
  is the atomic claim. The race loser (and a signup racing an org-code rotation) hits
  `RAISE EXCEPTION` → the `auth.users` INSERT **rolls back** → no account → fail CLOSED. GoTrue
  surfaces this as "Database error saving new user" (acceptable for a razor-thin race).

## 2. Code format

- Canonical stored form: 16 chars, uppercase, alphabet `23456789ABCDEFGHJKMNPQRSTUVWXYZ`
  (31 chars; no `0/O/1/I/L`) → ~79 bits. Display form adds dashes: `XXXX-XXXX-XXXX-XXXX`.
- ONE canonical generator: SQL `public.new_invite_token()` (SECURITY DEFINER,
  `extensions.gen_random_bytes`, execute: service_role only; the rotate RPC calls it as owner).
  Scripts obtain codes via `rpc('new_invite_token')` — no second implementation in Node.
- ONE canonical normalizer: `public.normalize_invite_code(text)` — uppercase, strip every
  non-alphanumeric (dashes/spaces), empty → NULL. Used by hook, trigger, and nowhere else needed.
- Known negligible: modulo-31 bias over 256 byte values ≈ <1 bit total loss at 16 chars; GoTrue
  signup rate limiting further kills online guessing.

## 3. Schema (migration `0012_self_service_invites.sql`, additive, with `_down`)

```sql
-- pgcrypto for gen_random_bytes (enabled by default on Supabase; idempotent guard anyway)
create extension if not exists pgcrypto with schema extensions;

-- ── membership state machine ──
create type public.membership_status as enum ('pending','active');
alter table public.org_membership
  add column status public.membership_status not null default 'active';
```

**Lockout sequencing (the invariant's ⚠):** `ADD COLUMN ... NOT NULL DEFAULT 'active'` backfills
every existing row as `active` atomically in the same statement — the operator and all existing
members stay in. The default deliberately stays `'active'`: the ONLY client-reachable insert path
into `org_membership` is the SECURITY DEFINER trigger (no INSERT policy exists), so the default is
reachable only by service-role/trigger code; allowlist provisioning and every existing
seed/verify script keep working unchanged, and the trigger writes `'pending'` explicitly for the
org-code path.

```sql
-- ── single-use invite codes (solo access; operator-issued; service-role only) ──
create table public.invite_codes (
  code        text primary key,                 -- canonical 16-char form
  note        text,                             -- operator note: who this is for
  expires_at  timestamptz not null,             -- default 7 days, set at creation
  consumed_at timestamptz,
  consumed_by uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

-- ── org join codes: exactly ONE active code per org (PK=org_id); rotation replaces it ──
create table public.org_join_codes (
  org_id     uuid primary key references public.organizations(id) on delete cascade,
  code       text not null unique,
  expires_at timestamptz,                       -- NULL = no expiry (product default);
                                                -- settable at rotation (Opus F2 lever)
  rotated_at timestamptz not null default now(),
  rotated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.invite_codes   enable row level security;  -- NO policies → client-deny
alter table public.org_join_codes enable row level security;
grant all on public.invite_codes, public.org_join_codes to service_role;
grant select on public.org_join_codes to authenticated;       -- RLS narrows to active org admins
create policy ojc_select_admin on public.org_join_codes
  for select to authenticated using ( (select public.is_org_admin(org_id)) );
```

`invite_codes` stays plaintext in a service-role-only table (same trust level as
`allowed_emails`); org admins must be able to READ their current join code to share it, which
rules out hash-at-rest for `org_join_codes` without a heavier envelope design. Mitigations:
entropy, single-use/rotation, and the no-plaintext-in-logs rule (§9).

## 4. Helper + RLS sweep (`status='active'` everywhere)

The two SECURITY DEFINER helpers are the single choke point — patching them fixes every
existing policy that routes through them:

| Object | Change | Downstream policies auto-fixed |
|---|---|---|
| `is_org_member(p_org)` | `+ and status='active'` | `org_select_member`, `orgmem_select_member`, `ow_select_member`, `ow_insert_member`, `ow_delete_member` (→ `my_visible_watchlist` view + `readScan` firewall + `listVisible` inherit) |
| `shares_org(p_other)` | `+ a.status='active' and b.status='active'` (both sides) | `profiles_select_self_or_coorg` |
| `is_org_admin(p_org)` **(new)** | active admin check | used by every new admin policy + rotate RPC |
| `admin_of_pending_profile(p)` **(new)** | viewer is active admin of an org where target is pending | new profiles policy |

```sql
create or replace function public.is_org_member(p_org uuid)
  returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.org_membership
    where org_id = p_org and user_id = (select auth.uid()) and status = 'active');
$$;

create or replace function public.shares_org(p_other uuid)
  returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.org_membership a
    join public.org_membership b using (org_id)
    where a.user_id = (select auth.uid()) and b.user_id = p_other
      and a.status = 'active' and b.status = 'active');
$$;

create function public.is_org_admin(p_org uuid)
  returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.org_membership
    where org_id = p_org and user_id = (select auth.uid())
      and role = 'admin' and status = 'active');
$$;

create function public.admin_of_pending_profile(p_profile uuid)
  returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.org_membership pm
    where pm.user_id = p_profile and pm.status = 'pending'
      and exists (select 1 from public.org_membership me
        where me.org_id = pm.org_id and me.user_id = (select auth.uid())
          and me.role = 'admin' and me.status = 'active'));
$$;
```

**What a `pending` member can reach — exhaustive:**
- `organizations` → nothing (can't even see the org's name; the pending banner stays generic).
- `org_membership` → own row only (new `orgmem_select_self`) — powers "pending approval" UX.
- `org_watchlist` → nothing (select/insert/delete all via `is_org_member`).
- `my_visible_watchlist` → personal rows only. `readScan` ids ⊆ that → rail is personal-only.
- `profiles` → self only (`shares_org` now requires both sides active).
- Personal watchlist CRUD → full (unchanged — `auth.uid()`-scoped, no org dependency).
- `AddToWatchlist` org targets, `addOrg`, search-add to org → 42501 (policy-denied).

**Note:** active members of an org CAN see pending membership ROWS of that org
(`orgmem_select_member` filters by org, not by row status) — deliberate, the admin panel needs
it — but only active **admins** can see a pending member's PROFILE (name/email), via:

```sql
create policy profiles_select_admin_pending on public.profiles
  for select to authenticated using ( (select public.admin_of_pending_profile(id)) );
```

## 5. Approval state machine — admin-only, RLS-enforced

Transitions (all others impossible):
- `pending → active` — admin UPDATE (approve)
- `pending → ∅` — admin DELETE (reject) or self DELETE (cancel request)
- `active → ∅` — admin DELETE (remove) or self DELETE (leave)

```sql
-- pending member sees own row; active member sees own rows too (harmless overlap)
create policy orgmem_select_self on public.org_membership
  for select to authenticated using ( user_id = (select auth.uid()) );

-- approve: STATUS IS THE ONLY UPDATABLE COLUMN — column-level grant, not a policy trick.
-- role/org_id/user_id updates → permission denied regardless of any policy.
-- WITH CHECK pins the NEW row to status='active' (Opus F5): the UPDATE is APPROVE-ONLY —
-- active→pending (silent access-strip) is unreachable; demotion = delete (audit-visible).
grant update (status) on public.org_membership to authenticated;
create policy orgmem_update_admin on public.org_membership
  for update to authenticated
  using     ( (select public.is_org_admin(org_id)) and user_id <> (select auth.uid()) )
  with check( (select public.is_org_admin(org_id)) and user_id <> (select auth.uid())
              and status = 'active' );

grant delete on public.org_membership to authenticated;
create policy orgmem_delete_admin on public.org_membership
  for delete to authenticated
  using ( (select public.is_org_admin(org_id)) and user_id <> (select auth.uid()) );
create policy orgmem_delete_self on public.org_membership
  for delete to authenticated using ( user_id = (select auth.uid()) );
```

Properties: a non-admin cannot approve (no policy row match → 0 rows / 42501); nobody can
approve or remove **themselves** via the admin policies (`user_id <> auth.uid()` — kills
self-approval outright and the set-own-status-to-pending foot-gun); a member/pending user can
delete their OWN row (leave/cancel). `INSERT` stays policy-less → clients still cannot join an
org by any direct write.

Accepted edges (documented, not blocked): an admin may remove another admin; the last admin may
leave, orphaning the org's admin functions (operator repair = one service-role UPDATE). A
rejected user keeps their account + personal watchlist but CANNOT re-apply **with that account** —
code redemption exists only at signup in v1; re-joining requires the operator/admin.

**Corrected claim (Opus F2):** the org-code path IS re-applyable with fresh emails — anyone
holding the org code can sign up new accounts → new pending rows, indefinitely, until the code
is rotated or expired. Bounds: each spam application costs a real signup (GoTrue rate limits),
lands as `pending` with zero data access, and is one-click rejectable; the levers are rotation
(kills the code instantly) and the new optional `expires_at` (§3). The single-use invite path
has no such surface (burned on first redemption).

## 6. Hook + trigger (full rewrites, CREATE OR REPLACE)

### 6.1 `hook_restrict_signup_to_allowlist` — validate only, never write, never raise

The entire body is wrapped in `exception when others → generic 403` (Opus F1): the invite-only
guarantee must not depend on GoTrue's semantics for a hook that THROWS — with the wrapper, a
runtime error inside the hook is structurally a deny. Phase 4 additionally verifies GoTrue's
raw behavior once in dev (temporarily point the hook at a raising function; assert no user row),
and the hook-enabled state stays a release gate (the existing negative gate proves both).

```sql
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

  -- Path 1 (operator override, unchanged): explicit allowlist hit
  if v_email is not null and exists (
       select 1 from public.allowed_emails where email = v_email
     ) then
    return '{}'::jsonb;
  end if;

  v_code := public.normalize_invite_code(event->'user'->'user_metadata'->>'invite_code');
  if v_code is not null then
    -- Path 2: single-use invite code — validate; consumption is atomic in handle_new_user
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
    -- Path 3: org join code (the CURRENT code only; rotation kills the old one instantly)
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

  -- DENY BY DEFAULT — generic, reveals nothing (unchanged message)
  return jsonb_build_object('error', jsonb_build_object(
    'message', 'Access is invite-only — ask your administrator to add your email.',
    'http_code', 403));
exception when others then
  -- F1: a runtime error inside the gate is a DENY, never a pass-through to GoTrue
  return jsonb_build_object('error', jsonb_build_object(
    'message', 'Access is invite-only — ask your administrator to add your email.',
    'http_code', 403));
end;
$$;
```

Distinct code-state messages (used/expired/invalid) are only reachable by someone already holding
the exact ~79-bit string — an enumerator learns nothing but "invalid". The no-code rejection stays
the existing generic message (signup form maps it exactly as today).

### 6.2 `handle_new_user` — consume + provision atomically

```sql
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
  -- explicit guard (Opus F8): a user with no email (e.g. anonymous auth, if ever enabled)
  -- must never consume a code or gain provisioning — fail closed, loudly.
  if new.email is null then
    raise exception 'email is required for provisioning';
  end if;
  v_email := lower(new.email);
  -- display_name capped at 80 chars (F8: unbounded attacker-controlled metadata)
  insert into public.profiles (id, email, display_name)
    values (new.id, v_email,
            nullif(left(trim(new.raw_user_meta_data->>'display_name'), 80), ''))
    on conflict (id) do nothing;

  -- Path 1: allowlist (operator override) → ACTIVE membership, exactly as today
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
    -- Path 2: ATOMIC single-use claim (row lock; the race loser matches 0 rows)
    update public.invite_codes
       set consumed_at = now(), consumed_by = new.id
     where code = v_code and consumed_at is null and expires_at > now()
     returning code into v_hit;
    if v_hit is not null then
      return new;                       -- solo access: profile only, NO membership row
    end if;
    -- Path 3: org join code → PENDING membership (expiry re-checked: hook-time pass
    -- does not exempt a code that expired between hook and trigger)
    select org_id into v_org from public.org_join_codes
      where code = v_code and (expires_at is null or expires_at > now());
    if v_org is not null then
      insert into public.org_membership (org_id, user_id, role, status)
        values (v_org, new.id, 'member', 'pending')
        on conflict (org_id, user_id) do nothing;
      return new;
    end if;
    -- Code supplied but no longer redeemable (race lost / rotated between hook and
    -- trigger): FAIL CLOSED — abort the auth.users insert entirely.
    raise exception 'invite code is no longer valid';
  end if;

  return new;  -- no code, no allowlist: admin-API-created user → profile only (unchanged)
end;
$$;
```

**Metadata scrub: DROPPED (Opus F4).** The v1 draft scrubbed `invite_code` from
`raw_user_meta_data` inside the trigger. Opus's analysis: GoTrue holds the user object in memory
mid-signup and re-persists metadata on later steps (confirm-token write, session issuance), so
the scrub can be silently undone; the client already received the code in the response; and for
the org code the live secret is in `org_join_codes` regardless — the scrub removes zero
capability while writing to `auth.users` under GoTrue's feet. The residual (a redeemer's own
metadata retains the string they themselves typed) is accepted; rotation is the real lever.

### 6.3 Rotate RPC (org admins)

```sql
create function public.rotate_org_join_code(p_org uuid, p_expires_days int default null)
  returns text language plpgsql volatile
  security definer set search_path = ''
as $$
declare v_code text;
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

-- ── grant hygiene (Opus F6): CREATE FUNCTION defaults EXECUTE to PUBLIC — revoke
--    explicitly on EVERY new function; then grant back only what each needs. ──
revoke execute on function public.rotate_org_join_code(uuid, int)   from public, anon, authenticated;
grant  execute on function public.rotate_org_join_code(uuid, int)   to authenticated, service_role;
revoke execute on function public.new_invite_token()                from public, anon, authenticated;
grant  execute on function public.new_invite_token()                to service_role;
revoke execute on function public.normalize_invite_code(text)       from public, anon, authenticated;
revoke execute on function public.is_org_admin(uuid)                from public, anon;
revoke execute on function public.admin_of_pending_profile(uuid)    from public, anon;
-- (is_org_admin / admin_of_pending_profile keep authenticated execute: policies evaluate
-- them as the querying role; both are auth.uid()-parameterized booleans — no data reach.)
-- new_invite_token / normalize_invite_code are called only by DEFINER functions (as owner)
-- and, for token minting, by service-role scripts via rpc.
```

## 7. UI (LEDGER design system: 0-radius, mono chrome, hairline rules, text actions)

### 7.1 Signup form (`app/(auth)/signup/page.tsx`)
- New fields: **Name** (required — institutional roster legibility; lands in
  `profiles.display_name`, column already exists; `maxLength={80}` mirroring the trigger cap)
  and **Invite or organization code** (optional — allowlisted users leave it blank).
- `/signup?code=XYZ` pre-fills the code field via `useSearchParams` (client component wrapped in
  `<Suspense>` — Next 15 requirement). **URL hygiene (Opus F3):** immediately after prefill the
  param is stripped via `history.replaceState` (the reusable org code must not linger in the
  address bar / browser history), and the signup page sets `<meta name="referrer"
  content="no-referrer">` so the code can never ride a `Referer` header.
- `signUp` call gains `options: { data: { display_name, ...(code ? { invite_code: code } : {}) } }`
  (never store an empty key).
- Error mapping extended, each state distinct: already-used / expired / invalid-code /
  generic invite-only (no-code path — message unchanged from today).
- Extract `mapError` to `lib/signup-errors.ts` with a table-driven unit test (it's about to
  quadruple in branches; keeps the logic in the 458+ suite).

### 7.2 Admin approval panel (rail, Group view)
Location: inside the rail when `view.mode === 'org'` — a `PendingMembers` client component under
the org selector. LEDGER treatment: `PENDING — 2` micro label; one hairline-ruled row per person:
`name · email · requested <date>` in mono, with `APPROVE` / `REJECT` text actions (no buttons, no
badges). Admins also see `JOIN CODE XXXX-XXXX-XXXX-XXXX · ROTATE` (code visible via
`ojc_select_admin`; rotate via the RPC, with an "old code stops working immediately" hint).
- Data: `org_membership` where `org_id=activeOrg, status='pending'` + `profiles` for those ids
  (admin-only via `profiles_select_admin_pending`).
- Approve = `update org_membership set status='active' where org_id=? and user_id=?`;
  Reject = `delete`. Both are RLS-enforced Postgres decisions; the UI merely hides the panel for
  non-admins (courtesy, not the guard).
- Pending-count indicator on the Group toggle when >0 (cheap: same query).

### 7.3 Pending-member UX
Rail shows a one-line micro notice `ORGANIZATION ACCESS PENDING APPROVAL` when
`orgmem_select_self` returns a pending row. Generic on purpose — a pending member can't read the
org's name (RLS), and we don't widen for a banner.

## 8. Operator tooling

- `scripts/create-invite-code.mjs` — `--days 7` (default) `--note "for whom"`. Service-role:
  `rpc('new_invite_token')` → INSERT → prints the dashed code + `/signup?code=…` link to stdout
  (interactive stdout, not a structured log). Env from shell, same pattern as seed scripts.
- `scripts/create-org-code.mjs` — `--org <uuid|name>`. Resolves the org, `rpc('new_invite_token')`
  → upsert `org_join_codes` (rotation = same command; prints "previous code is now dead").

## 9. Invariants held

- Hook stays **deny-by-default**: every return path is an explicit allow on a positive match;
  the fall-through is the generic 403. The negative gate in `verify-phase2b-auth.mjs` runs
  UNCHANGED (no code in metadata → identical behavior).
- `verify-phase2b-isolation.mjs` UNCHANGED and green: status defaults `'active'`, so its
  membership upserts behave identically.
- All new functions: `SECURITY DEFINER set search_path = ''`, fully-qualified objects.
- New tables: RLS on; `invite_codes` policy-less (client-deny); `org_join_codes` one
  narrowly-scoped admin select policy; service_role grants explicit.
- Codes in plaintext only: in the DB (service-role-only reach + admin-scoped RLS), on the
  operator's stdout, transiently in the signup URL/field (stripped from the URL on prefill, §7.1),
  and in the redeemer's own `raw_user_meta_data` (accepted residual — see §6.2/F4). Never in
  structured logs.
- Parity 4/4, tsc 0, node --test ≥458 after every commit; `/api/market`, CRON_SECRET gates,
  readScan firewall, SpaceX frozen record, login flow: untouched.
- Migration additive with `0012_self_service_invites_down.sql`: drops new
  policies/grants/functions/tables/column/type and restores the 0002/0003 bodies of
  `is_org_member`, `shares_org`, `hook_restrict_signup_to_allowlist`, `handle_new_user` verbatim.

## 10. Test plan

**New blocking gate — `scripts/verify-invite-flows.mjs`** (service-role seeds, anon signUp
exercises, finally-cleanup; same skeleton as verify-phase2b-auth):
1. Garbage code → rejected "Invalid invite code", **no auth.users row**.
2. Expired invite code → rejected "expired", no row; code left unconsumed.
3. Valid invite code → account + profile (display_name landed) + **NO org_membership**;
   `consumed_at`/`consumed_by` stamped.
4. Same code again → rejected "already been used", no second account.
5. Valid org join code → account + `pending` membership; then AS THAT USER:
   `organizations` = [], `org_watchlist` = [], `my_visible_watchlist` has no org rows,
   co-member profile invisible, `addOrg` → 42501. Personal watchlist add/read works.
6. Non-admin member approve attempt → 0 rows / 42501; status still `pending`.
7. Pending user self-approve attempt → 0 rows; still `pending`.
8. Role-escalation attempt (`update ... set role='admin'`) → permission denied (column grant).
9. Admin approves → status `active`; org data now visible (organizations/org_watchlist/view).
10. Admin rejects a second pending user → row gone; that user's login + personal access intact.
11. Rotate org code (as admin via RPC) → old code signup rejected "Invalid invite code";
    new code works. Non-admin rotate → 42501.
12. Case/dash insensitivity: lowercase, dashed input accepted (normalizer).
13. Allowlist priority: allowlisted email + a valid invite code → ACTIVE membership from the
    allowlist row; the invite code is NOT consumed.
14. Expired ORG code (rotate with `p_expires_days`, backdate via service role) → signup
    rejected "expired"; no user row.
15. Approve-only UPDATE (Opus F5): admin attempt to set an ACTIVE member back to `pending`
    → 0 rows / 42501; status still `active`.
16. Existing gates re-run VERBATIM: `verify-phase2b-auth.mjs` (negative+positive),
    `verify-phase2b-isolation.mjs` — both must stay green with 0012 applied.

**One-time dev experiment (Opus F1, before the migration merges):** point the Before-User-Created
hook at a function that unconditionally RAISEs; attempt a signup; assert no `auth.users` row and
record GoTrue's observed behavior in the final report. Then restore. Regardless of the outcome,
the production hook ships with the `exception when others → deny` wrapper — the experiment
documents the platform's behavior; the wrapper removes the dependency on it.

**Unit tests (node --test):** `lib/signup-errors.ts` mapping table.
**Playwright (Phase 4, Sonnet):** signup with `?code=` prefill; each error state renders its
distinct message; pending banner; admin panel approve/reject/rotate; approved member sees Group
rail. Fable vision-reviews all screenshots.
**Standard gates:** tsc 0 · node --test ≥458 · parity 4/4 · build clean, after every commit.

## 11. Open items deliberately deferred

- Org admins issuing single-use invite codes (table supports it; needs an issuing RPC + UI).
- Post-signup code redemption (rejected users re-applying; joining a second org).
- Admin promotion UI (`role` changes stay service-role-only by design — column grant excludes it).
- Email notification to admins on new pending members.

## 12. Opus adversarial review — findings ledger + dispositions (round 1)

Reviewer: claude-opus-4-8, hostile-review instructions, full design + current migrations + data
paths in context. Verdict: "core RLS/column-grant/state-machine mechanics are sound — residual
risk concentrated in the hook's failure mode (F1) and the reusable org code (F2/F3)."

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| F1 | HIGH | Hook is the sole gate for the no-code path and its runtime-error semantics in GoTrue are unverified — a crafted input that makes the hook RAISE could fail OPEN | **ACCEPTED, fixed in §6.1**: `exception when others → generic 403` wrapper makes any internal error structurally a deny; plus a one-time dev experiment documenting GoTrue's raw raise behavior (§10); hook-enabled state remains a release gate |
| F2 | MED | "No re-apply spam surface" was FALSE for the org-code path: a code holder can mint fresh-email pending rows indefinitely | **ACCEPTED, fixed in §3/§5/§6.3**: claim corrected; `org_join_codes.expires_at` added (nullable — product default stays "no expiry", per the operator's design requirements — settable at rotation); bounds documented (rate limits, zero-access pending rows, one-click reject, rotation) |
| F3 | MED | Long-lived reusable org code in `?code=` URLs → browser history, Referer, access logs | **ACCEPTED, fixed in §7.1**: `history.replaceState` strips the param on prefill; `no-referrer` meta on the signup page; expiry lever from F2 |
| F4 | MED | Metadata scrub via `UPDATE auth.users` inside its own after-insert trigger is unreliable under GoTrue and removes zero capability | **ACCEPTED, dropped** (§6.2 records the reasoning) |
| F5 | LOW | `grant update (status)` permitted `active→pending` — outside the declared state machine | **ACCEPTED, fixed in §5**: `and status='active'` in WITH CHECK — the UPDATE is approve-only |
| F6 | LOW | Default PUBLIC EXECUTE on new functions; `new_invite_token` revoke must cover `public` and `authenticated` | **ACCEPTED, fixed in §6.3**: explicit revoke block for every new function |
| F7 | INFO | Migration statement ordering is load-bearing (column before sql-language helper replacement; helpers before policies) | **ACCEPTED**: ordering asserted in the migration structure (§3 note; extension → enum/column → helpers → tables/grants → policies → hook/trigger) |
| F8 | INFO | display_name unbounded; anonymous (null-email) signup only accidentally fail-closed | **ACCEPTED, fixed in §6.2/§7.1**: 80-char cap in trigger + input `maxLength`; explicit null-email RAISE guard before any consumption |

Confirmed solid by the review (no change needed): double-redeem race closure under READ
COMMITTED; rotation-vs-signup race fails closed; trigger rollback atomicity (no orphan profile);
column-grant role-escalation guard; self-approval block; no client INSERT path into membership;
pending-member personal-only reach across every read path incl. the readScan firewall;
`auth.uid()` reliability inside DEFINER functions; allowlist-beats-code priority; all four
existing verify/seed scripts unaffected by the `'active'` default.
