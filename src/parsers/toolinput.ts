import crypto from 'node:crypto';
import { safeSummary } from '../privacy/redact.js';
import { normalizeCommand, patchPaths, stableStringify } from './normalize.js';
import { isObj, str } from './jsonl.js';

export interface DescribedInput {
  inputKey: string;
  inputSummary: string;
  command?: string;
  readPaths?: string[];
  modifiedPaths?: string[];
}

const hash = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

const READ_TOOLS = new Set(['Read', 'read_file', 'view_image', 'NotebookRead']);
const MODIFY_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch', 'write_file', 'edit_file']);
const SHELL_TOOLS = new Set(['Bash', 'shell', 'exec_command', 'local_shell', 'container.exec', 'shell_command', 'unified_exec']);

export function isModifyingTool(name: string): boolean {
  return MODIFY_TOOLS.has(name);
}

/** Extract a shell command string from the various argument shapes agents use. */
export function commandFromInput(input: Record<string, unknown>): string | undefined {
  const c = input.command ?? input.cmd;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.every(x => typeof x === 'string')) {
    const arr = c as string[];
    // ["bash","-lc","<script>"] -> script
    if (arr.length >= 3 && /^(ba|z)?sh$/.test(arr[0].split('/').pop() ?? '') && /^-l?c$/.test(arr[1])) return arr.slice(2).join(' ');
    return arr.join(' ');
  }
  return undefined;
}

/**
 * Describe a tool call input without retaining its content.
 * Only commands, paths, URLs and search patterns are surfaced (redacted, truncated).
 */
export function describeInput(name: string, rawInput: unknown): DescribedInput {
  const input = isObj(rawInput) ? rawInput : {};
  const keyBase = name + ':' + hash(typeof rawInput === 'string' ? rawInput : stableStringify(rawInput ?? null));

  if (SHELL_TOOLS.has(name) || (commandFromInput(input) && !MODIFY_TOOLS.has(name))) {
    const cmd = commandFromInput(input);
    if (cmd) {
      const norm = normalizeCommand(cmd);
      return { inputKey: name + ':cmd:' + norm, inputSummary: safeSummary(norm), command: norm };
    }
  }

  const path = str(input.file_path) ?? str(input.path) ?? str(input.notebook_path);
  if (READ_TOOLS.has(name) && path) {
    return { inputKey: keyBase, inputSummary: safeSummary(path), readPaths: [path] };
  }
  if (MODIFY_TOOLS.has(name)) {
    if (path) return { inputKey: keyBase, inputSummary: safeSummary(path), modifiedPaths: [path] };
    const patch = typeof rawInput === 'string' ? rawInput : str(input.input) ?? str(input.patch);
    if (patch) {
      const paths = patchPaths(patch);
      return { inputKey: keyBase, inputSummary: safeSummary(paths.join(', ') || 'patch'), modifiedPaths: paths };
    }
    return { inputKey: keyBase, inputSummary: name };
  }
  const url = str(input.url);
  if (url) return { inputKey: keyBase, inputSummary: safeSummary(url) };
  const pattern = str(input.pattern) ?? str(input.query);
  if (pattern) return { inputKey: keyBase, inputSummary: safeSummary(pattern + (path ? ' in ' + path : ''), 120) };
  if (path) return { inputKey: keyBase, inputSummary: safeSummary(path) };
  // Unknown tool: never echo arbitrary inputs (they may contain prompts or code).
  return { inputKey: keyBase, inputSummary: name };
}
