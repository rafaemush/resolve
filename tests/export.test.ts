/**
 * GET /v1/shadow/export (plan §17.3 P7-lite): the calling tenant's entitled follows only (another tenant's, an
 * unfollowed one, one above the plan's cap after a plan change, and an ended evaluation are not exported), one row per
 * market from v_venue_report, the platform and since filters, RFC 4180 CSV with a header row, never the nonce or the
 * preimage, "export" never read as a market id, and the subrequests it makes. No network: an in-memory database.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { fakeDb, type FakeDb, type Row } from "./lib/fake-db";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, plan: "builder" as string, tenant: "t1" }));
vi.mock("../src/db/supabase", () => ({
  db: () => h.db.client,
  rpc: async (client: FakeDb["client"], fn: string, args: Record<string, unknown>) => {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new Error(`rpc ${fn}: ${error.message}`);
    return data;
  },
}));
vi.mock("../src/api/auth", () => ({
  authenticate: async () => ({ ok: true, auth: { keyId: "k1", tenantId: h.tenant, plan: h.plan, strictV0: false, environment: "test", scopes: [], requestsToday: 0, dailyCap: 1000 } }),
  rateLimit: async () => ({ allowed: true }),
  extractApiKey: () => null,
  invalidateKeyCache: async () => undefined,
}));
vi.mock("../src/ops/alerts", () => ({ alert: vi.fn(async () => ({ sent: true, deduped: false })) }));

import { v1 } from "../src/api/v1";
import { chunks, entitledFollows, exportCsv, exportRows, EXPORT_COLUMNS, EXPORT_SUBREQUESTS, ExportQuery, type ExportFollow, type ExportViewRow } from "../src/shadow/export";
import { csvField, toCsv } from "../src/ops/csv";
import { EARLY_REVEAL_LABEL } from "../src/shadow/follows";

const env = { JEV_MODEL: "jev-1.13.0", JEV_RPM_LIMIT: "60", SPOTLIGHT_SECRET: "s", SUPABASE_URL: "https://neutralized.invalid", SUPABASE_SERVICE_ROLE_KEY: "neutralized", INTERNAL_HMAC_SECRET: "x", ADMIN_API_KEY: "x", EVAL_REPORT_KEY: "x" } as unknown as Env;
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const uuid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const at = (minutes: number) => new Date(Date.parse("2026-10-01T00:00:00Z") + minutes * 60_000).toISOString();

const follow = (n: number, over: Partial<ExportFollow> & { status?: string; platform?: string } = {}): ExportFollow => ({
  id: `f${String(n).padStart(4, "0")}`, market_id: uuid(n), created_at: at(n),
  markets: { platform: over.platform ?? "polymarket", status: over.status ?? "open", deleted_at: null }, ...over,
});

const viewRow = (n: number, over: Partial<ExportViewRow> = {}): ExportViewRow => ({
  market_id: uuid(n), platform: "polymarket", external_id: `ext-${n}`, event_key: `polymarket:event:${n}`, venue_slug: `slug-${n}`, status: "open",
  n_commits: 1, latest_committed_at: at(100 + n), latest_commitment_sha256: "e".repeat(64), committed_status: "RESOLVED", committed_outcome: "OPTION_A",
  evidence_raw_sha256: "a".repeat(64), evidence_canonical_sha256: "b".repeat(64),
  official_outcome: null, official_at: null, official_at_source: null, agreement: null, lead_seconds: null, reconciled_at: null, ...over,
});

describe("entitledFollows: the rule of follow_entitlements() + followBlock() for every follow at once", () => {
  it("within the cap everything is exported; above it only the oldest follows of open markets up to the cap", () => {
    const fs = Array.from({ length: 52 }, (_, i) => follow(i + 1));
    expect(entitledFollows(fs, "builder", true).map((f) => f.id)).toEqual(fs.slice(0, 50).map((f) => f.id));
    expect(entitledFollows(fs, "growth", true)).toHaveLength(52);
    expect(entitledFollows(fs, "platform", true)).toHaveLength(52);
  });
  it("a follow of a settled market holds no slot but is itself exported while within its rank (its reveal is what it follows)", () => {
    const fs = [follow(1, { status: "resolved" }), ...Array.from({ length: 50 }, (_, i) => follow(i + 2)), follow(60, { status: "resolved" })];
    const out = entitledFollows(fs, "builder", true).map((f) => f.id);
    expect(out).toContain("f0001");          // rank 1
    expect(out).toContain("f0051");          // the 50th open follow: rank 50 (the settled one before it does not count)
    expect(out).not.toContain("f0060");      // rank 51: 50 open follows before it
    expect(out).toHaveLength(51);
  });
  it("order is (created_at, id), whatever order the rows came in; a missing market row is never exported", () => {
    const fs = Array.from({ length: 51 }, (_, i) => follow(i + 1)).reverse();
    expect(entitledFollows(fs, "builder", true).map((f) => f.id)).not.toContain("f0051");
    expect(entitledFollows([{ ...follow(1), markets: null }], "platform", true)).toEqual([]);
    const tie = [{ ...follow(2), created_at: at(1) }, follow(1)];
    expect(entitledFollows(tie, "platform", true).map((f) => f.id)).toEqual(["f0001", "f0002"]);
  });
  it("a free-plan tenant without a live key gets nothing (the evaluation ended)", () => {
    expect(entitledFollows([follow(1)], "free", false)).toEqual([]);
    expect(entitledFollows([follow(1)], "free", true)).toHaveLength(1);
    expect(entitledFollows([follow(1)], "payg", false)).toHaveLength(1);
  });
});

describe("exportRows, the query and the CSV", () => {
  it("platform and since filter; since keeps a row whose latest commit or final reconciliation is at or after it", () => {
    const view = [
      viewRow(1),
      viewRow(2, { platform: "limitless", event_key: "limitless:group:9", latest_committed_at: at(10) }),
      viewRow(3, { latest_committed_at: at(10), reconciled_at: at(500), official_outcome: "OPTION_A", official_at: at(490), official_at_source: "gamma_closed_time", agreement: "agree", lead_seconds: "380" }),
      viewRow(4, { latest_committed_at: null, n_commits: 0 }),
    ];
    expect(exportRows(view, {}).map((r) => r.market_id)).toEqual([uuid(2), uuid(1), uuid(3), uuid(4)]);
    expect(exportRows(view, { platform: "limitless" }).map((r) => r.market_id)).toEqual([uuid(2)]);
    expect(exportRows(view, { since: at(100) }).map((r) => r.market_id)).toEqual([uuid(1), uuid(3)]);
    expect(exportRows(view, {}).find((r) => r.market_id === uuid(3))).toMatchObject({ committed_at: at(10), commitment_sha256: "e".repeat(64), agreement: "agree", lead_seconds: 380, official_at_source: "gamma_closed_time" });
  });
  it("the query: platform enum, since as a UTC day or an ISO time, json by default", () => {
    expect(ExportQuery.parse({})).toEqual({ format: "json" });
    expect(ExportQuery.parse({ platform: "limitless", since: "2026-10-01", format: "csv" })).toEqual({ platform: "limitless", since: "2026-10-01T00:00:00.000Z", format: "csv" });
    expect(ExportQuery.parse({ since: "2026-10-01T05:00:00+05:00" }).since).toBe("2026-10-01T00:00:00.000Z");
    for (const bad of [{ platform: "kalshi" }, { since: "yesterday" }, { since: "2026-13-40" }, { since: "2026-02-30" }, { since: "1700000000" }, { since: "T" }, { format: "xml" }]) expect(ExportQuery.safeParse(bad).success).toBe(false);
  });
  it("RFC 4180: header row, CRLF, quotes only where needed, doubled quotes, empty for null", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("line\nbreak")).toBe('"line\nbreak"');
    expect(csvField(" padded")).toBe('" padded"');
    expect(csvField(null)).toBe("");
    expect(csvField(-120)).toBe("-120");
    expect(toCsv(["a", "b"], [{ a: 1, b: "x,y" }, { a: null }])).toBe('a,b\r\n1,"x,y"\r\n,\r\n');
    const csv = exportCsv(exportRows([viewRow(1)], {}));
    const [header, line, end] = csv.split("\r\n");
    expect(header).toBe(EXPORT_COLUMNS.join(","));
    expect(line!.split(",")).toHaveLength(EXPORT_COLUMNS.length);
    expect(end).toBe("");
  });
  it("formula injection: a string cell a spreadsheet would evaluate is written as quoted text with a leading apostrophe", () => {
    expect(csvField("=1+1")).toBe(`"'=1+1"`);
    expect(csvField("+1")).toBe(`"'+1"`);
    expect(csvField("-1+1")).toBe(`"'-1+1"`);
    expect(csvField("@x")).toBe(`"'@x"`);
    expect(csvField('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(csvField("\tcmd")).toBe(`"'\tcmd"`);
    expect(csvField("\r=1")).toBe(`"'\r=1"`);
    expect(csvField("  =1+1")).toBe(`"'  =1+1"`);
    expect(csvField("\uFF1D1+1")).toBe(`"'\uFF1D1+1"`);
    // numbers stay numbers; a hyphen or @ inside a value is not a formula
    expect(csvField(-120)).toBe("-120");
    expect(csvField(0)).toBe("0");
    expect(csvField("fed-decision-in-october-1")).toBe("fed-decision-in-october-1");
    expect(csvField("a@b")).toBe("a@b");
    expect(csvField("2026-10-01T00:00:00.000Z")).toBe("2026-10-01T00:00:00.000Z");
  });
  it("formula injection through exportCsv: platform identifiers are neutralised, lead_seconds stays numeric", () => {
    const csv = exportCsv(exportRows([viewRow(1, { external_id: "=cmd|' /C calc'!A0", venue_slug: "@SUM(A1)", event_key: "+evt", lead_seconds: -120, agreement: "agree" })], {}));
    const line = csv.split("\r\n")[1]!;
    expect(line).toContain(`"'=cmd|' /C calc'!A0"`);
    expect(line).toContain(`"'@SUM(A1)"`);
    expect(line).toContain(`"'+evt"`);
    expect(line.endsWith(",agree,-120")).toBe(true);
    for (const cell of line.split(",")) expect(cell).not.toMatch(/^[=+@]/);
  });
  it("chunks of 100", () => {
    expect(chunks(Array.from({ length: 250 }, (_, i) => i)).map((c) => c.length)).toEqual([100, 100, 50]);
    expect(chunks([])).toEqual([]);
    expect(EXPORT_SUBREQUESTS).toBe(12);
  });
});

// ---- the route --------------------------------------------------------------------------------------------------------

const call = async (path: string) => {
  const res = await v1.request(path, { method: "GET" }, env, ctx);
  return { status: res.status, headers: res.headers, text: await res.text() };
};

describe("GET /v1/shadow/export", () => {
  beforeEach(() => {
    h.plan = "builder"; h.tenant = "t1";
    const mf = (n: number, tenant: string, over: Row = {}): Row => ({ id: `f${String(n).padStart(4, "0")}`, tenant_id: tenant, market_id: uuid(n), created_at: at(n), deleted_at: null, markets: { platform: n === 2 ? "limitless" : "polymarket", status: "open", deleted_at: null }, ...over });
    h.db = fakeDb({
      tenants: [{ id: "t1", plan: "builder", deleted_at: null }, { id: "t2", plan: "builder", deleted_at: null }],
      market_follows: [mf(1, "t1"), mf(2, "t1"), mf(3, "t1", { deleted_at: at(50) }), mf(4, "t2")],
      v_venue_report: [
        viewRow(1, { reconciled_at: at(500), official_outcome: "OPTION_A", official_at: at(490), official_at_source: "gamma_closed_time", agreement: "agree", lead_seconds: 380 }),
        viewRow(2, { platform: "limitless", external_id: "leg-a", event_key: "limitless:group:9", venue_slug: "leg-a" }),
        viewRow(3), viewRow(4),
      ],
      api_request_log: [],
    });
  });
  const reads = () => h.db.calls.filter((x) => x.table !== "api_request_log");

  it("JSON: only the tenant's active, entitled follows; labeled; never a nonce or a preimage", async () => {
    const r = await call("/shadow/export");
    expect(r.status).toBe(200);
    const body = JSON.parse(r.text);
    expect(body.data.rows.map((x: Row) => x.market_id)).toEqual([uuid(2), uuid(1)]);
    expect(body.data).toMatchObject({ count: 2, truncated: false, label: EARLY_REVEAL_LABEL, filters: { platform: null, since: null } });
    expect(body.data.rows[1]).toMatchObject({ commitment_sha256: "e".repeat(64), committed_status: "RESOLVED", official_outcome: "OPTION_A", agreement: "agree", lead_seconds: 380 });
    expect(r.text).not.toMatch(/preimage"|nonce"/);
    expect(reads().length).toBeLessThanOrEqual(EXPORT_SUBREQUESTS); // plan, follows, one view chunk
  });

  it("CSV: header row and one line per market, served as text/csv", async () => {
    const r = await call("/shadow/export?format=csv&platform=polymarket");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/csv");
    expect(r.headers.get("x-resolve-truncated")).toBe("false");
    const lines = r.text.split("\r\n");
    expect(lines[0]).toBe(EXPORT_COLUMNS.join(","));
    expect(lines.slice(1).filter(Boolean)).toHaveLength(1);
    expect(lines[1]).toContain(uuid(1));
  });

  it("a follow above the plan's cap is not exported (the same rule as the webhooks)", async () => {
    for (let n = 10; n < 60; n++) h.db.tables.market_follows!.push({ id: `f${String(n).padStart(4, "0")}`, tenant_id: "t1", market_id: uuid(n), created_at: at(-100 + n), deleted_at: null, markets: { platform: "polymarket", status: "open", deleted_at: null } });
    const body = JSON.parse((await call("/shadow/export")).text);
    // 50 older follows fill the Builder cap: markets 1 and 2 (followed later) are above it
    expect(body.data.rows.map((x: Row) => x.market_id)).not.toContain(uuid(1));
    expect(body.data.rows.map((x: Row) => x.market_id)).not.toContain(uuid(2));
  });

  it("truncated only when a follow beyond the 1,000 read exists: exactly 1,000 is complete, 1,001 is not", async () => {
    h.db.tables.tenants![0]!.plan = "platform";
    const mfs = (from: number, n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: `g${String(from + i).padStart(5, "0")}`, tenant_id: "t1", market_id: uuid(1000 + from + i), created_at: at(1000 + from + i), deleted_at: null, markets: { platform: "polymarket", status: "open", deleted_at: null } }));
    h.db.tables.market_follows = mfs(0, 1000);
    const full = await call("/shadow/export?format=csv");
    expect(full.headers.get("x-resolve-truncated")).toBe("false");
    expect(JSON.parse((await call("/shadow/export")).text).data.truncated).toBe(false);
    h.db.tables.market_follows.push(...mfs(1000, 1));
    expect((await call("/shadow/export?format=csv")).headers.get("x-resolve-truncated")).toBe("true");
    expect(JSON.parse((await call("/shadow/export")).text).data.truncated).toBe(true);
  });

  it("a created_at tie at the 1,000-row boundary keeps the follow follow_entitlements orders first: (created_at, id)", async () => {
    h.db.tables.tenants![0]!.plan = "platform";
    const mk = (id: string, n: number, minute: number): Row => ({ id, tenant_id: "t1", market_id: uuid(n), created_at: at(minute), deleted_at: null, markets: { platform: "polymarket", status: "open", deleted_at: null } });
    // 999 older follows, then two at the same instant, stored with the larger id first
    h.db.tables.market_follows = [...Array.from({ length: 999 }, (_, i) => mk(`g${String(i).padStart(5, "0")}`, 5000 + i, i)), mk("zz-late-id", 7001, 2000), mk("hh-early-id", 7002, 2000)];
    h.db.tables.v_venue_report = [viewRow(7001), viewRow(7002)];
    const body = JSON.parse((await call("/shadow/export")).text);
    expect(body.data.rows.map((x: Row) => x.market_id)).toEqual([uuid(7002)]);
    expect(body.data.truncated).toBe(true);
  });

  it("another tenant sees only its own follows; a tenant with none gets an empty export", async () => {
    h.tenant = "t2";
    expect(JSON.parse((await call("/shadow/export")).text).data.rows.map((x: Row) => x.market_id)).toEqual([uuid(4)]);
    h.tenant = "t9";
    h.db.tables.tenants!.push({ id: "t9", plan: "free", deleted_at: null });
    const empty = await call("/shadow/export?format=csv");
    expect(empty.text).toBe(EXPORT_COLUMNS.join(",") + "\r\n");
  });

  it("a bad query is a 400; 'export' is never read as a market id", async () => {
    const r = await call("/shadow/export?platform=kalshi");
    expect(r.status).toBe(400);
    expect(JSON.parse(r.text).error.code).toBe("validation_error");
    expect((await call("/shadow/export?since=soon")).status).toBe(400);
  });

  it("a store that cannot be read is a 503, never an empty export", async () => {
    h.db.client.from = ((orig) => (table: string) => {
      if (table === "v_venue_report") return { select: () => ({ in: async () => ({ data: null, error: { message: "relation does not exist" } }) }) } as never;
      return orig(table);
    })(h.db.client.from.bind(h.db.client));
    const r = await call("/shadow/export");
    expect(r.status).toBe(503);
  });
});
