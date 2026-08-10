#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const components = JSON.parse(read('../release-components.json'));
const agents = JSON.parse(read('../extension-agents/agents.manifest.json'));
const stage = read('./stage-local-vsix.ps1');
const installer = read('./bin/guest-install-lbabus.ps1');
const raw = read('./collect-review-raw.ps1');
const cache = read('../experiments/windows-docker-container/reviewer-cache-stage-vsix.ps1');
const proof = read('../experiments/windows-docker-container/vm-vsix-proof.ps1');
const continuation = read('./continuation-readiness.mjs');

assert.match(components.lbabus, /^\d+\.\d+\.\d+$/);
assert.match(components.agents, /^\d+\.\d+\.\d+$/);
assert.equal(agents.version, components.agents);
assert.match(stage, /release-components\.json/);
assert.match(stage, /-ExpectedVersion \$expectedLbabusVersion/);
assert.match(stage, /\[regex\]::Escape\(\$expectedLbabusVersion\)/);
assert.match(installer, /\[Parameter\(Mandatory\)\]\[string\]\$ExpectedVersion/);
assert.match(raw, /release-components\.json/);
assert.match(raw, /version = \$expectedLbabusVersion/);
assert.match(cache, /release-components\.json/);
assert.match(cache, /-ExpectedLbabusVersion \$expectedLbabusVersion/);
assert.match(cache, /\$guestProof\.lbabusVersion -ne \$expectedLbabusVersion/);
assert.match(proof, /\[Parameter\(Mandatory\)\]\[string\]\$ExpectedLbabusVersion/);
assert.match(proof, /\$lbabusVersion -ne \$ExpectedLbabusVersion/);
assert.match(continuation, /EXPECTED_LBABUS = RELEASE_COMPONENTS\.lbabus/);
assert.match(continuation, /EXPECTED_AGENTS_VERSION = RELEASE_COMPONENTS\.agents/);
assert.match(continuation, /EXPECTED_AGENTS_SHA256 = AGENTS_MANIFEST\.sha256/);
assert.match(continuation, /selectCloseoutBaseline\(closeout, currentBaseline, historicalBaselines\)/);
assert.doesNotMatch(
  [stage, installer, raw, cache, proof, continuation].join('\n'),
  /0\.15\.8|0\.3\.13|02ce9b7b0f69dca6e0297b07940eafc3ffc90681668d590d472bb24dc2f717a9/,
);

console.log(`reviewer version contract: PASS (lbabus ${components.lbabus}, AGENTS ${components.agents})`);
