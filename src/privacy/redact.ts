/**
 * Secret redaction for anything AgentTrace prints or writes.
 * Conservative: false positives (over-redaction) are acceptable, leaks are not.
 */

const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED_PRIVATE_KEY]'],
  [/\bsk-ant-[A-Za-z0-9_\-]{10,}/g, '[REDACTED_KEY]'],
  [/\bsk-(proj-)?[A-Za-z0-9_\-]{16,}/g, '[REDACTED_KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED_TOKEN]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED_TOKEN]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[REDACTED_TOKEN]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/\bAIza[0-9A-Za-z_\-]{30,}/g, '[REDACTED_KEY]'],
  [/\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g, '[REDACTED_JWT]'],
  [/(authorization:\s*bearer\s+)[^\s'"]+/gi, '$1[REDACTED]'],
  [/(\bbearer\s+)[A-Za-z0-9._\-]{16,}/gi, '$1[REDACTED]'],
  [/((?:api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']?)[^\s'"&]{4,}/gi, '$1[REDACTED]'],
  [/(\/\/[^/\s:@]+:)[^/\s@]+@/g, '$1[REDACTED]@'],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

export function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

/** Redact then truncate to a single line. */
export function safeSummary(text: string, max = 140): string {
  return truncate(redact(text), max);
}
