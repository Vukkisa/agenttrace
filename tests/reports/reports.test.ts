import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseClaudeSession } from '../../src/parsers/claude/index.js';
import { parseCodexSession } from '../../src/parsers/codex/index.js';
import { analyzeSession } from '../../src/analytics/analyze.js';
import { loadPricing } from '../../src/pricing/index.js';
import { renderSessionHtml, esc } from '../../src/reports/html.js';
import { renderSessionText } from '../../src/reports/text.js';

const FX = path.join(__dirname, '..', 'fixtures');
const CLAUDE_MAIN = path.join(FX, 'claude/projects/-home-dev-demo-app/11111111-1111-4111-8111-111111111111.jsonl');
const CODEX = path.join(FX, 'codex/sessions/2026/11/19/rollout-2026-11-19T12-00-00-0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee.jsonl');
const pricing = loadPricing({ useUserFile: false });

describe('HTML report', () => {
  it('is self-contained, offline and contains the key sections', async () => {
    const a = analyzeSession(await parseClaudeSession('1111', CLAUDE_MAIN, []), pricing);
    const html = renderSessionHtml(a);
    for (const h of ['Session overview', 'Final diagnosis', 'Token usage', 'Activity timeline', 'Failure analysis', 'Possible repetitive behaviour', 'Cost and time analysis']) {
      expect(html).toContain(h);
    }
    expect(html).not.toMatch(/<script|<link|https?:\/\/(?!www\.w3\.org)/);
    expect(html).toContain('REPEATED FAILURE DETECTED');
    expect(html).toContain('pytest tests/test_auth.py');
    expect(html).toContain('not your actual bill');
  });

  it('never embeds prompts or tool output by default', async () => {
    const a = analyzeSession(await parseClaudeSession('1111', CLAUDE_MAIN, []), pricing);
    const html = renderSessionHtml(a);
    expect(html).not.toContain('Fix the failing login test'); // user prompt
    expect(html).not.toContain('AssertionError'); // tool output
    expect(html).not.toContain('file contents');
  });

  it('escapes HTML in all dynamic values', () => {
    expect(esc('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('renders Codex sessions and the text report', async () => {
    const a = analyzeSession(await parseCodexSession(CODEX), pricing);
    expect(renderSessionHtml(a)).toContain('cumulative totals');
    const txt = renderSessionText(a);
    expect(txt).toContain('REPEATED FAILURE DETECTED');
    expect(txt).toContain('npm test');
  });

  it('matches the committed example report structure', () => {
    const example = path.join(__dirname, '..', '..', 'examples', 'example-report.html');
    if (!fs.existsSync(example)) return;
    expect(fs.readFileSync(example, 'utf8')).toContain('AgentTrace session report');
  });
});
