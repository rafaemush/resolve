/**
 * POST /internal/official/recheck: the admin-only, audited way out of sources_disagree (migration 016
 * recheck_official_corroboration). The RPC is stubbed here; its SQL is asserted by scripts/selftest-db.ts --official.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

const h = vi.hoisted(() => ({ calls: [] as Array<{ fn: string; args: Record<string, unknown> }>, fail: null as string | null }));
vi.mock("../src/db/supabase", () => ({
  db: () => ({}),
  rpc: vi.fn(async (_c: unknown, fn: string, args: Record<string, unknown>) => {
    h.calls.push({ fn, args });
    if (h.fail) throw new Error(h.fail);
    return { series: args.p_series, period: args.p_period, corroboration: args.p_corroboration, recheck_id: 7, previous: { status: "disagree" } };
  }),
}));
vi.mock("../src/ops/alerts", () => ({ alert: vi.fn(async () => ({ sent: true, deduped: false })) }));

import { internal } from "../src/api/internal";
import { alert } from "../src/ops/alerts";

const env = { ADMIN_API_KEY: "admin-test-key" } as unknown as Env;
const post = (body: unknown, key: string | null = "admin-test-key") =>
  internal.request("/official/recheck", { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) }, env);
const good = {
  series: "us_cpi_u_nsa_yoy", period: "2026-09", actor: "founder", reason: "BLS API corrected its September index at 13:05Z; re-read equals the release text",
  corroboration: { status: "agree", source_url: "https://api.bls.gov/publicAPI/v1/timeseries/data/CUUR0000SA0", value_text: "3.4", detail: "CUUR0000SA0 2026-09 re-read" },
};

beforeEach(() => { h.calls = []; h.fail = null; vi.mocked(alert).mockClear(); });

describe("POST /internal/official/recheck", () => {
  it("requires the admin key", async () => {
    expect((await post(good, null)).status).toBe(403);
    expect((await post(good, "wrong")).status).toBe(403);
    expect(h.calls).toHaveLength(0);
  });
  it("calls recheck_official_corroboration with an attributed actor and a complete corroboration, and alerts", async () => {
    const res = await post(good);
    expect(res.status).toBe(200);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ fn: "recheck_official_corroboration", args: { p_series: "us_cpi_u_nsa_yoy", p_period: "2026-09", p_actor: "admin_api:founder", p_reason: good.reason } });
    expect(h.calls[0]!.args.p_corroboration).toMatchObject({ status: "agree", value: 3.4, value_text: "3.4", source_url: good.corroboration.source_url, detail: "CUUR0000SA0 2026-09 re-read" });
    expect(typeof (h.calls[0]!.args.p_corroboration as { checked_at: unknown }).checked_at).toBe("string");
    expect(vi.mocked(alert).mock.calls[0]?.[1]).toBe("official_recheck_us_cpi_u_nsa_yoy_2026-09");
  });
  it("refuses unknown statuses, short reasons, and a corroborating URL off the series allowlist", async () => {
    expect((await post({ ...good, corroboration: { ...good.corroboration, status: "probably" } })).status).toBe(400);
    expect((await post({ ...good, reason: "ok" })).status).toBe(400);
    expect((await post({ ...good, corroboration: { ...good.corroboration, source_url: "https://inflation-blog.example/cpi" } })).status).toBe(400);
    expect(h.calls).toHaveLength(0);
  });
  it("a database refusal (no first print yet) is a 400, never a silent success", async () => {
    h.fail = "rpc recheck_official_corroboration: P0001 recheck_official_corroboration: no first print for us_cpi_u_nsa_yoy 2026-09";
    const res = await post(good);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("no first print");
  });
});
