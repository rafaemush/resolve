/**
 * Venue-shaped verdict payloads (plan §17.3 P7-lite, §19.3): the venue object of shadow.committed / shadow.revealed per
 * platform, no proposal unless the committed verdict is RESOLVED, and the round trip: the proposed Limitless
 * winningOutcomeIndex, read back by reconcile's own reader (limitlessOfficial on the real API shape of
 * tests/fixtures/limitless-markets.json), is the committed outcome; the proposed Polymarket label, read back by
 * polymarketOfficial, is the committed outcome.
 */
import { describe, expect, it, vi } from "vitest";
vi.mock("../src/db/supabase", () => ({ db: () => { throw new Error("no database in this test"); } }));
vi.mock("../src/ops/alerts", () => ({ alert: vi.fn(async () => ({ sent: true, deduped: false })) }));

import LIMITLESS from "./fixtures/limitless-markets.json";
import { limitlessOfficial, polymarketOfficial } from "../src/jobs/reconcile";
import { LIMITLESS_YES_NO, limitlessLabels, limitlessOutcomeAt, limitlessOutcomeIndex } from "../src/markets/outcomes";
import { proposedOption, venuePayload, type VenueMarket } from "../src/shadow/venue";
import { shadowCommittedPayload, shadowRevealedPayload } from "../src/shadow/events";
import { buildLimitless } from "../scripts/lib/candidates-limitless";
import { buildPreimage, committedFields, type CommittedVerdict, type OfficialRecord } from "../src/bot/commit";
import type { Verdict } from "../src/resolve/schema";

const FIX = LIMITLESS as Record<string, any>;
const NOW = "2026-10-20T12:00:00.000Z";
const CID = `0x${"AB".repeat(32)}`;
const RESOLVED_A = { resolution_status: "RESOLVED", winning_outcome: "OPTION_A" };
const RESOLVED_B = { resolution_status: "RESOLVED", winning_outcome: "OPTION_B" };
const UNRESOLVED = { resolution_status: "UNRESOLVED", winning_outcome: "NONE" };

function committed(v: { resolution_status: string; winning_outcome: string }): CommittedVerdict {
  const verdict = { ...v, confidence_score: 0.95, caveats: v.resolution_status === "RESOLVED" ? [] : ["no_anchor"], thresholds_version: "v1", determination_basis: "structured", evidence: { raw_sha256: "d".repeat(64), canonical_sha256: "c".repeat(64) } } as unknown as Verdict;
  const f = committedFields(verdict);
  return { preimage_version: "v2", preimage: buildPreimage("limitless:x", f, "0123456789abcdef01234567"), ...f };
}

const leg = FIX.group.markets[0];
const LIMITLESS_LEG: VenueMarket & { id: string } = {
  id: "m-l", platform: "limitless", external_id: leg.slug, option_a: "Yes", option_b: "No", condition_id: leg.conditionId,
  meta: { slug: leg.slug, group_id: String(FIX.group.id), group_slug: FIX.group.slug, category: "politics" },
};

