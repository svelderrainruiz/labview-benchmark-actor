// Preload for scripts/wikiEvidence.mjs (`node --import`): records which scripts each gate of
// experiments/verify-local-gates.mjs runs, without changing the gate file. It wraps
// child_process.execFileSync and attributes each tracked script launched with the node binary to the
// check() callback on the stack. The adapter pairs that with the gate's PASS/FAIL receipt.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const tracePath = process.env.LBA_WIKI_EVIDENCE_TRACE;
if (!tracePath) {
  throw new Error('LBA_WIKI_EVIDENCE_TRACE must name the trace file');
}
const gateFile = fileURLToPath(new URL('../experiments/verify-local-gates.mjs', import.meta.url));
const starts = [];
readFileSync(gateFile, 'utf8').split('\n').forEach((line, index) => {
  const match = /^check\('([^']+)'/.exec(line);
  if (match) starts.push({ line: index + 1, name: match[1] });
});

Error.stackTraceLimit = 100;
const gateFrame = /verify-local-gates\.mjs:(\d+):\d+\)?$/;

function attributedCheck() {
  const frames = new Error().stack.split('\n').slice(1).map((f) => f.trim());
  const outer = frames.findIndex((f) => f.startsWith('at check ') && gateFrame.test(f));
  if (outer < 1) return null;
  // The frame just inside check() is the callback; anything deeper is a helper the callback called.
  const callback = gateFrame.exec(frames[outer - 1]);
  if (!callback) return null;
  const line = Number(callback[1]);
  let owner = null;
  for (const start of starts) if (start.line <= line) owner = start;
  return owner ? owner.name : null;
}

const original = childProcess.execFileSync;
childProcess.execFileSync = function execFileSync(file, args, ...rest) {
  if (file === process.execPath && Array.isArray(args) && typeof args[0] === 'string' && /\.m?js$/.test(args[0])) {
    const check = attributedCheck();
    if (check) appendFileSync(tracePath, `${JSON.stringify({ check, script: args[0] })}\n`);
  }
  return original.call(this, file, args, ...rest);
};
syncBuiltinESMExports();
