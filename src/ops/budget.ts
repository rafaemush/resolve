/**
 * Subrequest accounting for one Worker invocation. Workers Free allows 50 subrequests per invocation and a job that
 * throws mid-loop leaves half-written state (plan §16.2), so every job that fans out reserves the worst case of an
 * operation before starting it and stops cleanly when the reservation fails; the rest runs next invocation.
 */

/** Worst-case subrequests per operation. A Telegram send retries up to 3 attempts (src/bot/telegram.ts). */
export const COST = {
  db: 1,
  http: 1,
  telegram: 3,
  /** alert(): dedup read + insert + operator DM (a Telegram send). */
  alert: 5,
} as const;

export class Budget {
  private spent = 0;
  constructor(readonly limit: number) {}
  /** Reserve n subrequests; false (and nothing reserved) when that would exceed the limit. */
  take(n: number): boolean {
    if (this.spent + n > this.limit) return false;
    this.spent += n;
    return true;
  }
  get left(): number { return this.limit - this.spent; }
  get used(): number { return this.spent; }
}
