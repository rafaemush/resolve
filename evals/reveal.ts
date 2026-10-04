/**
 * The priced reveal rails (src/shadow/reveal.ts; rails reveal_charge and reveal_lock): authored cases graded by equality
 * on what each follower receives (the verdict or a locked reveal) and on the ledger the release leaves, through the
 * Worker's own path: revealEntitlements() over an in-memory database whose charge_reveals() is the stand-in of migration
 * 023 (tests/lib/fake-rpcs.ts, step for step in the SQL's order), then revealItems() (the shadow.committed each follower
 * is queued) or shapeShadow() (GET /v1/shadow/:market_id). No network, no credentials.
 *   npx tsx evals/reveal.ts     run the cases (exit 1 on any failure)
 * Groups: lock (a reveal whose charge was refused must be locked), charge (a RESOLVED verdict released to a paying
 * follower must leave exactly its ledger charge). evals/mutate.ts switches each rail off and requires its group to go red
 * while the same group with every rail on stays green; the control cases (an included plan, a verdict that is not
 * RESOLVED, a grandfathered key, a paid reveal for the lock group) come out the same either way.
 */
import type { Db } from "../src/db/supabase";
import type { Env } from "../src/env";
import type { MarketRow } from "../src/ingest/types";
import { revealItems } from "../src/shadow/events";
import { shapeShadow, type ShadowCommitRow } from "../src/shadow/follows";
import { lockedReveal, revealAccess, revealEntitlements, revealRequestId, type RevealPair } from "../src/shadow/reveal";
import { topUp } from "../src/billing/top-up";
import { fakeDb, type Row } from "../tests/lib/fake-db";
import { chargeReveals } from "../tests/lib/fake-rpcs";

export type RevealGroup = "lock" | "charge";
type Status = "RESOLVED" | "UNRESOLVED";
interface Follower { id: string; plan: "free" | "payg" | "builder" | "growth" | "platform"; balance: number; created_at?: string }
export interface RevealCase {
  id: string; group: RevealGroup; control: boolean; title: string;
  followers: Follower[]; legs?: number; status?: Status; commits?: number; via?: "webhook" | "read"; billingDown?: boolean;
  /** Per follower: released (the verdict reached it), and its charge rows and their sum after every commit. */
  expect: Record<string, { released: boolean; charges: number; sum: number }>;
}
interface Outcome { id: string; group: RevealGroup; control: boolean; result: "pass" | "grader_fail" | "harness_error"; failures: string[] }
export interface RevealSummary { cases: number; passed: number; grader_fail: number; harness_error: number; skipped: number; outcomes: Outcome[]; label?: string }

const ENV = { RESOLVE_PUBLIC_URL: "https://resolve.example.com", WHOP_CHECKOUT_ENABLED: "1", WHOP_API_KEY: "k", WHOP_PLAN_ID_20: "plan_c", WHOP_PLAN_ID_50: "plan_a", WHOP_PLAN_ID_250: "plan_b" } as unknown as Env;
const EVENT = "polymarket:event:60182";
const leg = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const committed = (s: Status) => ({
  preimage_version: "v2", preimage: "p|nonce", resolution_status: s, winning_outcome: s === "RESOLVED" ? "OPTION_A" : "NONE", confidence_score: 0.95,
  caveats: s === "RESOLVED" ? [] : ["no_anchor"], canonical_sha256: "c".repeat(64), raw_sha256: "d".repeat(64), thresholds_version: "v1", determination_basis: "structured",
});
const AFTER_CUTOVER = "2026-10-20T00:00:00.000Z";

