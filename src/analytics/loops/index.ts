/**
 * Possible-loop detection (deterministic, evidence-based). Every result is labelled
 * "Possible repetitive behaviour": it shows a pattern in the logs, not proof the agent was stuck.
 *
 * Patterns:
 *  A. Cycles: the same sequence of 1-3 tool calls (same tool, same normalized input, same
 *     outcome) repeated back-to-back >= threshold times (2x threshold when nothing failed and
 *     nothing was modified, since that is weak evidence of being stuck).
 *  B. Retry without change: a failing command re-run >= threshold times with no file
 *     modification recorded between consecutive failures.
 */
import type { NormalizedSession, ToolCall } from '../../types.js';
import { isModifyingTool } from '../../parsers/toolinput.js';
import { isTestCommand } from '../../parsers/normalize.js';
import { type DetectionConfig, type Finding, sampleEvidence, spanOf } from '../findings.js';

function tokenOf(c: ToolCall): string {
  return `${c.inputKey}|${c.status === 'error' ? 'error:' + (c.errorSignature ?? '') : c.status}`;
}

function detectCycles(calls: ToolCall[], cfg: DetectionConfig, startId: number): Finding[] {
  const tok = calls.map(tokenOf);
  const out: Finding[] = [];
  let i = 0;
  let n = startId;
  while (i < calls.length) {
    let found: { p: number; reps: number } | undefined;
    for (let p = 1; p <= 3 && !found; p++) {
      if (i + p * cfg.threshold > calls.length) break;
      let reps = 1;
      while (i + (reps + 1) * p <= calls.length) {
        let same = true;
        for (let k = 0; k < p; k++) if (tok[i + k] !== tok[i + reps * p + k]) { same = false; break; }
        if (!same) break;
        reps++;
      }
      // For p > 1, require the cycle to contain distinct steps (otherwise p = 1 covers it).
      if (p > 1 && new Set(tok.slice(i, i + p)).size === 1) continue;
      if (reps < cfg.threshold) continue;
      const cycle = calls.slice(i, i + p);
      const hasError = cycle.some(c => c.status === 'error');
      // A cycle with no failure and no file modification (polling, screenshots, clicking through a UI,
      // re-reading) is weak evidence of being stuck, so it needs twice the repetitions.
      const noErrorNoChange = !hasError && cycle.every(c => !isModifyingTool(c.name) && !c.modifiedPaths?.length);
      if (noErrorNoChange && reps < cfg.threshold * 2) continue;
      found = { p, reps };
    }
    if (!found) { i++; continue; }
    const { p, reps } = found;
    const involved = calls.slice(i, i + p * reps);
    const cycle = calls.slice(i, i + p);
    const hasError = cycle.some(c => c.status === 'error');
    out.push({
      id: `L${++n}`, kind: 'possible-loop', label: 'Possible repetitive behaviour',
      title: p === 1 ? `Same ${cycle[0].name} call repeated ${reps} times in a row` : `A ${p}-step sequence repeated ${reps} times`,
      basis: 'heuristic', severity: hasError ? 'high' : 'medium',
      subject: cycle.map(c => (c.inputSummary === c.name ? c.name : `${c.name}: ${c.inputSummary}`)).join(' → '),
      occurrences: reps, failures: involved.filter(c => c.status === 'error').length,
      ...spanOf(involved), tools: [...new Set(cycle.map(c => c.name))],
      evidence: sampleEvidence(involved, cfg),
      why: `The same ${p === 1 ? 'call' : `${p}-call sequence`} (identical tool, normalized input and outcome${hasError ? ', including the same error' : ''}) ` +
        `occurred ${reps} times consecutively, with no different tool call in between. The logs show no visible progress between repetitions.`,
      recommendation: hasError
        ? 'Repeating the same failing step is unlikely to succeed; check the error and change approach.'
        : 'Check whether these repetitions were needed (e.g. polling) or redundant.',
    });
    i += p * reps;
  }
  return out;
}

function detectRetryWithoutChange(s: NormalizedSession, cfg: DetectionConfig, startId: number): Finding[] {
  const calls = s.toolCalls;
  const out: Finding[] = [];
  let n = startId;
  const byCmd = new Map<string, ToolCall[]>();
  for (const c of calls) if (c.command && c.status === 'error') byCmd.set(c.command, [...(byCmd.get(c.command) ?? []), c]);
  for (const [cmd, failed] of byCmd) {
    if (failed.length < cfg.threshold) continue;
    // Longest chain of consecutive failures with no successful file modification in between.
    let best: ToolCall[] = [];
    let cur: ToolCall[] = [failed[0]];
    for (let k = 1; k < failed.length; k++) {
      const from = failed[k - 1].timestamp?.getTime() ?? 0; const to = failed[k].timestamp?.getTime() ?? 0;
      const changed = calls.some(c => isModifyingTool(c.name) && c.status !== 'error' && (c.timestamp?.getTime() ?? 0) > from && (c.timestamp?.getTime() ?? 0) < to);
      if (changed) { if (cur.length > best.length) best = cur; cur = [failed[k]]; } else cur.push(failed[k]);
    }
    if (cur.length > best.length) best = cur;
    if (best.length < cfg.threshold) continue;
    const test = isTestCommand(cmd);
    out.push({
      id: `L${++n}`, kind: 'possible-loop', label: 'Possible repetitive behaviour',
      title: test ? 'Failing test re-run without code changes' : 'Failing command re-run without file changes',
      basis: 'heuristic', severity: 'high', subject: best[0].inputSummary,
      occurrences: best.length, failures: best.length, modificationsBetween: 0, ...spanOf(best),
      tools: [...new Set(best.map(c => c.name))], evidence: sampleEvidence(best, cfg),
      why: `${best.length} consecutive failed runs of the same command with no Edit/Write/patch recorded between them. ` +
        'Changes made outside the agent\'s tools (or via shell commands) are not visible in the logs.',
      recommendation: test
        ? 'Inspect the original failure before retrying the same test again.'
        : 'Inspect the original failure before retrying the same command again.',
    });
  }
  return out;
}

export function detectLoops(s: NormalizedSession, cfg: DetectionConfig): Finding[] {
  const main = s.toolCalls.filter(c => !c.subagent);
  const sub = s.toolCalls.filter(c => c.subagent);
  const a = detectCycles(main, cfg, 0);
  const b = detectCycles(sub, cfg, a.length).map(f => ({ ...f, title: f.title + ' (subagent)' }));
  const c = detectRetryWithoutChange(s, cfg, a.length + b.length);
  return [...a, ...b, ...c];
}
