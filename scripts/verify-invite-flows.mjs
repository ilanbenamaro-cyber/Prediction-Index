// scripts/verify-invite-flows.mjs — self-service invites BLOCKING GATE.
//
// Proves, against a DEV Supabase with 0012+0013+0014 applied AND the
// Before-User-Created hook enabled, the full three-path acceptance model and the
// pending→active approval state machine (design doc §10, checks 1–15):
//
//   codes:      garbage/expired/consumed → REJECTED, no auth.users row, nothing
//               consumed; valid single-use → solo account (profile w/ display_name,
//               NO membership), atomically consumed; case/dash-insensitive input.
//   org path:   valid org code → PENDING membership; a pending member reaches
//               EXACTLY personal-only data (orgs/org_watchlist/union view/co-member
//               profiles all empty; org write 42501; personal CRUD works; own
//               pending row visible). Expired org code → rejected.
//   approvals:  non-admin approve → filtered (0 rows); self-approve → filtered;
//               role escalation → 42501 (column grant, not policy); approve-only
//               (active→pending demotion) → blocked; admin approve → org data
//               appears; admin reject → row gone, personal access intact.
//   rotation:   admin RPC rotates (old code dies instantly, new works);
//               non-admin rotate → 42501.
//   priority:   allowlisted email + valid code → ACTIVE membership from the
//               allowlist row; the code is NOT consumed.
//
// A VALID code being accepted is also the end-to-end proof of the metadata
// transport (signUp options.data → raw_user_meta_data → hook's user_metadata) —
// if a GoTrue change ever broke it, these positives would fail CLOSED, loudly.
//
// Uses the PUBLIC signUp flow via the anon key (admin.createUser would bypass the
// hook). Seeds its own throwaway orgs/users/codes/market, cleans up in finally.
//
//   SUPABASE_URL=… SUPABASE_ANON_KEY=… SUPABASE_SERVICE_ROLE_KEY=… \
//   node scripts/verify-invite-flows.mjs
// Exit: 0 pass · 1 a check failed · 2 not run (missing creds).

import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !ANON || !SERVICE) {
  console.error('Set SUPABASE_URL + SUPABASE_ANON_KEY + SUPABASE_SERVICE_ROLE_KEY (dev project).');
  process.exit(2);
}

const RUN = Date.now().toString(36);
const PW = 'Test-Passw0rd!';
const DOMAIN = process.env.TEST_EMAIL_DOMAIN || 'example.com'; // see verify-phase2b-auth note
const svc = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = () => createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });

let failures = 0;
const ok = (c, m) => { console.log(`${c ? '  ✓' : '  ✗ FAIL:'} ${m}`); if (!c) failures++; };
const dashedLower = (code) => code.replace(/(.{4})(?=.)/g, '$1-').toLowerCase(); // exercises the normalizer

async function findUser(email) {
  const { data, error } = await svc.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (error) throw new Error(`listUsers: ${error.message}`);
  return data.users.find((u) => (u.email || '').toLowerCase() === email.toLowerCase()) || null;
}

/** Public signUp carrying a code (+ optional display name) in options.data. */
async function signUpWith(email, code, displayName) {
  return anon().auth.signUp({
    email, password: PW,
    options: { data: { ...(displayName ? { display_name: displayName } : {}), ...(code ? { invite_code: code } : {}) } },
  });
}

/** Signed-in client (confirms the email via admin first — dev may have confirm ON). */
async function signedIn(email, uid) {
  if (uid) { try { await svc.auth.admin.updateUserById(uid, { email_confirm: true }); } catch { /* may already be confirmed */ } }
  const c = anon();
  const { data, error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error || !data?.session) throw new Error(`sign-in failed for ${email}: ${error?.message}`);
  return c;
}

/** Mint a canonical 16-char token server-side (the one generator). */
async function mintToken() {
  const { data, error } = await svc.rpc('new_invite_token');
  if (error || typeof data !== 'string' || data.length !== 16) throw new Error(`new_invite_token: ${error?.message ?? data}`);
  return data;
}

