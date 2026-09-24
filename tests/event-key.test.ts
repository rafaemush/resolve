/**
 * markets.event_key (migration 017, plan §17.3 "n >= 100 counted by distinct event, not ladder leg"): the rule, and that
 * registration writes it. The SQL twin market_event_key() is checked against eventKey() on a real database by
 * scripts/selftest/fixes.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { fakeDb, type FakeDb } from "./lib/fake-db";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock("../src/db/supabase", () => ({ db: () => h.db.client, rpc: vi.fn() }));

import { eventKey } from "../src/markets/event-key";
import { buildLegRegistration } from "../src/markets/official-legs";
import { internal } from "../src/api/internal";

describe("eventKey (pure)", () => {
  it("official_release legs share official:<series>:<period>, whatever the platform", () => {
    const resolver = { kind: "official_release", series: "us_cpi_u_nsa_yoy", period: "2026-09" };
    expect(eventKey({ platform: "limitless", external_id: "30percent-1789462576829", resolver })).toBe("official:us_cpi_u_nsa_yoy:2026-09");
    expect(eventKey({ platform: "polymarket", external_id: "12345", resolver, meta: { event_id: "60182" } })).toBe("official:us_cpi_u_nsa_yoy:2026-09");
  });

  it("a Polymarket event, a Limitless group; otherwise the market itself", () => {
    expect(eventKey({ platform: "polymarket", external_id: "637022", meta: { event_id: "60182" } })).toBe("polymarket:event:60182");
    expect(eventKey({ platform: "polymarket", external_id: "637022", meta: { event_id: 60182 } })).toBe("polymarket:event:60182");
    expect(eventKey({ platform: "limitless", external_id: "leg-slug", meta: { group_id: "10014423" } })).toBe("limitless:group:10014423");
    // a key of the other platform does not group
    expect(eventKey({ platform: "limitless", external_id: "leg-slug", meta: { event_id: "60182" } })).toBe("limitless:leg-slug");
    expect(eventKey({ platform: "polymarket", external_id: "637022", meta: { group_id: "1" } })).toBe("polymarket:637022");
    expect(eventKey({ platform: "custom", external_id: "smoke-1" })).toBe("custom:smoke-1");
    expect(eventKey({ platform: "polymarket", external_id: "637022", meta: { event_id: "  " }, resolver: { kind: "github_release_published" } })).toBe("polymarket:637022");
  });
});

describe("registration writes markets.event_key", () => {
  const env = { JEV_MODEL: "jev-1.13.0", JEV_RPM_LIMIT: "60", SPOTLIGHT_SECRET: "eval-spotlight-v1", SUPABASE_URL: "https://neutralized.invalid", SUPABASE_SERVICE_ROLE_KEY: "neutralized", INTERNAL_HMAC_SECRET: "x", ADMIN_API_KEY: "admin-test", EVAL_REPORT_KEY: "x" } as unknown as Env;
  const post = (body: unknown) => internal.request("/markets", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer admin-test" }, body: JSON.stringify(body) }, env);
  // github_api and official_release sources need no registration-time network check
  const github = {
    platform: "polymarket", external_id: "637022", condition: "Resolves Yes if release v2.0.0 of acme/widget is published before the deadline.",
    event_statement: "acme/widget publishes release v2.0.0", option_a: "Yes", option_b: "No", positive_option: "OPTION_A", anchors: ["v2.0.0"],
    sources: [{ kind: "github_api", ref: "repos/acme/widget/releases/tags/v2.0.0" }], open_at: "2026-09-01T00:00:00Z", deadline_utc: "2026-10-20T00:00:00Z",
  };
  beforeEach(() => { h.db = fakeDb({ markets: [], watches: [] }); });

  it("the legs of one ladder get one event_key; a lone market its own", async () => {
    for (const [i, label] of ["3.3%", "3.4%"].entries()) {
      const leg = buildLegRegistration({ platform: "limitless", external_id: `cpi-leg-${i}`, group: { series: "us_cpi_u_nsa_yoy", period: "2026-09", release_at: "2026-10-14T12:30:00Z", title: "September Inflation US - Annual" }, label, open_at: "2026-09-15T08:56:56.799Z", deadline_utc: "2026-10-15T03:59:00Z", criteria: "structure only" });
      if (!leg.ok) throw new Error(leg.reason);
      expect((await post({ market: leg.market })).status).toBe(201);
    }
    expect((await post({ market: github, meta: { event_id: "60182" } })).status).toBe(201);
    expect((await post({ market: { ...github, external_id: "637023" } })).status).toBe(201);
    expect(h.db.tables.markets!.map((m) => m.event_key)).toEqual(["official:us_cpi_u_nsa_yoy:2026-09", "official:us_cpi_u_nsa_yoy:2026-09", "polymarket:event:60182", "polymarket:637023"]);
  });
});
