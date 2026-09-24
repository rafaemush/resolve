/**
 * markets.event_key (migration 017): the event a market is one leg of. A ladder (24 CPI buckets, a Polymarket event's
 * legs, a Limitless group) resolves from one fact, so the public record counts it once (plan §17.3: "n >= 100 counted by
 * distinct event, not ladder leg") and the channel posts its legs as one message. Pure; the same rule, in the same order,
 * as the SQL market_event_key() that fills rows written without it (tests/event-key.test.ts and scripts/selftest/fixes.ts
 * hold the same cases).
 */
import type { MarketMeta } from "./meta";

export interface EventKeyInput {
  platform: string;
  external_id: string;
  resolver?: { kind: string; series?: unknown; period?: unknown } | null;
  meta?: Pick<MarketMeta, "event_id" | "group_id"> | Record<string, unknown> | null;
}

/** A string (or number) id, trimmed; "" for anything else. SQL: btrim(jsonb ->> key). */
function id(v: unknown): string {
  return typeof v === "string" || typeof v === "number" ? String(v).trim() : "";
}

export function eventKey(m: EventKeyInput): string {
  const r = m.resolver;
  if (r?.kind === "official_release" && id(r.series) && id(r.period)) return `official:${id(r.series)}:${id(r.period)}`;
  const meta = (m.meta ?? {}) as Record<string, unknown>;
  if (m.platform === "polymarket" && id(meta.event_id)) return `polymarket:event:${id(meta.event_id)}`;
  if (m.platform === "limitless" && id(meta.group_id)) return `limitless:group:${id(meta.group_id)}`;
  return `${m.platform}:${m.external_id}`;
}
