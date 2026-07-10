// lib/signup-errors.mjs — maps the Before-User-Created hook's (migration 0012-0014)
// rejection messages to human-readable signup form copy. CLIENT-SAFE, zero imports.
//
// ORDER MATTERS: the code-specific patterns (already-used / expired / invalid) must be
// tested BEFORE the generic invite-only regex, because that regex matches on the word
// "invite" — and "This invite code has expired" / "Invalid invite code" both contain
// "invite" too. Testing the generic pattern first would swallow the specific messages
// and produce the wrong, less-actionable copy. Any message this module doesn't
// recognize (e.g. a GoTrue password-policy error) passes through verbatim.

/** @param {string} message @returns {string} */
export function mapSignupError(message) {
  if (/already been used/i.test(message)) {
    return 'This invite code has already been used — codes are single-use. Ask for a new one.';
  }
  if (/code has expired/i.test(message)) {
    return 'This invite code has expired — ask for a new one.';
  }
  if (/invalid invite code/i.test(message)) {
    return 'Invalid invite code — check for typos, or ask for a new one.';
  }
  if (/invite|allow|not permitted|403|denied/i.test(message)) {
    return 'This email isn’t on the invite list. Access is invite-only — contact your administrator.';
  }
  return message;
}
