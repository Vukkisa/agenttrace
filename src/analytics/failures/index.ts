/**
 * Repeated-failure detection. Deterministic grouping only; no LLM.
 * Counts are facts from the logs; recommendations are generic guidance, not claims about intent.
 */
import type { NormalizedSession, ToolCall } from '../../types.js';
import { isTestCommand } from '../../parsers/normalize.js';
import { isModifyingTool } from '../../parsers/toolinput.js';
import { type DetectionConfig, type Finding, sampleEvidence, spanOf } from '../findings.js';

function t(c: ToolCall): number { return c.timestamp?.getTime() ?? 0; }

function modificationsBetween(all: ToolCall[], from: number, to: number): number {
  return all.filter(c => isModifyingTool(c.name) && c.status !== 'error' && t(c) > from && t(c) < to).length;
}

function groupBy<K>(items: ToolCall[], key: (c: ToolCall) => K | undefined): Map<K, ToolCall[]> {
  const m = new Map<K, ToolCall[]>();
  for (const c of items) {
    const k = key(c);
    if (k === undefined) continue;
    const arr = m.get(k) ?? [];
    arr.push(c);
    m.set(k, arr);
  }
  return m;
}

/** The largest set of calls that all fall inside one window of `windowMs` (sliding window over time). */
export function densestWindow(group: ToolCall[], windowMs: number): ToolCall[] {
  const sorted = [...group].sort((a, b) => t(a) - t(b));
  let best: ToolCall[] = [];
  for (let i = 0, j = 0; j < sorted.length; j++) {
    while (t(sorted[j]) - t(sorted[i]) > windowMs) i++;
    if (j - i + 1 > best.length) best = sorted.slice(i, j + 1);
  }
  return best;
}

