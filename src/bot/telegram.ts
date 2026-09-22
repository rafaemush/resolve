/** Telegram Bot API client with the OilFlow discipline: throttle, chunk, never throw to the caller. */
import type { Env } from "../env";

const LIMIT = 4096;
let lastSend = 0;

export function telegramConfigured(env: Env): boolean { return !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHANNEL_ID); }

export async function sendMessage(env: Env, text: string, opts: { replyTo?: number | null; chatId?: string } = {}): Promise<{ ok: boolean; message_id: number | null; date: string | null; error?: string }> {
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, message_id: null, date: null, error: "TELEGRAM_BOT_TOKEN unset" };
  const chat = opts.chatId ?? env.TELEGRAM_CHANNEL_ID;
  if (!chat) return { ok: false, message_id: null, date: null, error: "TELEGRAM_CHANNEL_ID unset" };
  const gap = 1200 - (Date.now() - lastSend);
  if (gap > 0) await new Promise((r) => setTimeout(r, gap));
  lastSend = Date.now();
  const body: Record<string, unknown> = { chat_id: chat, text: text.slice(0, LIMIT), disable_web_page_preview: true };
  if (opts.replyTo) body.reply_to_message_id = opts.replyTo;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
      const j = (await res.json()) as { ok: boolean; result?: { message_id: number; date: number }; description?: string; parameters?: { retry_after?: number } };
      if (j.ok && j.result) return { ok: true, message_id: j.result.message_id, date: new Date(j.result.date * 1000).toISOString() };
      if (res.status === 429) { await new Promise((r) => setTimeout(r, Math.min(5000, (j.parameters?.retry_after ?? 2) * 1000))); continue; }
      return { ok: false, message_id: null, date: null, error: j.description ?? `HTTP ${res.status}` };
    } catch (e) { if (attempt === 2) return { ok: false, message_id: null, date: null, error: String(e).slice(0, 200) }; }
  }
  return { ok: false, message_id: null, date: null, error: "retries exhausted" };
}

export async function alertOperator(env: Env, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_OPERATOR_CHAT_ID) { console.error("ALERT (no telegram):", text); return; }
  await sendMessage(env, text, { chatId: env.TELEGRAM_OPERATOR_CHAT_ID });
}
