/**
 * The client side of Engine.IO v4 / Socket.IO v5 text framing, only as much as the Limitless lifecycle listener needs
 * (src/jobs/limitless-ws.ts). Pure: no I/O, no clock. Frames as ws.limitless.exchange sent them to a read-only capture
 * from the founder's machine on 2026-09-28 (Node's built-in WebSocket, 8 minutes, no authentication):
 *
 *   <- 0{"sid":"…","upgrades":[],"pingInterval":25000,"pingTimeout":60000,"maxPayload":1000000}   Engine.IO open
 *   -> 40/markets,                                                                                  namespace connect
 *   <- 40/markets,{"sid":"…"}                                                                       namespace accepted
 *   -> 42/markets,["subscribe_market_lifecycle"]                                                    event emit
 *   <- 42/markets,["system",{"message":"Successfully registered connection"}]
 *   <- 42/markets,["system",{"message":"Subscribed to market lifecycle events"}]
 *   <- 2                                                       server ping, every pingInterval (25 s)
 *   -> 3                                                       client pong
 *   <- 42/markets,["marketCreated",{"slug":…,"title":…,"type":"CLOB","categoryIds":[…],"createdAt":"…Z"}]
 *   <- 42/markets,["marketResolved",{"slug":…,"type":"CLOB","winningOutcome":"NO","winningIndex":1,"resolutionDate":"…Z"}]
 *
 * The handshake URL is https://ws.limitless.exchange/socket.io/?EIO=4&transport=websocket (the path Limitless's own
 * docs sign for authenticated channels; the lifecycle channel needs no authentication). A subscribe emitted with an
 * ack id got no ack packet in the capture, only the "Subscribed to …" system event. Binary packets (Socket.IO types 5
 * and 6) never appear on this channel and parse as unsupported.
 */

export type SocketPacket =
  | { type: "connect"; nsp: string; sid: string | null }
  | { type: "disconnect"; nsp: string }
  | { type: "event"; nsp: string; id: number | null; name: string; args: unknown[] }
  | { type: "ack"; nsp: string; id: number; args: unknown[] }
  | { type: "connect_error"; nsp: string; message: string };

export type EngineFrame =
  | { kind: "open"; sid: string; pingInterval: number; pingTimeout: number }
  | { kind: "close" }
  | { kind: "ping"; data: string }
  | { kind: "pong"; data: string }
  | { kind: "noop" }
  | { kind: "message"; packet: SocketPacket }
  /** Anything else: a binary frame, an unknown type, a payload that is not the JSON its type needs. Never thrown. */
  | { kind: "invalid"; reason: string };

const invalid = (reason: string): EngineFrame => ({ kind: "invalid", reason });
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** Engine.IO timers are milliseconds; anything outside 1 s .. 10 min is not a timer this client should trust. */
const timer = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 1000 && v <= 600_000 ? v : null);

/** Pure. One websocket message (a string, or anything the runtime handed over) -> what it is. */
export function parseFrame(raw: unknown): EngineFrame {
  if (typeof raw !== "string") return invalid("binary frame");
  if (!raw.length) return invalid("empty frame");
  const body = raw.slice(1);
  switch (raw[0]) {
    case "0": {
      let o: unknown;
      try { o = JSON.parse(body); } catch { return invalid("open packet is not JSON"); }
      if (!isObject(o) || typeof o.sid !== "string" || !o.sid) return invalid("open packet has no sid");
      const pingInterval = timer(o.pingInterval), pingTimeout = timer(o.pingTimeout);
      if (pingInterval === null || pingTimeout === null) return invalid("open packet has no usable pingInterval/pingTimeout");
      return { kind: "open", sid: o.sid, pingInterval, pingTimeout };
    }
    case "1": return { kind: "close" };
    case "2": return { kind: "ping", data: body };
    case "3": return { kind: "pong", data: body };
    case "4": {
      const p = parsePacket(body);
      return typeof p === "string" ? invalid(p) : { kind: "message", packet: p };
    }
    case "6": return { kind: "noop" };
    default: return invalid(`engine packet type ${JSON.stringify(raw[0])}`);
  }
}

/** Pure. A Socket.IO v5 packet: <type>[<namespace>,][<ack id>][<JSON>]; a string is why it is not one. */
export function parsePacket(s: string): SocketPacket | string {
  const type = s[0];
  if (type === "5" || type === "6") return "binary socket.io packet";
  if (type === undefined || !"01234".includes(type)) return `socket.io packet type ${JSON.stringify(type ?? "")}`;
  let i = 1;
  let nsp = "/";
  if (s[i] === "/") {
    const comma = s.indexOf(",", i);
    nsp = comma === -1 ? s.slice(i) : s.slice(i, comma);
    i = comma === -1 ? s.length : comma + 1;
  }
  let digits = "";
  while (i < s.length && s[i]! >= "0" && s[i]! <= "9") digits += s[i++];
  if (digits.length > 15) return "ack id too long";
  const id = digits ? Number(digits) : null;
  const text = s.slice(i);
  let data: unknown = undefined;
  if (text) {
    try { data = JSON.parse(text); } catch { return "payload is not JSON"; }
  }
  switch (type) {
    case "0": return { type: "connect", nsp, sid: isObject(data) && typeof data.sid === "string" ? data.sid : null };
    case "1": return { type: "disconnect", nsp };
    case "2": {
      if (!Array.isArray(data) || typeof data[0] !== "string") return "event payload is not [name, ...args]";
      return { type: "event", nsp, id, name: data[0], args: data.slice(1) };
    }
    case "3": {
      if (id === null || !Array.isArray(data)) return "ack without an id or an args array";
      return { type: "ack", nsp, id, args: data };
    }
    default: {
      const message = isObject(data) && typeof data.message === "string" ? data.message : typeof data === "string" ? data : JSON.stringify(data ?? null);
      return { type: "connect_error", nsp, message: message.slice(0, 300) };
    }
  }
}

/** The namespace connect a client sends after the Engine.IO open packet. */
export const namespaceConnect = (nsp: string): string => `40${nsp},`;
/** An event emit without an ack id. */
export const emitFrame = (nsp: string, name: string, ...args: unknown[]): string => `42${nsp},${JSON.stringify([name, ...args])}`;
/** The answer to a server ping (Engine.IO v4: the server pings, the client pongs with the same data). */
export const pongFrame = (data = ""): string => `3${data}`;
