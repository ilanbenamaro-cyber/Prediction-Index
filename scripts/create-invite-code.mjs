// scripts/create-invite-code.mjs — OPERATOR TOOL: mint a single-use invite code
// (solo access: the redeemer gets an account + personal watchlist, NO org).
//
// The code is generated SERVER-SIDE by public.new_invite_token() (the one
// canonical generator — 16 chars, ~79 bits, no 0/O/1/I/L; execute is
// service-role-only) and inserted into public.invite_codes, which is
// RLS-client-deny. Codes are printed to interactive stdout ONLY — never write
// them into structured logs (design §9).
//
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
//   node scripts/create-invite-code.mjs [--days 7] [--note "for whom"]
//
//   --days  expiry in days from now (default 7; must be a positive integer)
//   --note  operator annotation stored on the row (who this invite is for)
//
// Exit: 0 minted · 1 error · 2 not run (missing creds / bad args).

import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
if (!URL || !SERVICE) {
  console.error('Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(2);
}

/** Parse --days / --note from argv; reject unknown flags (fail closed on typos). */
function parseArgs(argv) {
  const out = { days: 7, note: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--days') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) { console.error('--days must be a positive integer'); process.exit(2); }
      out.days = n;
    } else if (argv[i] === '--note') {
      out.note = argv[++i] ?? null;
      if (out.note == null) { console.error('--note requires a value'); process.exit(2); }
    } else {
      console.error(`unknown argument: ${argv[i]}\nusage: node scripts/create-invite-code.mjs [--days 7] [--note "for whom"]`);
      process.exit(2);
    }
  }
  return out;
}

/** Display form: XXXX-XXXX-XXXX-XXXX (canonical stored form is dashless). */
const dashed = (code) => code.replace(/(.{4})(?=.)/g, '$1-');

const { days, note } = parseArgs(process.argv.slice(2));
const svc = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

try {
  const gen = await svc.rpc('new_invite_token');
  if (gen.error || typeof gen.data !== 'string' || gen.data.length !== 16) {
    throw new Error(`new_invite_token rpc: ${gen.error?.message ?? `unexpected result "${gen.data}"`}`);
  }
  const code = gen.data;
  const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
  const ins = await svc.from('invite_codes').insert({ code, note, expires_at: expiresAt });
  if (ins.error) throw new Error(`insert invite_codes: ${ins.error.message}`);

  console.log(`\nSingle-use invite code minted (expires ${expiresAt}${note ? `, note: ${note}` : ''}):\n`);
  console.log(`  ${dashed(code)}`);
  console.log(`  ${APP_URL}/signup?code=${dashed(code)}\n`);
  process.exit(0);
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(1);
}
