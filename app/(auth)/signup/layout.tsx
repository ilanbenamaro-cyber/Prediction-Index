// app/(auth)/signup/layout.tsx — the signup URL can carry ?code= (a long-lived secret
// for org join codes). no-referrer guarantees that param never rides a Referer header
// off-origin (Opus F3), even before the client-side history.replaceState strip runs.
import type { Metadata } from 'next';

export const metadata: Metadata = { referrer: 'no-referrer' };

export default function SignupLayout({ children }: { children: React.ReactNode }) {
  return children;
}