const CASES: RevealCase[] = [
  // --- lock: controls come out the same with the rail on or off -----------------------------------------------------------
  { id: "RL-001", group: "lock", control: true, title: "an included plan gets the verdict, free", followers: [{ id: "t_b", plan: "builder", balance: 0 }], expect: { t_b: { released: true, charges: 0, sum: 0 } } },
  { id: "RL-002", group: "lock", control: true, title: "a paying follower with credits gets the verdict and its one charge", followers: [{ id: "t_p", plan: "payg", balance: 100 }], expect: { t_p: { released: true, charges: 1, sum: 25 } } },
  // --- lock: red when a refused reveal goes out anyway ---------------------------------------------------------------------
  { id: "RL-101", group: "lock", control: false, title: "a short balance (10 of 25) is locked, nothing charged", followers: [{ id: "t_s", plan: "payg", balance: 10 }], expect: { t_s: { released: false, charges: 0, sum: 0 } } },
  { id: "RL-102", group: "lock", control: false, title: "billing unavailable locks a paying follower (never released free)", followers: [{ id: "t_p", plan: "payg", balance: 100 }], billingDown: true, expect: { t_p: { released: false, charges: 0, sum: 0 } } },
  { id: "RL-103", group: "lock", control: false, title: "GET /v1/shadow at a short balance reads the RESOLVED commit locked", followers: [{ id: "t_s", plan: "free", balance: 0, created_at: AFTER_CUTOVER }], via: "read", expect: { t_s: { released: false, charges: 0, sum: 0 } } },
  // --- charge: controls ----------------------------------------------------------------------------------------------------
  { id: "RC-001", group: "charge", control: true, title: "an included plan is never charged", followers: [{ id: "t_g", plan: "growth", balance: 0 }], expect: { t_g: { released: true, charges: 0, sum: 0 } } },
  { id: "RC-002", group: "charge", control: true, title: "a verdict that is not RESOLVED is revealed free", followers: [{ id: "t_p", plan: "payg", balance: 100 }], status: "UNRESOLVED", expect: { t_p: { released: true, charges: 0, sum: 0 } } },
  { id: "RC-003", group: "charge", control: true, title: "an evaluation key issued before the cut-over is grandfathered", followers: [{ id: "t_o", plan: "free", balance: 300, created_at: "2026-09-01T00:00:00.000Z" }], expect: { t_o: { released: true, charges: 0, sum: 0 } } },
  // --- charge: red when a paid reveal is released without its charge -------------------------------------------------------
  { id: "RC-101", group: "charge", control: false, title: "a paying follower's RESOLVED reveal leaves exactly one charge of 25", followers: [{ id: "t_p", plan: "payg", balance: 100 }], expect: { t_p: { released: true, charges: 1, sum: 25 } } },
  { id: "RC-102", group: "charge", control: false, title: "an evaluation key after the cut-over pays too; a second commit is a replay, still one charge", followers: [{ id: "t_n", plan: "free", balance: 300, created_at: AFTER_CUTOVER }], commits: 2, expect: { t_n: { released: true, charges: 1, sum: 25 } } },
  { id: "RC-103", group: "charge", control: false, title: "a short balance gets no verdict", followers: [{ id: "t_s", plan: "payg", balance: 5 }], expect: { t_s: { released: false, charges: 0, sum: 0 } } },
  { id: "RC-104", group: "charge", control: false, title: "81 legs of one event: 80 charges of 25 (2,000, the cap), every leg released", followers: [{ id: "t_p", plan: "payg", balance: 5000 }], legs: 81, via: "read", expect: { t_p: { released: true, charges: 80, sum: 2000 } } },
];

