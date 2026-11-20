#!/usr/bin/env node
// Wiki evidence adapter. Runs the repository's real checks at the current commit and writes a
// Jest-compatible JSON report that `observations.py evidence --format jest-json` turns into
// `rsr/test-evidence@1` (the CI job `Wiki Canonical Test Pages` does the conversion).
//
// What counts as a test result here, and nothing else:
//   - each of the checks of `node experiments/verify-local-gates.mjs`, as a case of that file;
//   - each tracked script a check launches (found at run time by scripts/wikiEvidenceTrace.mjs, not
//     guessed from the source), as a case of that script, passing only when its check passed;
//   - each `node <file>` step of the `npm test` script in package.json, run by itself, as one case
//     that passes when the process exits 0.
// A script no check launched and that is not in `npm test` has no case, so a wiki page that links
// only such files stays a stub. The adapter adds no tests and skips none.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATE_FILE = 'experiments/verify-local-gates.mjs';
const argv = process.argv.slice(2);
const option = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const reportPath = resolve(process.cwd(), option('--report', 'wiki-jest-report.json'));
const skipCompile = argv.includes('--skip-compile');

const tracked = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 }).split('\0').filter(Boolean));
const results = new Map(); // tracked file -> [{ ancestorTitles, title, status }]
function record(file, title, passed, ancestorTitles = []) {
  if (!results.has(file)) results.set(file, []);
  results.get(file).push({ ancestorTitles, title, status: passed ? 'passed' : 'failed' });
}
function trackedPath(script) {
  const absolute = resolve(root, script);
  if (!existsSync(absolute)) return null;
  const rel = relative(root, realpathSync(absolute)).split('\\').join('/');
  return tracked.has(rel) ? rel : null;
}

if (!skipCompile) {
  console.log('compile: npm run compile');
  const compiled = spawnSync('npm', ['run', 'compile'], { cwd: root, stdio: 'inherit' });
  if (compiled.status !== 0) {
    console.error('FAIL: npm run compile failed; no evidence was written');
    process.exit(1);
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'lba-wiki-evidence-'));
let failures = 0;
try {
  const tracePath = join(scratch, 'trace.jsonl');
  const receiptPath = join(scratch, 'gates.json');
  writeFileSync(tracePath, '');
  console.log(`gates: node ${GATE_FILE}`);
  const gates = spawnSync(process.execPath, ['--import', join(root, 'scripts', 'wikiEvidenceTrace.mjs'), join(root, GATE_FILE), '--json', '--out', receiptPath], {
    cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, LBA_WIKI_EVIDENCE_TRACE: tracePath }
  });
  if (!existsSync(receiptPath)) {
    console.error(`FAIL: the gate runner wrote no receipt (exit ${gates.status})\n${gates.stderr}`);
    process.exit(1);
  }
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  const passedByCheck = new Map(receipt.results.map((c) => [c.name, c.pass === true]));
  for (const c of receipt.results) record(GATE_FILE, c.name, c.pass === true);
  const launched = new Set();
  for (const line of readFileSync(tracePath, 'utf8').split('\n').filter(Boolean)) {
    const { check, script } = JSON.parse(line);
    const file = trackedPath(script);
    if (!file || !passedByCheck.has(check) || launched.has(`${file}\0${check}`)) continue;
    launched.add(`${file}\0${check}`);
    record(file, check, passedByCheck.get(check), ['verify-local-gates']);
  }
  console.log(`gates: ${receipt.passed}/${receipt.total} checks passed; ${launched.size} script launches attributed to a check`);
  failures += receipt.failed;

  const steps = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts.test.split('&&').map((s) => s.trim());
  for (const step of steps) {
    const match = /^node\s+(\S+\.m?js)((?:\s+\S+)*)$/.exec(step);
    if (!match) continue;
    const file = trackedPath(match[1]);
    if (!file) continue;
    console.log(`test: ${step}`);
    const run = spawnSync(process.execPath, [file, ...match[2].trim().split(/\s+/).filter(Boolean)], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
    const passed = run.status === 0;
    if (!passed) {
      failures += 1;
      console.error(`FAIL: ${step} exited ${run.status}`);
    }
    record(file, `${step} exits 0`, passed, ['npm test']);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const testResults = [...results].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, assertionResults]) => ({
  name,
  status: assertionResults.every((a) => a.status === 'passed') ? 'passed' : 'failed',
  assertionResults
}));
writeFileSync(reportPath, `${JSON.stringify({ testResults }, null, 2)}\n`);
const cases = testResults.reduce((n, r) => n + r.assertionResults.length, 0);
console.log(`${failures === 0 ? 'PASS' : 'FAIL'}: wrote ${cases} cases over ${testResults.length} files to ${reportPath}`);
process.exit(failures === 0 ? 0 : 1);
