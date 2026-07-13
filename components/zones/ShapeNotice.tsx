// components/zones/ShapeNotice.tsx — the shared HONEST-SHAPE notice (5.6 guard + 5.5
// 'unsupported'). One primitive for every "this board is not what the standard model
// assumes" statement: a hairline-ruled LEDGER band, mono micro label + plain-prose why.
// It exists so honesty about a market's structure renders consistently everywhere —
// never as an apologetic tooltip, never buried below the fold.
export function ShapeNotice({ label, children, field = 'shape-notice' }: {
  label: string; children: React.ReactNode; field?: string;
}) {
  return (
    <div className="shape-notice" data-field={field} role="note">
      <span className="shape-notice-tag label">{label}</span>
      <span className="shape-notice-body">{children}</span>
    </div>
  );
}