describe("limitless venue object", () => {
  it("slug, group_slug, condition_id and the proposed winningOutcomeIndex (YES = 0, NO = 1)", () => {
    expect(venuePayload(LIMITLESS_LEG, RESOLVED_A)).toEqual({ platform: "limitless", slug: leg.slug, group_slug: FIX.group.slug, condition_id: leg.conditionId, proposed_winning_outcome_index: 0 });
    expect(venuePayload(LIMITLESS_LEG, RESOLVED_B)).toMatchObject({ proposed_winning_outcome_index: 1 });
  });
  it("an UNRESOLVED or ERROR commit, or no readable commit, proposes nothing", () => {
    expect(venuePayload(LIMITLESS_LEG, UNRESOLVED)).toMatchObject({ proposed_winning_outcome_index: null, slug: leg.slug });
    expect(venuePayload(LIMITLESS_LEG, { resolution_status: "ERROR", winning_outcome: "NONE" })).toMatchObject({ proposed_winning_outcome_index: null });
    expect(venuePayload(LIMITLESS_LEG, null)).toMatchObject({ proposed_winning_outcome_index: null });
    expect(proposedOption({ resolution_status: "RESOLVED", winning_outcome: "NONE" })).toBeNull(); // cannot exist (CHECK), never a proposal
  });
  it("slug falls back to external_id (reconcile's limitlessSlug), group_slug to null; condition_id from the column, else meta, lower-cased", () => {
    const single: VenueMarket = { platform: "limitless", external_id: "single-slug", option_a: "Yes", option_b: "No", meta: { condition_id: CID } };
    expect(venuePayload(single, RESOLVED_A)).toEqual({ platform: "limitless", slug: "single-slug", group_slug: null, condition_id: CID.toLowerCase(), proposed_winning_outcome_index: 0 });
    expect(venuePayload({ ...single, meta: { limitless_slug: "leg-slug" }, condition_id: null }, RESOLVED_A)).toMatchObject({ slug: "leg-slug", condition_id: null });
    expect(venuePayload({ ...single, meta: null }, RESOLVED_A)).toMatchObject({ slug: "single-slug", group_slug: null });
  });
  it("the index is taken over the leg's own labels recorded at registration (meta.outcome_labels), not an assumed Yes/No order", () => {
    const reversed = { ...LIMITLESS_LEG, meta: { ...LIMITLESS_LEG.meta, outcome_labels: ["No", "Yes"] } };
    expect(venuePayload(reversed, RESOLVED_A)).toMatchObject({ proposed_winning_outcome_index: 1 });
    expect(venuePayload(reversed, RESOLVED_B)).toMatchObject({ proposed_winning_outcome_index: 0 });
    // labels the options are not among: no proposal; a malformed list: no proposal; absent: tokens {yes, no}
    expect(venuePayload({ ...LIMITLESS_LEG, meta: { outcome_labels: ["Up", "Down"] } }, RESOLVED_A)).toMatchObject({ proposed_winning_outcome_index: null });
    expect(venuePayload({ ...LIMITLESS_LEG, meta: { outcome_labels: "Yes,No" } }, RESOLVED_A)).toMatchObject({ proposed_winning_outcome_index: null });
    expect(venuePayload({ ...LIMITLESS_LEG, meta: { outcome_labels: ["Yes"] } }, RESOLVED_A)).toMatchObject({ proposed_winning_outcome_index: null });
    expect(venuePayload({ ...LIMITLESS_LEG, meta: {} }, RESOLVED_A)).toMatchObject({ proposed_winning_outcome_index: 0 });
  });
  it("options that are not the market's own labels are never proposed as a guess (reconcile could not read them back)", () => {
    expect(venuePayload({ ...LIMITLESS_LEG, option_a: "Democratic Party", option_b: "Republican Party" }, RESOLVED_A)).toMatchObject({ proposed_winning_outcome_index: null });
    expect(venuePayload({ ...LIMITLESS_LEG, option_a: "Yes", option_b: "yes" }, RESOLVED_A)).toMatchObject({ proposed_winning_outcome_index: null });
    // reversed option text: OPTION_A "No" is index 1, never "OPTION_A = index 0"
    expect(venuePayload({ ...LIMITLESS_LEG, option_a: "No", option_b: "Yes" }, RESOLVED_A)).toMatchObject({ proposed_winning_outcome_index: 1 });
  });
});

