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
};
export type Rail = keyof typeof rails;
export function railEnabled(r: Rail): boolean { return rails[r]; }
export function __setRailsForMutationTesting(off: Rail[]): void {
  for (const k of Object.keys(rails) as Rail[]) rails[k] = !off.includes(k);
}
export function __allRails(): Rail[] { return Object.keys(rails) as Rail[]; }