const created = { userIds: [], orgIds: [], markets: [], inviteCodes: [], emails: [] };
const email = (tag) => { const e = `inv_${tag}_${RUN}@${DOMAIN}`; created.emails.push(e.toLowerCase()); return e; };

async function run() {
  console.log(`\nself-service invites gate → ${URL}  (run ${RUN}, domain @${DOMAIN})\n`);

  // ── seed: org X with admin A + active member M (allowlist path, as the isolation
  //    gate does); market for personal-watchlist FKs; org Y for the expired-code check ──
  const oX = await svc.from('organizations').insert({ name: `invX_${RUN}` }).select('id').single();
  const oY = await svc.from('organizations').insert({ name: `invY_${RUN}` }).select('id').single();
  if (oX.error || oY.error) throw new Error(`seed orgs: ${oX.error?.message || oY.error?.message}`);
  const X = oX.data.id, Y = oY.data.id;
  created.orgIds.push(X, Y);

  const mkt = `zzz-inv-${RUN}-m1`;
  created.markets.push(mkt);
  const mi = await svc.from('markets').insert({ id: mkt, title: mkt, config: {} });
  if (mi.error) throw new Error(`seed market: ${mi.error.message}`);

  const emailA = email('admin'), emailM = email('member');
  const al = await svc.from('allowed_emails').insert([
    { email: emailA.toLowerCase(), org_id: X, role: 'admin' },
    { email: emailM.toLowerCase(), org_id: X, role: 'member' },
  ]);
  if (al.error) throw new Error(`seed allowlist: ${al.error.message}`);
  const A = await svc.auth.admin.createUser({ email: emailA, password: PW, email_confirm: true });
  const M = await svc.auth.admin.createUser({ email: emailM, password: PW, email_confirm: true });
  if (A.error || M.error) throw new Error(`seed users: ${A.error?.message || M.error?.message}`);
  created.userIds.push(A.data.user.id, M.data.user.id);
  const cAdmin = await signedIn(emailA);
  const cMember = await signedIn(emailM);

  // ── 1. garbage code → rejected "Invalid invite code", no user ──
  console.log('1. garbage code fails closed:');
  const e1 = email('garbage');
  const r1 = await signUpWith(e1, 'ZZZZ-ZZZZ-ZZZZ-ZZZZ');
  ok(!!r1.error && /invalid invite code/i.test(r1.error.message), `rejected "Invalid invite code" (got "${r1.error?.message}")`);
  ok(!(await findUser(e1)), `no auth.users row`);

  // ── 2. expired single-use code → rejected, NOT consumed ──
  console.log('2. expired invite code:');
  const tExp = await mintToken();
  created.inviteCodes.push(tExp);
  const insExp = await svc.from('invite_codes').insert({ code: tExp, note: `gate ${RUN}`, expires_at: new Date(Date.now() - 3_600_000).toISOString() });
  if (insExp.error) throw new Error(`seed expired code: ${insExp.error.message}`);
  const e2 = email('expired');
  const r2 = await signUpWith(e2, tExp);
  ok(!!r2.error && /expired/i.test(r2.error.message), `rejected "expired" (got "${r2.error?.message}")`);
  ok(!(await findUser(e2)), `no auth.users row`);
  const expRow = (await svc.from('invite_codes').select('consumed_at').eq('code', tExp).single()).data;
  ok(expRow?.consumed_at == null, `code left unconsumed`);

  // ── 3. valid single-use code → solo account, consumed; 4. reuse → rejected ──
  console.log('3. valid invite code → solo account, atomically consumed:');
  const tOne = await mintToken();
  created.inviteCodes.push(tOne);
  const insOne = await svc.from('invite_codes').insert({ code: tOne, note: `gate ${RUN}`, expires_at: new Date(Date.now() + 86_400_000).toISOString() });
  if (insOne.error) throw new Error(`seed code: ${insOne.error.message}`);
  const e3 = email('solo');
  const r3 = await signUpWith(e3, tOne, 'Invite Solo');
  ok(!r3.error && !!r3.data?.user, `signUp accepted (metadata → hook transport works)${r3.error ? ` — "${r3.error.message}"` : ''}`);
  const u3 = r3.data?.user?.id;
  if (u3) created.userIds.push(u3);
  const p3 = u3 ? (await svc.from('profiles').select('display_name').eq('id', u3).maybeSingle()).data : null;
  ok(p3?.display_name === 'Invite Solo', `profiles.display_name landed`);
  const m3 = u3 ? ((await svc.from('org_membership').select('org_id').eq('user_id', u3)).data ?? []) : [];
  ok(m3.length === 0, `NO org_membership (solo access)`);
  const c3 = (await svc.from('invite_codes').select('consumed_at, consumed_by').eq('code', tOne).single()).data;
  ok(!!c3?.consumed_at && c3?.consumed_by === u3, `consumed_at + consumed_by stamped`);

  console.log('4. consumed code cannot be reused:');
  const e4 = email('reuse');
  const r4 = await signUpWith(e4, tOne);
  ok(!!r4.error && /already been used/i.test(r4.error.message), `rejected "already been used" (got "${r4.error?.message}")`);
  ok(!(await findUser(e4)), `no auth.users row`);

  // ── 5. org join code → PENDING; pending member reaches personal-only ──
  console.log('5. org join code → pending membership; pending = personal-only reach:');
  const tOrg = await mintToken();
  const insJ = await svc.from('org_join_codes').insert({ org_id: X, code: tOrg });
  if (insJ.error) throw new Error(`seed org code: ${insJ.error.message}`);
  const e5 = email('pending');
  // lowercase + dashed input = check 12 (normalizer) riding the main positive path
  const r5 = await signUpWith(e5, dashedLower(tOrg), 'Pending Person');
  ok(!r5.error && !!r5.data?.user, `signUp accepted with lowercase+dashed code (normalizer)${r5.error ? ` — "${r5.error.message}"` : ''}`);
  const u5 = r5.data?.user?.id;
  if (u5) created.userIds.push(u5);
  const m5 = u5 ? (await svc.from('org_membership').select('org_id, role, status').eq('user_id', u5).maybeSingle()).data : null;
  ok(m5?.org_id === X && m5?.role === 'member' && m5?.status === 'pending', `org_membership: org X / member / PENDING`);
  const cPend = await signedIn(e5, u5);
  ok((await cPend.from('organizations').select('id')).data?.length === 0, `organizations = [] (can't even see the org name)`);
  ok((await cPend.from('org_watchlist').select('market_id')).data?.length === 0, `org_watchlist = []`);
  const vis5 = (await cPend.from('my_visible_watchlist').select('scope')).data ?? [];
  ok(vis5.every((r) => r.scope !== 'org'), `my_visible_watchlist has no org rows`);
  const prof5 = (await cPend.from('profiles').select('id')).data?.map((r) => r.id) ?? [];
  ok(prof5.length === 1 && prof5[0] === u5, `profiles = self only (no co-member reach)`);
  const own5 = (await cPend.from('org_membership').select('status')).data ?? [];
  ok(own5.length === 1 && own5[0].status === 'pending', `own pending row visible (orgmem_select_self — banner data path)`);
  const w5 = await cPend.from('org_watchlist').insert({ org_id: X, market_id: mkt, added_by: u5 });
  ok(!!w5.error, `org_watchlist insert REJECTED (${w5.error?.code ?? 'no error!'})`);
  const pw5 = await cPend.from('personal_watchlist').insert({ user_id: u5, market_id: mkt });
  ok(!pw5.error, `personal watchlist add works`);
  ok(((await cPend.from('personal_watchlist').select('market_id')).data ?? []).length === 1, `personal watchlist read works`);

  // ── 7. self-approve filtered ──
  console.log('7. pending user cannot self-approve:');
  const sa = await cPend.from('org_membership').update({ status: 'active' }).eq('org_id', X).eq('user_id', u5).select();
  ok((sa.data ?? []).length === 0, `self-approve affected 0 rows${sa.error ? ` (error: ${sa.error.code})` : ''}`);
  const still5 = (await svc.from('org_membership').select('status').eq('user_id', u5).single()).data;
  ok(still5?.status === 'pending', `still pending`);

  // ── 6. non-admin approve filtered; non-admin rotate 42501 ──
  console.log('6. active NON-admin cannot approve or rotate:');
  const na = await cMember.from('org_membership').update({ status: 'active' }).eq('org_id', X).eq('user_id', u5).select();
  ok((na.data ?? []).length === 0, `member's approve affected 0 rows${na.error ? ` (error: ${na.error.code})` : ''}`);
  ok((await svc.from('org_membership').select('status').eq('user_id', u5).single()).data?.status === 'pending', `still pending`);
  const nrot = await cMember.rpc('rotate_org_join_code', { p_org: X });
  ok(!!nrot.error, `member's rotate REJECTED (${nrot.error?.code ?? 'no error!'})`);

  // ── 8. role escalation blocked by the COLUMN GRANT (even for the admin) ──
  console.log('8. role column is not updatable by anyone (column-level grant):');
  const esc = await cAdmin.from('org_membership').update({ role: 'admin' }).eq('org_id', X).eq('user_id', u5).select();
  ok(!!esc.error && esc.error.code === '42501', `role update → 42501 permission denied (got ${esc.error?.code ?? 'no error!'})`);

  // ── 15. approve-only: active→pending demotion is unreachable ──
  console.log('15. active→pending demotion blocked (WITH CHECK pins active):');
  const dem = await cAdmin.from('org_membership').update({ status: 'pending' }).eq('org_id', X).eq('user_id', M.data.user.id).select();
  ok(!!dem.error || (dem.data ?? []).length === 0, `demotion rejected (${dem.error?.code ?? '0 rows'})`);
  ok((await svc.from('org_membership').select('status').eq('user_id', M.data.user.id).single()).data?.status === 'active', `member still active`);

  // ── 9. admin approves → org data appears ──
  console.log('9. admin approves → pending member becomes active with org reach:');
  const ap = await cAdmin.from('org_membership').update({ status: 'active' }).eq('org_id', X).eq('user_id', u5).select();
  ok(!ap.error && (ap.data ?? []).length === 1, `approve affected exactly 1 row`);
  ok((await cPend.from('organizations').select('id')).data?.some((r) => r.id === X) === true, `approved member now sees the org`);
  const w9 = await cPend.from('org_watchlist').insert({ org_id: X, market_id: mkt, added_by: u5 });
  ok(!w9.error, `approved member can curate the org list`);

  // ── 10. admin rejects a second pending user → gone; personal access intact ──
  console.log('10. admin rejects → membership gone, account + personal access intact:');
  const e6 = email('rejected');
  const r6 = await signUpWith(e6, tOrg, 'Rejected Person');
  ok(!r6.error && !!r6.data?.user, `second org-code signup lands pending`);
  const u6 = r6.data?.user?.id;
  if (u6) created.userIds.push(u6);
  const rej = await cAdmin.from('org_membership').delete().eq('org_id', X).eq('user_id', u6).select();
  ok(!rej.error && (rej.data ?? []).length === 1, `reject deleted exactly 1 row`);
  const cRej = await signedIn(e6, u6);
  ok(((await cRej.from('org_membership').select('org_id')).data ?? []).length === 0, `membership gone`);
  const pwRej = await cRej.from('personal_watchlist').insert({ user_id: u6, market_id: mkt });
  ok(!pwRej.error, `rejected user keeps login + personal watchlist`);

  // ── 11. rotation: old code dies instantly, new code works ──
  console.log('11. admin rotation kills the old org code:');
  const rot = await cAdmin.rpc('rotate_org_join_code', { p_org: X });
  ok(!rot.error && typeof rot.data === 'string' && rot.data.length === 16, `rotate RPC returned a new 16-char code`);
  const e7 = email('oldcode');
  const r7 = await signUpWith(e7, tOrg);
  ok(!!r7.error && /invalid invite code/i.test(r7.error.message), `OLD code now rejected "Invalid" (got "${r7.error?.message}")`);
  ok(!(await findUser(e7)), `no auth.users row from the old code`);
  const e7b = email('newcode');
  const r7b = await signUpWith(e7b, rot.data);
  ok(!r7b.error && !!r7b.data?.user, `NEW code works (lands pending)`);
  if (r7b.data?.user?.id) created.userIds.push(r7b.data.user.id);

  // ── 13. allowlist beats a supplied code (priority), code NOT consumed ──
  console.log('13. allowlist priority: allowlisted email + valid code → active, code unconsumed:');
  const tPrio = await mintToken();
  created.inviteCodes.push(tPrio);
  await svc.from('invite_codes').insert({ code: tPrio, note: `gate ${RUN}`, expires_at: new Date(Date.now() + 86_400_000).toISOString() });
  const e8 = email('allowlisted');
  const al8 = await svc.from('allowed_emails').insert({ email: e8.toLowerCase(), org_id: X, role: 'member' });
  if (al8.error) throw new Error(`seed allowlist: ${al8.error.message}`);
  const r8 = await signUpWith(e8, tPrio);
  ok(!r8.error && !!r8.data?.user, `signUp accepted`);
  const u8 = r8.data?.user?.id;
  if (u8) created.userIds.push(u8);
  const m8 = u8 ? (await svc.from('org_membership').select('status').eq('user_id', u8).maybeSingle()).data : null;
  ok(m8?.status === 'active', `membership is ACTIVE (allowlist path, not pending)`);
  const c8 = (await svc.from('invite_codes').select('consumed_at').eq('code', tPrio).single()).data;
  ok(c8?.consumed_at == null, `invite code NOT consumed`);

  // ── 14. expired ORG code → rejected ──
  console.log('14. expired org join code:');
  const tY = await mintToken();
  const insY = await svc.from('org_join_codes').insert({ org_id: Y, code: tY, expires_at: new Date(Date.now() - 3_600_000).toISOString() });
  if (insY.error) throw new Error(`seed org Y code: ${insY.error.message}`);
  const e9 = email('orgexpired');
  const r9 = await signUpWith(e9, tY);
  ok(!!r9.error && /expired/i.test(r9.error.message), `rejected "expired" (got "${r9.error?.message}")`);
  ok(!(await findUser(e9)), `no auth.users row`);
}

let exitCode = 1;
try {
  await run();
  exitCode = failures === 0 ? 0 : 1;
  console.log(`\n${failures === 0
    ? '✓ INVITE FLOWS GATE PASSED — three paths, state machine, and pending isolation hold'
    : `✗ ${failures} invite-flow check(s) FAILED — DO NOT proceed`}\n`);
} catch (err) {
  console.error(`\n✗ gate errored before completing: ${err.message}\n`);
  exitCode = 1;
} finally {
  for (const id of created.userIds) { try { await svc.auth.admin.deleteUser(id); } catch { /* best effort */ } }
  if (created.orgIds.length) await svc.from('organizations').delete().in('id', created.orgIds); // cascades codes/membership/allowlist
  if (created.inviteCodes.length) await svc.from('invite_codes').delete().in('code', created.inviteCodes);
  if (created.markets.length) await svc.from('markets').delete().in('id', created.markets);
  if (created.emails.length) await svc.from('allowed_emails').delete().in('email', created.emails); // belt & braces (org cascade covers most)
}
process.exit(exitCode);