async function runCase(k: RevealCase): Promise<string[]> {
  const legs = Array.from({ length: k.legs ?? 1 }, (_, i) => leg(i + 1));
  const markets: Row[] = legs.map((id, i) => ({ id, tenant_id: null, is_test: false, platform: "polymarket", external_id: `leg-${i}`, option_a: "Yes", option_b: "No", meta: { slug: `leg-${i}`, event_id: "60182" }, event_key: EVENT, status: "open", deleted_at: null }));
  const db = fakeDb({
    tenants: k.followers.map((f) => ({ id: f.id, plan: f.plan, credits_balance: f.balance, created_at: f.created_at ?? AFTER_CUTOVER, deleted_at: null, low_credit_notified_at: null })),
    markets, credit_ledger: [],
  }, {}, { rpc: { charge_reveals: k.billingDown ? async () => ({ data: null, error: { code: "57014", message: "statement timeout" } }) : chargeReveals } });
  const client = db.client as unknown as Db;
  const top = topUp(ENV, "https://resolve.example.com");
  const status = k.status ?? "RESOLVED";
  const released = new Map<string, boolean>();
  for (let n = 0; n < (k.commits ?? 1); n++) {
    for (const m of markets) {
      const pairs: RevealPair[] = k.followers.map((f) => ({ tenant_id: f.id, market_id: String(m.id), plan: f.plan }));
      const { answers } = await revealEntitlements(client, pairs, { resolved: status === "RESOLVED", source: k.via ?? "webhook" });
      const commit = { commitment_sha256: "e".repeat(64), committed_at: AFTER_CUTOVER, committed: committed(status) };
      for (const a of answers) {
        let got: boolean;
        if ((k.via ?? "webhook") === "webhook") {
          const [item] = revealItems(m as unknown as MarketRow, commit as never, [a], top);
          got = (item!.payload as { verdict: unknown }).verdict !== null;
        } else {
          const row: ShadowCommitRow = { id: "c1", commitment_sha256: "e".repeat(64), created_at: AFTER_CUTOVER, channel: "telegram", telegram_date: AFTER_CUTOVER, payload: { committed: committed(status) } };
          const shaped = shapeShadow({ id: String(m.id), platform: "polymarket", external_id: String(m.external_id), status: "open", deadline_utc: AFTER_CUTOVER } as never, [row], { access: revealAccess(a), locked: lockedReveal(a, top, String(m.id)) });
          got = (shaped.latest as { verdict: unknown }).verdict !== null;
        }
        // a follower counts as released when every leg reached it
        released.set(a.tenant_id, (released.get(a.tenant_id) ?? true) && got);
      }
    }
  }
  const failures: string[] = [];
  for (const [t, want] of Object.entries(k.expect)) {
    const charges = (db.tables.credit_ledger ?? []).filter((l) => l.reason === "charge" && l.tenant_id === t && String(l.request_id).startsWith(`reveal:${t}:`) && legs.some((m) => l.request_id === revealRequestId(t, m)));
    const sum = charges.reduce((s, l) => s - Number(l.delta), 0);
    if (released.get(t) !== want.released) failures.push(`${t}: expected ${want.released ? "the verdict" : "a locked reveal"}, got ${released.get(t) ? "the verdict" : "a locked reveal"}`);
    if (charges.length !== want.charges || sum !== want.sum) failures.push(`${t}: expected ${want.charges} charge(s) summing ${want.sum}, got ${charges.length} summing ${sum}`);
  }
  return failures;
}

export async function runRevealSuite(opts: { groups?: string[] | null; quiet?: boolean; label?: string } = {}): Promise<RevealSummary> {
  const cases = opts.groups ? CASES.filter((k) => opts.groups!.includes(k.group)) : CASES;
  const outcomes: Outcome[] = [];
  for (const k of cases) {
    try {
      const failures = await runCase(k);
      outcomes.push({ id: k.id, group: k.group, control: k.control, result: failures.length ? "grader_fail" : "pass", failures });
    } catch (e) {
      outcomes.push({ id: k.id, group: k.group, control: k.control, result: "harness_error", failures: [`exception: ${String(e).slice(0, 200)}`] });
    }
  }
  const s: RevealSummary = {
    cases: outcomes.length, passed: outcomes.filter((o) => o.result === "pass").length,
    grader_fail: outcomes.filter((o) => o.result === "grader_fail").length, harness_error: outcomes.filter((o) => o.result === "harness_error").length,
    skipped: 0, outcomes, label: opts.label,
  };
  if (!opts.quiet) {
    for (const o of outcomes) if (o.result !== "pass") console.log(`${o.result.toUpperCase().padEnd(13)} ${o.id.padEnd(8)} ${o.failures.join("; ")}`);
    console.log(`${opts.label ? `[${opts.label}] ` : ""}reveal: cases=${s.cases} passed=${s.passed} grader_fail=${s.grader_fail} harness_error=${s.harness_error}`);
  }
  return s;
}

if (process.argv[1] && process.argv[1].endsWith("reveal.ts")) {
  runRevealSuite().then((s) => process.exit(s.grader_fail || s.harness_error ? 1 : 0)).catch((e) => { console.error(String(e)); process.exit(1); });
}
