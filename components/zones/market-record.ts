// components/zones/market-record.ts — TypeScript shapes for the /api/market record
// the detail view consumes. The record is produced by the verified core/ pipeline
// (untyped .mjs), so these interfaces type the boundary the detail reads — all fields
// optional where the detail must degrade gracefully on a thin record (no `any`).

export interface LadderRow {
  label: string;
  threshold: number;
  prob: number;
  adjusted_prob: number;
  bucket_prob: number;
  raw_prob?: number;
  volume?: number;
  volume_tier?: string;
}

export type Tier = 'high' | 'medium' | 'low';

export interface ConfidenceDimension {
  tier?: Tier;
  score?: number;
  reasons?: string[];
}

// Two INDEPENDENT trust dimensions (the conceptual split): reliability = is the displayed number
// trustworthy; liquidity = can you transact at this price. See migration 0010 / methodology 1.5.0.
export interface Confidence {
  reliability?: ConfidenceDimension;
  liquidity?: ConfidenceDimension;
}

export interface Range {
  central?: number;
  low?: number;
  high?: number;
  tail_insensitive?: boolean;
}

export interface Analytics {
  shape?: { skew_bowley?: number; entropy?: number; fat_tail?: number; dominant_bucket?: { label?: string } };
  dispersion?: { trend?: string; iqr_width?: number };
  velocity?: { acceleration?: string; drift_30d_annualized?: number };
  descriptor?: string;
}

export interface TouchPoint {
  level: number; // in the ladder's derived unit (mantissa)
  prob: number; // HIGH: P(touch ≥ level); LOW: P(touch ≤ level)
  volume?: number;
}

export interface ImpliedRange {
  low?: number | null;
  high?: number | null;
  confidence?: number; // e.g. 0.5
  low_label?: string; // display string incl. honest "< $X" outside-ladder cases
  high_label?: string;
  unit?: string;
}

export interface CategoricalOutcome {
  label: string;
  probability: number; // normalized (de-vigged) — sums to ~1 across outcomes
  raw_probability?: number | null; // observed YES midpoint, pre-normalization
  volume?: number | null;
  midpoint_source?: string | null;
}

export interface Derived {
  kind?: 'binary' | 'threshold_ladder' | 'directional_touch' | 'categorical';
  probability?: number; // binary: YES midpoint (the headline)
  probability_no?: number | null;
  // categorical fields
  outcomes?: CategoricalOutcome[];
  dominant_outcome?: string | null;
  dominant_prob?: number;
  entropy?: number;
  consensus_strength?: 'HIGH' | 'MEDIUM' | 'LOW';
  implied_winner?: string | null;
  // 5.6 exclusivity guard — present ONLY on guarded (non-exclusive) categorical records;
  // when present, dominant_*/entropy/consensus_strength/implied_winner are suppressed.
  exclusivity?: {
    verdict: 'nested_deadline' | 'non_exclusive' | 'ambiguous';
    basis?: { filtered_sum?: number; real_legs?: number; dated_fraction?: number; text_monotone?: boolean; end_date_monotone?: boolean };
    headline?: { label: string; raw_probability: number | null };
  };
  implied_median?: number;
  implied_mean?: number;
  median?: Range;
  mean?: Range;
  iqr?: { p25?: number; p75?: number };
  total_volume?: number;
  confidence?: Confidence;
  markets?: LadderRow[];
  market?: { analytics?: Analytics };
  freshness?: { as_of?: string; stale_after?: string; final?: boolean };
  narrative?: string;
  // directional-touch fields
  implied_range?: ImpliedRange;
  high_series?: TouchPoint[];
  low_series?: TouchPoint[];
  unit?: string;
  near_settlement?: boolean; // expiring soon + rungs mostly pinned → amber NEAR SETTLEMENT badge
  // Increment 1: windowed volume (supplementary — never hashed). Omitted on records computed
  // before the feature; by_threshold keyed by derived ladder rung for the table's 24h column.
  liquidity?: { volume_24hr?: number | null; volume_1wk?: number | null; volume_all?: number | null; by_threshold?: Record<string, number> };
}

export interface ResolvedLeg {
  threshold: number;
  outcome: string;
}

// Phase 3: per-threshold P(>X) change over the daily history series (deriveDeltas), and the
// top thresholds by 30d movement (deriveBiggestMoves). Each horizon is null when the series
// has no matching day — never a fabricated 0.
export interface ThresholdDelta {
  threshold: number;
  d1: number | null;
  d7: number | null;
  d30: number | null;
}

export interface Mover {
  threshold: number;
  start: number | null;
  end: number | null;
  change: number | null;
  direction: 'up' | 'down' | 'flat';
}

export interface BiggestMoves {
  kind: string | null;
  movers?: Mover[];
  period?: string;
}

export interface Snapshot {
  fetched_at?: string;
  source?: { raw_sha256?: string };
  raw_inputs?: unknown[];
  derived?: Derived;
  lifecycle?: { state?: string; resolved_outcome?: ResolvedLeg[]; as_of?: string };
}

export interface MarketRecord {
  schema_version?: string;
  methodology_version?: string;
  asset?: { id?: string; name?: string; platform?: string; market_url?: string; resolves?: string };
  snapshot?: Snapshot;
}

export interface ServeBody {
  market_id?: string;
  cached?: boolean;
  age_seconds?: number;
  lifecycle_state?: string;
  record?: MarketRecord;
  error?: string;
}