export function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  const na = a.replace(/\\/g, '/'); const nb = b.replace(/\\/g, '/');
  return na.endsWith('/' + nb.replace(/^\.\//, '')) || nb.endsWith('/' + na.replace(/^\.\//, ''));
}

export function detectFailures(s: NormalizedSession, cfg: DetectionConfig): Finding[] {
  const calls = s.toolCalls;
  const findings: Finding[] = [];
  const covered = new Set<ToolCall>();
  let n = 0;
  const id = () => `F${++n}`;

  // 1. Same command failing repeatedly (tests reported separately).
  for (const [cmd, group] of groupBy(calls, c => c.command)) {
    const failed = group.filter(c => c.status === 'error');
    if (failed.length < cfg.threshold) continue;
    failed.forEach(c => covered.add(c));
    const lastFail = t(failed[failed.length - 1]);
    const eventuallySucceeded = group.some(c => c.status === 'success' && t(c) > lastFail);
    const mods = modificationsBetween(calls, t(failed[0]), lastFail);
    const test = isTestCommand(cmd);
    findings.push({
      id: id(), kind: test ? 'repeated-failed-test' : 'repeated-failed-command',
      label: 'REPEATED FAILURE DETECTED',
      title: test ? 'Same test command failed repeatedly' : 'Same command failed repeatedly',
      basis: 'measured', severity: failed.length >= cfg.threshold * 2 || mods === 0 ? 'high' : 'medium',
      subject: group[0].inputSummary, occurrences: group.length, failures: failed.length, eventuallySucceeded,
      modificationsBetween: mods, ...spanOf(failed), tools: [...new Set(group.map(c => c.name))],
      evidence: sampleEvidence(failed, cfg),
      why: `The normalized command ran ${group.length} time(s) and returned an error ${failed.length} time(s)` +
        (mods === 0 ? '; no file modifications were recorded between the first and last failure.' : `; ${mods} file modification(s) were recorded in between.`),
      recommendation: test
        ? 'Inspect the original test failure output before re-running the same test again.'
        : 'Inspect the first failure and change the inputs or environment before retrying the same command.',
    });
  }

  // 2. Identical non-command tool calls that error repeatedly (same tool + identical input).
  for (const [, group] of groupBy(calls.filter(c => !c.command), c => c.inputKey)) {
    const failed = group.filter(c => c.status === 'error');
    if (failed.length < cfg.threshold) continue;
    failed.forEach(c => covered.add(c));
    const sigs = new Set(failed.map(c => c.errorSignature));
    findings.push({
      id: id(), kind: 'identical-failed-retry', label: 'REPEATED FAILURE DETECTED',
      title: `Identical ${group[0].name} call failed repeatedly`,
      basis: 'measured', severity: 'medium',
      subject: group[0].inputSummary === group[0].name ? group[0].name : `${group[0].name}: ${group[0].inputSummary}`,
      occurrences: group.length, failures: failed.length,
      eventuallySucceeded: group.some(c => c.status === 'success' && t(c) > t(failed[failed.length - 1])),
      ...spanOf(failed), tools: [group[0].name], evidence: sampleEvidence(failed, cfg),
      why: `The same tool was called with byte-identical input ${group.length} time(s); ${failed.length} returned errors` +
        (sigs.size === 1 ? ' with the same normalized error.' : '.'),
      recommendation: 'Retrying an identical call rarely changes the result. Check what the error says before repeating it.',
    });
  }

  // 3. Repeated permission / approval errors, within a short window. Denials spread over days or
  // weeks are separate events, not repetition, so only a burst inside the window counts.
  for (const [tool, group] of groupBy(calls.filter(c => c.status === 'error' && c.errorClass === 'permission'), c => c.name)) {
    if (group.length < cfg.threshold) continue;
    const burst = densestWindow(group, cfg.similarErrorWindowMs);
    if (burst.length < cfg.threshold) continue;
    findings.push({
      id: id(), kind: 'repeated-permission-error', label: 'REPEATED FAILURE DETECTED',
      title: `Repeated permission or approval errors (${tool})`, basis: 'measured', severity: 'medium',
      subject: tool, occurrences: burst.length, failures: burst.length, ...spanOf(burst), tools: [tool],
      evidence: sampleEvidence(burst, cfg),
      why: `${burst.length} ${tool} calls failed with permission, sandbox or user-denial errors within ${Math.round(cfg.similarErrorWindowMs / 60000)} minutes.`,
      recommendation: 'Adjust permissions/sandbox settings or the approach, rather than retrying calls that will be denied.',
    });
  }

  // 4. Similar errors (same normalized signature) within a short window, across different inputs.
  for (const [sig, group] of groupBy(calls.filter(c => c.status === 'error'), c => c.errorSignature)) {
    if (group.length < cfg.threshold || !sig) continue;
    if (new Set(group.map(c => c.inputKey)).size < 2) continue; // identical inputs already handled
    if (group.every(c => covered.has(c))) continue;
    const best = densestWindow(group, cfg.similarErrorWindowMs);
    if (best.length < cfg.threshold) continue;
    findings.push({
      id: id(), kind: 'similar-errors', label: 'REPEATED FAILURE DETECTED',
      title: 'Similar errors repeated within a short period', basis: 'heuristic', severity: 'low',
      // The signature is derived from tool output, so it is only shown when the user opts in.
      subject: cfg.includeErrorSnippets ? sig.slice(0, 120) : `${best[0].errorClass ?? 'other'} errors from ${[...new Set(best.map(c => c.name))].join(', ')}`,
      occurrences: best.length, failures: best.length, ...spanOf(best),
      tools: [...new Set(best.map(c => c.name))], evidence: sampleEvidence(best, cfg),
      why: `${best.length} errors with the same normalized message (numbers, paths and IDs removed) occurred within ${Math.round(cfg.similarErrorWindowMs / 60000)} minutes, across different inputs.`,
      recommendation: 'A recurring error across different attempts often has one root cause; address it directly.',
    });
  }

  // 5. Re-reading the same unchanged file (same read input, no modification of that path in between).
  const reads = calls.filter(c => c.readPaths?.length && c.status === 'success');
  const compactions = s.boundaries.filter(b => b.kind === 'compaction').map(b => b.timestamp.getTime());
  for (const [, group] of groupBy(reads, c => c.inputKey)) {
    if (group.length < cfg.threshold) continue;
    // Split reads into segments separated by a modification of the file or a context
    // compaction; only reads of the same unchanged content count against each other.
    const p = group[0].readPaths![0];
    let redundant: ToolCall[] = [];
    let seg: ToolCall[] = [group[0]];
    for (let i = 1; i < group.length; i++) {
      const from = t(group[i - 1]); const to = t(group[i]);
      const modified = calls.some(c => c.modifiedPaths?.some(mp => samePath(mp, p)) && t(c) > from && t(c) < to);
      const compacted = compactions.some(ct => ct > from && ct < to);
      if (modified || compacted) { if (seg.length > redundant.length) redundant = seg; seg = [group[i]]; }
      else seg.push(group[i]);
    }
    if (seg.length > redundant.length) redundant = seg;
    if (redundant.length < cfg.threshold) continue;
    findings.push({
      id: id(), kind: 'repeated-read', label: 'Repeated operation', title: 'Same file read repeatedly without changes',
      basis: 'heuristic', severity: 'low', subject: group[0].inputSummary, occurrences: group.length, failures: 0,
      ...spanOf(redundant), tools: [group[0].name], evidence: sampleEvidence(redundant, cfg),
      why: `${redundant.length} identical reads of this file with no recorded modification of it (and no context compaction) between them` +
        (group.length > redundant.length ? `; ${group.length - redundant.length} other read(s) followed a change and are not counted.` : '.'),
      recommendation: 'This may be legitimate (e.g. re-checking after a subagent or external change). If not, it is redundant context usage.',
    });
  }

  return findings;
}
