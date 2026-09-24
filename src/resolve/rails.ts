/**
 * Deterministic rails that the mutation harness can switch off ONE AT A TIME,
 * in-process only. There is deliberately no env var for this: production code
 * never calls the setter, so a stray variable can never disarm a rail.
 */
const rails = {
  injection_markers: true,
  source_match: true,
  anchors: true,
  time_window: true,
  language: true,
  coverage_proof: true,
  structured_router: true,
  after_deadline_positive: true,
  // Ingestion rails (src/ingest). Off = the pre-P1a behaviour, so the mutation harness can prove
  // evals/ingest.ts catches its absence.
  /** github/web: a non-200 answer or a moved resource is a coverage gap, never evidence. */
  non200_never_evidence: true,
  /** watch: change detection hashes the projection of deciding fields, not raw bytes. */
  stable_projection: true,
  // official_release rails (src/resolve/official.ts). Off = the failure each one exists for; evals/official.ts proves it.
  /** gate 1: no verdict from an observation made before release_at, or one whose deciding text names another period. */
  official_release_gate: true,
  /** the stored first print decides; a later (revised) read of the same period never replaces it. */
  first_print_lock: true,
  // Registration rail (src/markets/policy.ts, src/markets/source-checks.ts, src/ingest/robots.ts). Off = the pre-P1a
  // behaviour; evals/registration.ts proves it.
  /**
   * A watch-creating registration names only whitelisted, well-formed refs per kind, agrees with its resolver, fetches
   * only public https hosts, reads a Solana account that exists and is not a program, and treats a robots.txt it could
   * not read as a disallow.
   */
  registration_policy: true,
};
export type Rail = keyof typeof rails;
export function railEnabled(r: Rail): boolean { return rails[r]; }
export function __setRailsForMutationTesting(off: Rail[]): void {
  for (const k of Object.keys(rails) as Rail[]) rails[k] = !off.includes(k);
}
export function __allRails(): Rail[] { return Object.keys(rails) as Rail[]; }
