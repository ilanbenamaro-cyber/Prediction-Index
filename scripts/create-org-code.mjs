// scripts/create-org-code.mjs — OPERATOR TOOL: create or ROTATE an org's join
// code (redeemers get an account + PENDING membership awaiting admin approval).
//
// One active code per org (org_join_codes PK = org_id): running this against an
// org that already has a code REPLACES it — the previous code stops working the
// instant the upsert lands. Uses the same canonical server-side generator as the
// admin-facing rotate_org_join_code RPC; this script upserts directly under
// service-role because the RPC's is_org_admin gate (correctly) rejects callers
// with no auth.uid(). Codes print to interactive stdout only — never into
// structured logs (design §9).
//
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
//   node scripts/create-org-code.mjs --org <uuid|exact name> [--days N]
//
//   --org   the organization, by uuid or exact name (lists orgs when not found)
//   --days  optional expiry in days from now (default: no expiry — product default)
//
// Exit: 0 created/rotated · 1 error · 2 not run (missing creds / bad args / org not found).

import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
if (!URL || !SERVICE) {
  console.error('Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(2);
}

/** Parse --org / --days from argv; reject unknown flags (fail closed on typos). */
function parseArgs(argv) {
  const out = { org: null, days: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--org') {
      out.org = argv[++i] ?? null;
      if (out.org == null) { console.error('--org requires a value'); process.exit(2); }
    } else if (argv[i] === '--days') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) { console.error('--days must be a positive integer'); process.exit(2); }
      out.days = n;
    } else {
      console.error(`unknown argument: ${argv[i]}\nusage: node scripts/create-org-code.mjs --org <uuid|name> [--days N]`);
      process.exit(2);
    }
  }
  if (!out.org) { console.error('--org is required'); process.exit(2); }
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Display form: XXXX-XXXX-XXXX-XXXX (canonical stored form is dashless). */
const dashed = (code) => code.replace(/(.{4})(?=.)/g, '$1-');

const { org: orgArg, days } = parseArgs(process.argv.slice(2));
const svc = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

try {
  // resolve the org by uuid or exact name; on miss, list what exists (operator context)
  const q = UUID_RE.test(orgArg)
    ? svc.from('organizations').select('id, name').eq('id', orgArg)
    : svc.from('organizations').select('id, name').eq('name', orgArg);
  const { data: orgs, error: orgErr } = await q;
  if (orgErr) throw new Error(`organizations lookup: ${orgErr.message}`);
  if (!orgs || orgs.length !== 1) {
    const all = await svc.from('organizations').select('id, name').order('name');
    console.error(orgs && orgs.length > 1
      ? `"${orgArg}" matches ${orgs.length} orgs — use the uuid.`
      : `org "${orgArg}" not found. Organizations:`);
    for (const o of all.data ?? []) console.error(`  ${o.id}  ${o.name}`);
    process.exit(2);
  }
  const org = orgs[0];

  const existing = await svc.from('org_join_codes').select('org_id').eq('org_id', org.id).maybeSingle();
  if (existing.error) throw new Error(`org_join_codes lookup: ${existing.error.message}`);

  const gen = await svc.rpc('new_invite_token');
  if (gen.error || typeof gen.data !== 'string' || gen.data.length !== 16) {
    throw new Error(`new_invite_token rpc: ${gen.error?.message ?? `unexpected result "${gen.data}"`}`);
  }
  const code = gen.data;
  const expiresAt = days == null ? null : new Date(Date.now() + days * 86_400_000).toISOString();
  const up = await svc.from('org_join_codes').upsert(
    { org_id: org.id, code, expires_at: expiresAt, rotated_at: new Date().toISOString(), rotated_by: null },
    { onConflict: 'org_id' },
  );
  if (up.error) throw new Error(`upsert org_join_codes: ${up.error.message}`);

  console.log(`\nJoin code for "${org.name}" ${existing.data ? 'ROTATED — the previous code is now dead' : 'created'}`
    + ` (${expiresAt ? `expires ${expiresAt}` : 'no expiry'}):\n`);
  console.log(`  ${dashed(code)}`);
  console.log(`  ${APP_URL}/signup?code=${dashed(code)}\n`);
  console.log('Redeemers land as PENDING members — an org admin approves them in the app.\n');
  process.exit(0);
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(1);
}
