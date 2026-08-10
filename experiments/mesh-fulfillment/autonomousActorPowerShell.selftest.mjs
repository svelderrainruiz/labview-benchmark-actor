#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { bundleDigest, canonicalize } from '../acg-provenance/attest.mjs';

const fixture = { z: [3, { b: true, a: null }], a: 'line\nvalue', nested: { two: 2, one: 1 } };
const daemonPath = new URL('./autonomousActorDaemon.ps1', import.meta.url).pathname;
const workloadPath = new URL('./runLabviewKnownAnswer.ps1', import.meta.url).pathname;
const actual = JSON.parse(execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', daemonPath, '-SelfTest'], { encoding: 'utf8' }));

assert.equal(actual.canonical, canonicalize(fixture), 'PowerShell canonical JSON must match attest.mjs');
assert.equal(actual.digest, bundleDigest(fixture), 'PowerShell SHA-256 bundle digest must match attest.mjs');

const daemon = readFileSync(daemonPath, 'utf8');
assert.match(daemon, /C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe/);
assert.doesNotMatch(daemon, /node\.exe/i);
assert.doesNotMatch(readFileSync(workloadPath, 'utf8'), /node\.exe/i);

console.log('ok 1 - PowerShell canonical JSON matches attest.mjs');
console.log('ok 2 - PowerShell bundle digest matches attest.mjs');
console.log('ok 3 - Windows guest runtime is native PowerShell without Node');
console.log('# autonomous actor PowerShell selftest 3/3 passed');