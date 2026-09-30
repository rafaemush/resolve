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

/** Workers Free: subrequests per invocation. Each cron trigger is its own invocation (src/jobs/schedule.ts). */
export const INVOCATION_SUBREQUESTS = 50;
/** Every scheduled invocation keeps one alert back for a job that throws (src/jobs/schedule.ts). */
export const EXCEPTION_RESERVE = COST.alert;
/** The 10-minute dispatch check: the pg_net failure count and the storage status (two RPCs) and one alertMany (src/jobs/dispatch.ts). */
export const DISPATCH_CHECK_SUBREQUESTS = 2 * COST.db + COST.alert;

/**
 * A reservation failed: the job stops where it is and the rest runs next invocation. Never a failure of the operation
 * it guarded, so callers tell it apart from one (a deposit that could not be credited is not the scan running out).
 */
export class BudgetExhausted extends Error {
  constructor(what: string) { super(`subrequest budget exhausted before ${what}`); this.name = "BudgetExhausted"; }
}

export class Budget {
  private spent = 0;
  constructor(readonly limit: number) {}
  /** Reserve n subrequests; false (and nothing reserved) when that would exceed the limit. */
  take(n: number): boolean {
    if (this.spent + n > this.limit) return false;
    this.spent += n;
    return true;
  }
  /** take(), or throw BudgetExhausted naming the operation, for code that stops by unwinding. */
  need(n: number, what: string): void { if (!this.take(n)) throw new BudgetExhausted(what); }
  /** Give back part of a reservation the operation turned out not to need (an alert that was never raised). */
  release(n: number): void { this.spent = Math.max(0, this.spent - n); }
  get left(): number { return this.limit - this.spent; }
  get used(): number { return this.spent; }
}
