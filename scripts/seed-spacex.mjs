// scripts/seed-spacex.mjs — seed the cache with SpaceX's frozen RESOLVED record.
//
// SpaceX resolved (cap landed in $2.0–2.2T); its final record is frozen in
// docs/api/v1/latest.json. The serverless function never live-pulls a resolved
// market, so we seed its final record once; thereafter GET /api/market?id=
// spacex-ipo-closing-market-cap-above serves it from cache as RESOLVED, forever.
//
// Run once after applying the migration, with the service-role creds in env:
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/seed-spacex.mjs
// (Idempotent: re-running REPLACES the stored row with the canonical latest.json
// record — a frozen record's fetched_at never changes, so a plain conflict-ignoring
// upsert would silently keep a stale-schema row in place.)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadMarketConfig } from '../core/market-config.js';
import { writeRecord } from '../lib/cache.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const record = JSON.parse(readFileSync(join(__dirname, '../docs/api/v1/latest.json'), 'utf8'));
const config = loadMarketConfig('spacex');

const lifecycle = record.snapshot.lifecycle;
if (!lifecycle || lifecycle.state !== 'RESOLVED') {
  console.error('Refusing to seed: docs/api/v1/latest.json is not a RESOLVED record.');
  process.exit(1);
}

// markets.id is the public event slug the function is queried with.
const marketId = config.event_slug; // 'spacex-ipo-closing-market-cap-above'
await writeRecord(marketId, record, lifecycle, config, { replace: true });
console.log(`✓ seeded ${marketId} as RESOLVED (raw_sha256 ${record.snapshot.source.raw_sha256.slice(0, 16)}…)`);