describe("round trip through reconcile's Limitless reader (the fixture's real API shape)", () => {
  const legs: Array<[string, Record<string, unknown>]> = [["single CLOB market", FIX.single_clob], ["group leg", leg]];
  for (const [what, json] of legs) {
    for (const [option_a, option_b] of [["Yes", "No"], ["No", "Yes"]] as Array<[string, string]>) {
      for (const c of [RESOLVED_A, RESOLVED_B]) {
        it(`${what}, options ${option_a}/${option_b}, committed ${c.winning_outcome}: the proposed index reads back as the committed outcome`, () => {
          const m: VenueMarket = { platform: "limitless", external_id: String(json.slug), option_a, option_b, meta: {} };
          const v = venuePayload(m, c);
          if (v.platform !== "limitless") throw new Error("not limitless");
          expect(v.proposed_winning_outcome_index).not.toBeNull();
          const read = limitlessOfficial({ ...json, status: "RESOLVED", expired: true, winningOutcomeIndex: v.proposed_winning_outcome_index }, m, String(json.slug), NOW);
          expect(read).toMatchObject({ kind: "resolved", official: { outcome: c.winning_outcome } });
        });
      }
    }
  }
  it("a leg that carries its own outcomeTokens: the registration records them and the proposal reads back through reconcile", () => {
    for (const outcomeTokens of [["No", "Yes"], ["Yes", "No"]]) {
      const json = { ...leg, outcomeTokens };
      // what scripts/lib/candidates-limitless.ts registers for this leg
      // (the fixture carries no titles: Platform Content; the classifier needs one)
      const entry = buildLimitless([{ ...FIX.group, title: "Group", automationType: "manual", expirationTimestamp: Date.parse("2026-11-01T00:00:00Z"), markets: [{ ...json, title: "Leg", expirationTimestamp: Date.parse("2026-11-01T00:00:00Z") }] }], { now: new Date("2026-10-01T00:00:00Z"), days: 45, maxVolume: 1e9 }).entries[0]!;
      const reg = entry.registration;
      expect(reg.meta).toMatchObject({ outcome_labels: outcomeTokens });
      const m: VenueMarket = { platform: "limitless", external_id: String(reg.market.external_id), option_a: String(reg.market.option_a), option_b: String(reg.market.option_b), meta: reg.meta as Record<string, unknown> };
      for (const c of [RESOLVED_A, RESOLVED_B]) {
        const v = venuePayload(m, c);
        if (v.platform !== "limitless") throw new Error("not limitless");
        const read = limitlessOfficial({ ...json, status: "RESOLVED", expired: true, winningOutcomeIndex: v.proposed_winning_outcome_index }, m, String(json.slug), NOW);
        expect(read, `${outcomeTokens.join("/")} ${c.winning_outcome}`).toMatchObject({ kind: "resolved", official: { outcome: c.winning_outcome } });
      }
    }
  });
  it("the fixture's legs carry tokens {yes, no}, the order the proposal assumes; the container's outcomeTokens agree", () => {
    expect(limitlessLabels(FIX.single_clob)).toEqual(LIMITLESS_YES_NO);
    expect(limitlessLabels(leg)).toEqual(LIMITLESS_YES_NO);
    expect(limitlessLabels(FIX.group)).toEqual(["Yes", "No"]);
    expect(limitlessLabels(FIX.amm)).toBeNull();
  });
  it("limitlessOutcomeIndex inverts limitlessOutcomeAt over any label order", () => {
    const m = { option_a: "Up", option_b: "Down" };
    for (const labels of [["Up", "Down"], ["Down", "Up"], ["Flat", "Down", "Up"]]) {
      for (const o of ["OPTION_A", "OPTION_B"] as const) {
        const i = limitlessOutcomeIndex(o, m, labels);
        expect(i).not.toBeNull();
        expect(limitlessOutcomeAt(i!, labels, m)).toBe(o);
      }
    }
    expect(limitlessOutcomeIndex("OPTION_A", m, ["Up", "UP"])).toBeNull(); // two indexes read as OPTION_A: ambiguous, no proposal
    expect(limitlessOutcomeAt(-1, ["Up", "Down"], m)).toBeNull();
    expect(limitlessOutcomeAt(2, ["Up", "Down"], m)).toBeNull();
  });
});

