/** Strips credentials from any text that is stored or sent to an operator. */
const PATTERNS: Array<[RegExp, string]> = [
  [/\bapikey_[A-Za-z0-9_-]{8,}/g, "apikey_[redacted]"],
  [/\brsl_(live|test)_[A-Za-z0-9_-]{8,}/g, "rsl_$1_[redacted]"],
  [/\blmts_[A-Za-z0-9_-]{8,}/g, "lmts_[redacted]"],
  [/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}/g, "$1[redacted]"],
  [/\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g, "[telegram-token-redacted]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[jwt-redacted]"],
  [/(https?:\/\/[^\s/]*alchemy\.com\/v2\/)[A-Za-z0-9_-]+/gi, "$1[redacted]"],
  [/((?:^|[?&\s;,])(?:api[-_]?key|key|token|secret|password|access_token)=)[^&\s"',;]+/gi, "$1[redacted]"],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]"],
  [/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/gi, "$1[redacted]@"],
];

export function redact(text: string): string {
  let out = String(text);
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}
