/** GET /v1/track-record/verify response shaping: nothing that reveals the verdict before the reveal row exists. */
import { describe, expect, it } from "vitest";
import { shapeVerify, type VerifyCommit } from "../src/api/public";
import { buildPreimage, buildReveal, type CommittedVerdict } from "../src/bot/commit";
import { sha256Hex } from "../src/resolve/text";

const fields = { resolution_status: "RESOLVED", winning_outcome: "OPTION_A", confidence_score: 0.95, caveats: [], canonical_sha256: "c".repeat(64), raw_sha256: "d".repeat(64), thresholds_version: "v1", determination_basis: "structured" } as const;
const NONCE = "feedfacefeedfacefeedface";
const preimage = buildPreimage("polymarket:123", { ...fields, caveats: [] }, NONCE);
const committed: CommittedVerdict = { preimage_version: "v2", preimage, ...fields, caveats: [] };

async function commit(): Promise<VerifyCommit> {
  return { id: "c1", commitment_sha256: await sha256Hex(preimage), nonce: NONCE, created_at: "2026-10-01T00:00:00.000Z", channel: "telegram", message_id: 11, telegram_date: "2026-10-01T00:00:01.000Z", markets: { platform: "polymarket", external_id: "123" } };
}

describe("shapeVerify", () => {
  it("before the reveal: recorded and posted, never the nonce, preimage or verdict", async () => {
    const c = await commit();
    const out = shapeVerify(c, null);
    expect(out).toEqual({ commitment_sha256: c.commitment_sha256, market: "polymarket:123", committed_at: c.created_at, posted: true, posted_at: c.telegram_date, message_id: 11, revealed: false });
    const s = JSON.stringify(out);
    expect(s).not.toContain(NONCE);
    expect(s).not.toContain("OPTION_A");
    expect(shapeVerify({ ...c, channel: "pending", message_id: null, telegram_date: null }, null)).toMatchObject({ posted: false, posted_at: null });
  });

  it("after the reveal: everything needed to recompute the commitment", async () => {
    const c = await commit();
    const { payload } = buildReveal({ platform: "polymarket", external_id: "123" }, c, committed, { outcome: "OPTION_A", label: "Yes", at: "2026-10-03T00:00:00.000Z", at_source: "gamma_closed_time", source_url: "https://polymarket.com/event/x" }, "agree");
    const out = shapeVerify(c, { channel: "pending", message_id: null, telegram_date: null, payload });
    expect(out).toMatchObject({ revealed: true, reveal_posted: false, preimage_version: "v2", preimage, nonce: NONCE, agreement: "agree", official: { outcome: "OPTION_A", label: "Yes", at_source: "gamma_closed_time" }, committed: { resolution_status: "RESOLVED", winning_outcome: "OPTION_A", confidence_score: 0.95 } });
    expect(await sha256Hex(String(out.preimage))).toBe(out.commitment_sha256);
    expect(String(out.preimage).endsWith(`|${out.nonce}`)).toBe(true);
  });
});
