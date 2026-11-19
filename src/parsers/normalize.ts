/**
 * Deterministic normalization used to compare tool calls and errors.
 * Shared by both parsers so the same command is keyed the same way for both agents.
 */
import { redact, truncate } from '../privacy/redact.js';

/** Stable JSON stringify (sorted keys) for identical-input comparison. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}';
  }
  return JSON.stringify(v) ?? 'null';
}

/**
 * Normalize a shell command for grouping:
 * - collapse whitespace
 * - drop leading `cd <dir> &&` prefixes
 * - drop trailing output plumbing (`2>&1`, `| tail -n 20`, `| head -50`, `| grep ...` is kept)
 */
export function normalizeCommand(cmd: string): string {
  let c = cmd.replace(/\s+/g, ' ').trim();
  // unwrap bash -lc "..."
  const wrap = c.match(/^(?:ba|z)?sh -l?c ['"](.*)['"]$/);
  if (wrap) c = wrap[1].trim();
  for (let i = 0; i < 3; i++) c = c.replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*/, '');
  for (let i = 0; i < 3; i++) {
    c = c
      .replace(/\s*2>&1\s*$/, '')
      .replace(/\s*\|\s*(tail|head)(\s+-n)?\s*-?\d*\s*$/, '')
      .replace(/\s*2>\/dev\/null\s*$/, '')
      .trim();
  }
  return c;
}

const TEST_RE = /(^|[\s;&|(])(pytest|py\.test|python3? -m (pytest|unittest)|jest|vitest|mocha|ava|tap|npm( run)? test|yarn( run)? test|pnpm( run)? test|bun test|deno test|go test|cargo (test|nextest)|mvn( \S+)* test|gradlew? (\S+ )*test|dotnet test|rspec|phpunit|mix test|ctest|playwright test|cypress run|tox|nox|make (test|check))(\s|$)/;

export function isTestCommand(cmd: string): boolean {
  return TEST_RE.test(cmd);
}

/** Build a grouping signature for an error text: strip volatile parts. */
export function errorSignature(text: string): string {
  const firstLines = text.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 3).join(' | ');
  return firstLines
    .replace(/(\/[\w.@\-]+)+\/?/g, '<path>')
    .replace(/[A-Za-z]:\\[^\s]+/g, '<path>')
    .replace(/0x[0-9a-f]+/gi, '<hex>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\d+(\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .slice(0, 160)
    .toLowerCase();
}

export function classifyError(text: string, exitCode?: number): string {
  const t = text.toLowerCase();
  if (/permission denied|eacces|operation not permitted|eperm|not allowed|requires approval|user (rejected|denied)|denied by|sandbox|doesn't want to proceed|permission to use/.test(t)) return 'permission';
  if (/no such file|enoent|not found|cannot find|could not find|does not exist/.test(t)) return 'not-found';
  if (/timed? ?out|etimedout|deadline exceeded/.test(t)) return 'timeout';
  if (/syntaxerror|parse error|unexpected token/.test(t)) return 'syntax';
  if (/\b(failed|failures?|assertionerror|assert)\b/.test(t) && /test|spec|assert/.test(t)) return 'test-failure';
  if (/file has not been read yet|modified since read|old_string|string to replace not found|no changes|not unique/.test(t)) return 'edit-mismatch';
  if (exitCode !== undefined && exitCode !== 0) return 'exit-code';
  return 'other';
}

export function errorSnippet(text: string): string {
  const line = text.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? '';
  return truncate(redact(line), 160);
}

/** Pull file paths out of an apply_patch body. */
export function patchPaths(patch: string): string[] {
  const out = new Set<string>();
  const re = /^\*\*\* (?:Update|Add|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(patch))) out.add((m[1] ?? m[2]).trim());
  return [...out];
}

/** Exit code reported inside a tool output string, if any. */
export function exitCodeFromText(text: string): number | undefined {
  const m = text.match(/(?:exit code|exited with code|process exited with code)[:\s]+(-?\d+)/i);
  return m ? Number(m[1]) : undefined;
}
