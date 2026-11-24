#!/usr/bin/env node
// build-review-target.mjs -- the one place that builds handoff/review-target.json (WHAT is under review). Both
// render-verdict.sh (VirtualBox) and hyperv/render-verdict.ps1 (Hyper-V) call it, so the shape cannot drift.
//
//   node reviewer-workstation/build-review-target.mjs --component extension --version X.Y.Z --commit <sha> \
//        --vsix-sha256 <sha256> [--evidence <kind>:<ref>]...        (prints the JSON, no trailing newline)
import { pathToFileURL } from 'node:url';

// An evidence argument is "<kind>:<ref>"; a ref may contain spaces and colons. Without a kind it is a note.
export function parseEvidence(entries = []) {
  return entries.map((s) => String(s).trim()).filter(Boolean).map((s) => {
    const i = s.indexOf(':');
    return { kind: i > 0 ? s.slice(0, i) : 'note', ref: i > 0 ? s.slice(i + 1) : s };
  });
}

export function buildReviewTarget({ component, version, commit, vsixSha256, evidence = [] } = {}) {
  return { component, version, commit: commit || null, vsixSha256: vsixSha256 || null, evidence: parseEvidence(evidence) };
}

export function parseArgs(argv) {
  const out = { evidence: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key.startsWith('--') || i + 1 >= argv.length) throw new Error(`bad or valueless argument: ${key}`);
    if (key === '--evidence') out.evidence.push(argv[i + 1]);
    else out[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[i + 1];
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const a = parseArgs(process.argv.slice(2));
    process.stdout.write(JSON.stringify(buildReviewTarget(a), null, 2));
  } catch (error) {
    console.error(`build-review-target: ${error.message}`);
    process.exit(2);
  }
}
