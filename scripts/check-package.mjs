#!/usr/bin/env node
/**
 * Verify what `npm pack` would publish, and optionally install the tarball into a temporary
 * project and run the CLI from it (--install). Exits non-zero on any problem.
 * Runs against synthetic fixtures only; never touches real session logs.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32', ...opts });
const problems = [];

const [pack] = JSON.parse(run(npm, ['pack', '--dry-run', '--json', '--ignore-scripts']));
const files = pack.files.map(f => f.path.replace(/\\/g, '/'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const required = ['package.json', 'README.md', 'LICENSE', pkg.bin?.agenttrace?.replace(/^\.\//, '')];
for (const r of required) if (!r || !files.includes(r)) problems.push(`missing from package: ${r}`);

const forbidden = [/^src\//, /^tests\//, /^scripts\//, /^examples\//, /^\.github\//, /node_modules\//, /\.jsonl(\.zst)?$/, /(^|\/)\.env/, /\.pem$|\.key$/, /agenttrace-report-.*\.html$/, /summaries\.json$/, /\.tgz$/];
for (const f of files) if (forbidden.some(re => re.test(f))) problems.push(`must not be published: ${f}`);
for (const f of files) if (!/^dist\//.test(f) && !['package.json', 'README.md', 'LICENSE'].includes(f)) problems.push(`unexpected file: ${f}`);

const binFile = path.join(root, pkg.bin.agenttrace);
if (!fs.existsSync(binFile)) problems.push(`bin target not built: ${pkg.bin.agenttrace} (run npm run build)`);
else if (!fs.readFileSync(binFile, 'utf8').startsWith('#!/usr/bin/env node')) problems.push('bin target lacks "#!/usr/bin/env node"');
if (pack.unpackedSize > 1_000_000) problems.push(`unpacked size unexpectedly large: ${pack.unpackedSize} bytes`);

console.log(`${pack.name}@${pack.version}: ${files.length} files, ${(pack.size / 1024).toFixed(1)} kB packed, ${(pack.unpackedSize / 1024).toFixed(1)} kB unpacked`);
if (process.argv.includes('--list')) for (const f of files) console.log(`  ${f}`);

if (process.argv.includes('--install') && !problems.length) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttrace-pack-'));
  try {
    const tgzName = run(npm, ['pack', '--pack-destination', tmp, '--silent']).trim().split('\n').pop();
    const tgz = path.join(tmp, tgzName);
    const proj = path.join(tmp, 'project');
    fs.mkdirSync(proj);
    fs.writeFileSync(path.join(proj, 'package.json'), '{"name":"agenttrace-smoke","private":true}');
    run(npm, ['install', '--no-audit', '--no-fund', '--silent', tgz], { cwd: proj });
    const bin = path.join(proj, 'node_modules', '.bin', process.platform === 'win32' ? 'agenttrace.cmd' : 'agenttrace');
    const env = { ...process.env, AGENTTRACE_CACHE_DIR: path.join(tmp, 'cache') };
    const fx = path.join(root, 'tests', 'fixtures');
    const cli = (...a) => run(bin, a, { cwd: proj, env });
    const v = cli('--version').trim();
    if (v !== pkg.version) problems.push(`installed CLI reports version ${v}, expected ${pkg.version}`);
    const all = JSON.parse(cli('--claude-dir', path.join(fx, 'claude'), '--codex-dir', path.join(fx, 'codex'), 'analyze', '--all', '--json'));
    if (!(all.sessions.length >= 5)) problems.push(`installed CLI analyzed ${all.sessions.length} fixture sessions`);
    const out = path.join(tmp, 'r.html');
    cli('--claude-dir', path.join(fx, 'claude'), '--codex-dir', path.join(fx, 'codex'), 'report', '--session', '11111111', '--out', out);
    if (!fs.readFileSync(out, 'utf8').includes('AgentTrace session report')) problems.push('installed CLI produced no report');
    cli('cache', 'clear');
    console.log(`installed ${tgzName} in a temp project: --version, analyze --all, report, cache clear OK`);
  } catch (e) {
    problems.push(`install smoke test failed: ${e.message}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (problems.length) { for (const p of problems) console.error(`✗ ${p}`); process.exit(1); }
console.log('✓ package contents OK');
