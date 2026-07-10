// scripts/operator-env.mjs — target resolution for the operator MINT scripts
// (create-invite-code / create-org-code). Exists so a minted code can never carry
// a link pointing at the WRONG environment: the resolver both prints the target
// (project ref + env label) and refuses the two clear mismatch signatures
// (--prod with a localhost link; dev with a non-localhost link).
//
// Two targets:
//   default  → dev, from the shell env (same pattern as every verify script):
//              SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, link base from
//              PUBLIC_APP_URL (default http://localhost:3000).
//   --prod   → reads .env.prod (gitignored; operator-created, never committed):
//              PROD_SUPABASE_URL, PROD_SUPABASE_SERVICE_ROLE_KEY,
//              PROD_PUBLIC_APP_URL (all three required — fail loudly otherwise).

import { readFileSync, existsSync } from 'node:fs';

/** Minimal KEY=VALUE parser (comments/blank lines skipped, optional `export `/quotes). */
function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.replace(/^export\s+/, '').match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

const die = (msg) => { console.error(msg); process.exit(2); };

/**
 * Resolve which Supabase project this mint targets + the public link base.
 * Returns { rest, url, serviceKey, appUrl, banner } — `rest` is argv minus --prod.
 */
export function resolveTarget(argv) {
  const prod = argv.includes('--prod');
  const rest = argv.filter((a) => a !== '--prod');
  let url, serviceKey, appUrl, label;

  if (prod) {
    if (!existsSync('.env.prod')) {
      die('--prod: no .env.prod found (run from the repo root). Create it (gitignored) with:\n'
        + '  PROD_SUPABASE_URL=https://<prod-ref>.supabase.co\n'
        + '  PROD_SUPABASE_SERVICE_ROLE_KEY=<prod service-role key>\n'
        + '  PROD_PUBLIC_APP_URL=https://<your deployed app domain>');
    }
    const env = parseEnvFile(readFileSync('.env.prod', 'utf8'));
    url = env.PROD_SUPABASE_URL; serviceKey = env.PROD_SUPABASE_SERVICE_ROLE_KEY;
    appUrl = env.PROD_PUBLIC_APP_URL;
    const missing = ['PROD_SUPABASE_URL', 'PROD_SUPABASE_SERVICE_ROLE_KEY', 'PROD_PUBLIC_APP_URL']
      .filter((k) => !env[k]);
    if (missing.length) die(`--prod: .env.prod is missing: ${missing.join(', ')}`);
    label = 'PROD (.env.prod)';
  } else {
    url = process.env.SUPABASE_URL; serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    appUrl = process.env.PUBLIC_APP_URL || 'http://localhost:3000';
    if (!url || !serviceKey) {
      die('Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the shell (dev), or use --prod with .env.prod.');
    }
    label = 'DEV (shell env)';
  }

  appUrl = appUrl.replace(/\/$/, '');
  const isLocalLink = /^https?:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(appUrl);
  // mismatch guard: a code is only as good as the link it ships in
  if (prod && isLocalLink) {
    die(`refusing: --prod would print a LOCALHOST link (${appUrl}) — set PROD_PUBLIC_APP_URL in .env.prod.`);
  }
  if (!prod && !isLocalLink) {
    die(`refusing: dev-targeted mint would print a NON-localhost link (${appUrl}) — a code minted on `
      + `dev is useless at that domain. Use --prod for prod, or unset PUBLIC_APP_URL for local links.`);
  }

  let ref;
  try { ref = new URL(url).hostname.split('.')[0]; }
  catch { die(`invalid Supabase URL for this target: "${url}"`); }
  return { rest, url, serviceKey, appUrl, banner: `Target: ${label} · project ${ref} · links → ${appUrl}` };
}