describe("polymarket and custom venue objects", () => {
  const PM: VenueMarket = { platform: "polymarket", external_id: "551234", option_a: "Yes", option_b: "No", condition_id: CID.toLowerCase(), meta: { slug: "cpi-above-3", event_id: 60182 } };
  it("a label reconcile could not map back is never proposed: options equal after normalization, or an empty option", () => {
    const same = { ...PM, option_a: "Yes", option_b: "yes." };
    expect(venuePayload(same, RESOLVED_A)).toMatchObject({ proposed_outcome_label: null });
    expect(venuePayload(same, RESOLVED_B)).toMatchObject({ proposed_outcome_label: null });
    expect(venuePayload({ ...PM, option_a: "", option_b: "No" }, RESOLVED_A)).toMatchObject({ proposed_outcome_label: null });
    expect(venuePayload({ ...PM, option_a: "", option_b: "No" }, RESOLVED_B)).toMatchObject({ proposed_outcome_label: "No" });
    expect(venuePayload({ ...PM, option_a: "--", option_b: "No" }, RESOLVED_A)).toMatchObject({ proposed_outcome_label: null });
  });
  it("condition_id, slug, event_id and the proposed outcome label; null for an UNRESOLVED commit", () => {
    expect(venuePayload(PM, RESOLVED_B)).toEqual({ platform: "polymarket", condition_id: CID.toLowerCase(), slug: "cpi-above-3", event_id: "60182", proposed_outcome_label: "No" });
    expect(venuePayload(PM, UNRESOLVED)).toMatchObject({ proposed_outcome_label: null, slug: "cpi-above-3" });
    expect(venuePayload({ ...PM, meta: {}, condition_id: null }, RESOLVED_A)).toEqual({ platform: "polymarket", condition_id: null, slug: null, event_id: null, proposed_outcome_label: "Yes" });
  });
  it("round trip: the proposed label, as gamma's winning outcome, reads back as the committed outcome", () => {
    for (const c of [RESOLVED_A, RESOLVED_B]) {
      const v = venuePayload(PM, c);
      if (v.platform !== "polymarket") throw new Error("not polymarket");
      const prices = v.proposed_outcome_label === "Yes" ? ["1", "0"] : ["0", "1"];
      const read = polymarketOfficial({ closed: true, umaResolutionStatus: "resolved", outcomes: '["Yes","No"]', outcomePrices: JSON.stringify(prices), closedTime: "2026-10-05 12:02:13+00", slug: "cpi-above-3" }, PM, NOW, "https://gamma-api.polymarket.com/markets/551234");
      expect(read).toMatchObject({ kind: "resolved", official: { outcome: c.winning_outcome } });
    }
  });
  it("custom: the external id only", () => {
    expect(venuePayload({ platform: "custom", external_id: "acme-1", option_a: "Yes", option_b: "No", meta: { slug: "ignored" } }, RESOLVED_A)).toEqual({ platform: "custom", external_id: "acme-1" });
  });
});

describe("the venue object in shadow.committed and shadow.revealed", () => {
  it("shadow.committed keeps the commitment and evidence hashes and adds the venue object; never the nonce or the preimage", () => {
    const c = committed(RESOLVED_B);
    const p = shadowCommittedPayload(LIMITLESS_LEG, { commitment_sha256: "e".repeat(64), committed_at: "2026-10-02T00:00:00.000Z", committed: c });
    expect(p).toMatchObject({ commitment_sha256: "e".repeat(64), evidence: { raw_sha256: "d".repeat(64), canonical_sha256: "c".repeat(64) }, venue: { platform: "limitless", slug: leg.slug, proposed_winning_outcome_index: 1 } });
    expect(JSON.stringify(p)).not.toContain(c.preimage);
    expect(JSON.stringify(p)).not.toContain("0123456789abcdef01234567");
  });
  it("an UNRESOLVED commit is delivered with a null proposal", () => {
    const p = shadowCommittedPayload(LIMITLESS_LEG, { commitment_sha256: "e".repeat(64), committed_at: "2026-10-02T00:00:00.000Z", committed: committed(UNRESOLVED) });
    expect(p.venue).toEqual({ platform: "limitless", slug: leg.slug, group_slug: FIX.group.slug, condition_id: leg.conditionId, proposed_winning_outcome_index: null });
  });
  it("shadow.revealed proposes the final commit's verdict", () => {
    const official: OfficialRecord = { outcome: "OPTION_A", label: "Yes", at: NOW, at_source: "limitless_api_poll", source_url: `https://limitless.exchange/markets/${leg.slug}` };
    const p = shadowRevealedPayload(LIMITLESS_LEG, official, [
      { commitment_sha256: "1".repeat(64), committed_at: "2026-10-01T00:00:00.000Z", agreement: "abstained", final: false, committed: committed(UNRESOLVED) },
      { commitment_sha256: "2".repeat(64), committed_at: "2026-10-02T00:00:00.000Z", agreement: "agree", final: true, committed: committed(RESOLVED_A) },
    ]);
    expect(p.venue).toMatchObject({ platform: "limitless", proposed_winning_outcome_index: 0 });
    expect(p.agreement).toBe("agree");
  });
});
