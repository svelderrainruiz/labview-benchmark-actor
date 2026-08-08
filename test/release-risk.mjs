#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assessReleaseRisk, riskSummaryLines, verifyGovernedRisk } from '../extension-tasks/release-risk.mjs';

const baseline = JSON.parse(readFileSync(new URL('../release-risk-baseline.json', import.meta.url), 'utf8'));
const scoreBaseline = JSON.parse(readFileSync(new URL('../standards-score-baseline.json', import.meta.url), 'utf8'));
const assessment = assessReleaseRisk(baseline, { artifactExists: () => true, scoreBaseline });
assert.equal(assessment.ok, true);
assert.equal(assessment.status, 'BLOCKED');
assert.equal(assessment.present, 12);
assert.equal(assessment.total, 28);
assert.equal(assessment.completionPercent, 42.9);
assert.equal(assessment.rows.length, 6);
assert.equal(assessment.rows.find((row) => row.gate === 'dod').releaseStatus, 'BLOCKED');
assert(riskSummaryLines(assessment).every((line) => line.length > 20));
assert.equal(verifyGovernedRisk(assessment, { present: 12, total: 28, status: 'BLOCKED' }).ok, true);
assert.equal(verifyGovernedRisk(assessment, { present: 28, total: 28, status: 'READY' }).ok, false);

const missingRow = structuredClone(baseline);
missingRow.releaseEvidence = missingRow.releaseEvidence.filter((row) => row.gate !== 'doc');
assert.equal(assessReleaseRisk(missingRow, { artifactExists: () => true, scoreBaseline }).ok, false);

const falseReady = structuredClone(baseline);
falseReady.releaseEvidence[0].proofs[2].status = 'PASS';
assert.equal(assessReleaseRisk(falseReady, { artifactExists: () => true, scoreBaseline }).ok, false);

const missingArtifact = structuredClone(baseline);
assert.equal(assessReleaseRisk(missingArtifact, { artifactExists: () => false, scoreBaseline }).ok, false);

const driftedScore = structuredClone(scoreBaseline);
driftedScore.gates.dod.confidence = 'High';
assert.equal(assessReleaseRisk(baseline, { artifactExists: () => true, scoreBaseline: driftedScore }).ok, false);

console.log('release-risk: PASS');
