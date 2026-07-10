// test/signup-errors.test.js — table-driven proof of lib/signup-errors.mjs's mapping,
// including the ordering hazard: code-specific branches must win over the generic
// invite-only regex even though the generic pattern also matches on "invite".
// Run: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mapSignupError } from '../lib/signup-errors.mjs';

const ALREADY_USED =
  'This invite code has already been used — codes are single-use. Ask for a new one.';
const EXPIRED = 'This invite code has expired — ask for a new one.';
const INVALID = 'Invalid invite code — check for typos, or ask for a new one.';
const GENERIC =
  'This email isn’t on the invite list. Access is invite-only — contact your administrator.';

const cases = [
  // exact hook messages (migration 0012-0014, hook_restrict_signup_to_allowlist)
  ['exact hook message: already used', 'This invite code has already been used.', ALREADY_USED],
  ['exact hook message: expired', 'This invite code has expired — ask for a new one.', EXPIRED],
  ['exact hook message: invalid', 'Invalid invite code.', INVALID],
  [
    'exact hook message: generic invite-only',
    'Access is invite-only — ask your administrator to add your email.',
    GENERIC,
  ],
  // case-insensitivity of each pattern
  ['already-used branch is case-insensitive', 'THIS INVITE CODE HAS ALREADY BEEN USED.', ALREADY_USED],
  ['expired branch is case-insensitive', 'this invite CODE HAS EXPIRED, sorry.', EXPIRED],
  ['invalid branch is case-insensitive', 'invalid INVITE code supplied.', INVALID],
  // generic-pattern variants (invite/allow/not permitted/403/denied)
  ['generic branch: not permitted', 'Request denied: not permitted', GENERIC],
  ['generic branch: 403', 'Error 403: forbidden', GENERIC],
  // ordering hazard: message contains "invite" AND the expired phrase — must hit the
  // expired branch, not fall into the generic invite-only regex (both match "invite").
  [
    'ordering hazard: invite + code has expired hits expired branch, not generic',
    'Sorry, your invite code has expired — try again.',
    EXPIRED,
  ],
  // ordering hazard: message contains "invite" AND the already-used phrase.
  [
    'ordering hazard: invite + already been used hits already-used branch, not generic',
    'Heads up: this invite code has already been used by someone else.',
    ALREADY_USED,
  ],
  // unknown message passes through verbatim
  [
    'unknown message passes through unchanged',
    'Password should be at least 8 characters',
    'Password should be at least 8 characters',
  ],
];

for (const [name, input, expected] of cases) {
  test(name, () => {
    assert.equal(mapSignupError(input), expected);
  });
}
