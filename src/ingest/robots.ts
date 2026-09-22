/** robots.txt rule -> anchored regex: '*' matches any run of characters, a trailing '$' anchors the end. */
export function ruleToRegex(rule: string): RegExp {
  const endAnchored = rule.endsWith("$");
  const raw = endAnchored ? rule.slice(0, -1) : rule;
  const escaped = raw.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp("^" + escaped + (endAnchored ? "$" : ""));
}
