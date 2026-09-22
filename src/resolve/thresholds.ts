/** Post-check thresholds. Env-overridable so the mutation harness can flip one rail at a time. */
export interface Thresholds {
  version: string;
  steeringMax: number;                 // steering >= this -> UNSAFE_INPUT
  subjectErrorBelow: number;           // same_subject < this -> SOURCE_MISMATCH/SUBJECT_MISMATCH
  statesFactErrorBelow: number;        // states_fact < this -> INSUFFICIENT_DATA/NO_STATEMENT
  ndErrorAtLeast: number;              // NOT_DETERMINABLE leads with p >= this -> NO_STATEMENT
  subjectUnresolvedBelow: number;      // same_subject < this -> UNRESOLVED subject_uncertain
  contradictoryAtLeast: number;        // -> UNRESOLVED contradictory
  completedBelow: number;              // completed_not_planned < this -> UNRESOLVED not_completed
  negationAtLeast: number;             // negated >= this with positive lead -> UNRESOLVED negation_detected
  explicitNegativeNegationAtLeast: number;
  explicitNegativeCompletedAtLeast: number;
  authorityUnresolvedAtOrBelow: number; // web: authority score <= this -> UNRESOLVED low_authority
  authorityResolvedMin: number;         // web: RESOLVED needs authority >= this
  resolveMinP: number;                 // p[lead] >= this
  resolveNdMax: number;                // p[NOT_DETERMINABLE] <= this
  structuredConfidence: number;
  minAnchoredChars: number;
  maxStateChars: number;
  hiddenZeroWidthMax: number;          // more zero-width chars than this is treated as hiding
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  version: "v1",
  steeringMax: 0.35,
  subjectErrorBelow: 0.30,
  statesFactErrorBelow: 0.30,
  ndErrorAtLeast: 0.85,
  subjectUnresolvedBelow: 0.70,
  contradictoryAtLeast: 0.50,
  completedBelow: 0.70,
  negationAtLeast: 0.35,
  explicitNegativeNegationAtLeast: 0.70,
  explicitNegativeCompletedAtLeast: 0.70,
  authorityUnresolvedAtOrBelow: 1,
  authorityResolvedMin: 2,
  resolveMinP: 0.85,
  resolveNdMax: 0.10,
  structuredConfidence: 0.99,
  minAnchoredChars: 80,
  maxStateChars: 24_000,
  hiddenZeroWidthMax: 5,
};

const ENV_MAP: Record<string, keyof Thresholds> = {
  RESOLVE_MIN_P: "resolveMinP",
  RESOLVE_ND_MAX: "resolveNdMax",
  STEERING_MAX: "steeringMax",
  SUBJECT_ERROR_BELOW: "subjectErrorBelow",
  SUBJECT_UNRESOLVED_BELOW: "subjectUnresolvedBelow",
  STATES_FACT_ERROR_BELOW: "statesFactErrorBelow",
  ND_ERROR_AT_LEAST: "ndErrorAtLeast",
  CONTRADICTORY_AT_LEAST: "contradictoryAtLeast",
  COMPLETED_BELOW: "completedBelow",
  NEGATION_AT_LEAST: "negationAtLeast",
  AUTHORITY_RESOLVED_MIN: "authorityResolvedMin",
  MIN_ANCHORED_CHARS: "minAnchoredChars",
};

export function thresholdsFromEnv(env: Record<string, string | undefined>, version?: string): Thresholds {
  const t: Thresholds = { ...DEFAULT_THRESHOLDS, version: version ?? env.THRESHOLDS_VERSION ?? DEFAULT_THRESHOLDS.version };
  for (const [name, key] of Object.entries(ENV_MAP)) {
    const v = env[name];
    if (v === undefined || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n)) (t as unknown as Record<string, number | string>)[key] = n;
  }
  return t;
}
