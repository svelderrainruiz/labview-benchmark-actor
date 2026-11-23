#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import schema from '../docs/release/reviewer-infrastructure.schema.json' with { type: 'json' };
import { reviewerVerdictDigest } from '../experiments/handoff-beacon/reviewerVerdict.mjs';
import { verifyVisualReview } from '../tools/release-governance/verify-visual-review.mjs';
import { verifyReleaseAgreement } from '../tools/release-governance/verify-release-agreement.mjs';

export const REQUIRED_FROM = '1.6.7';
const kind = 'reviewer-infrastructure-receipt-sha256';
const versionPattern = /^\d+\.\d+\.\d+$/;

// Used both to prepare the review target and to check what the reviewer actually signed.
export function reviewerInfrastructureEvidence(version, components) {
  if (typeof version !== 'string' || !versionPattern.test(version) || components?.extension !== version) {
    throw new Error('release-components.extension must match the requested X.Y.Z candidate version');
  }
  const record = components.reviewerInfrastructure;
  if (!Object.hasOwn(components, 'reviewerInfrastructure')) {
    if (version.localeCompare(REQUIRED_FROM, 'en', { numeric: true }) < 0) return null;
    throw new Error(`reviewerInfrastructure is required from ${REQUIRED_FROM}`);
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)
      || Object.keys(record).length !== schema.required.length || !schema.required.every(k => Object.hasOwn(record, k))) {
    throw new Error(`reviewerInfrastructure must contain exactly ${schema.required.join(', ')}`);
  }
  if (record.schema !== schema.properties.schema.const) throw new Error(`reviewerInfrastructure.schema must be ${schema.properties.schema.const}`);
  for (const field of ['baseline', 'receiptSha256']) {
    const { pattern } = schema.properties[field];
    if (typeof record[field] !== 'string' || !new RegExp(pattern).test(record[field])) {
      throw new Error(`reviewerInfrastructure.${field} must match ${pattern}`);
    }
  }
  return { kind, ref: record.receiptSha256 };
}

export function verifyReviewerInfrastructure({ version, components, agreement, composite, allowlist }) {
  const expected = reviewerInfrastructureEvidence(version, components);
  if (!expected) return;

  const component = 'extension';
  const planes = ['WIN', 'LINUX'];
  const agreed = verifyReleaseAgreement({ doc: agreement, component, version, requiredPlanes: planes });
  if (!agreed.ok) throw new Error(`release agreement missing for ${agreed.missing.join(', ')} at ${version}`);
  const record = agreement.components.extension.releases[version].visualReview;
  const target = record?.verdict?.target;
  if (target?.component !== component || target.version !== version) throw new Error('agreement verdict must name the requested candidate');

  // Legacy bare PEM entries have no version or purpose. Let the existing visual gate
  // evaluate only scoped enrollments from the independent, committed allowlist.
  const scoped = Object.fromEntries(Object.entries(allowlist ?? {}).map(([id, keys]) =>
    [id, [keys].flat().filter(k => k && typeof k === 'object' && !Array.isArray(k))]));
  const visual = verifyVisualReview({ record, reviewerAllowlist: scoped });
  if (!visual.publish) throw new Error(`signed visual verdict: ${visual.reasons.join('; ')}`);

  const { verdict } = record;
  const entries = Array.isArray(verdict.evidence) ? verdict.evidence.filter(e => e?.kind === kind) : [];
  if (entries.length !== 1) throw new Error(`signed verdict must have exactly one ${kind} evidence entry`);
  if (Object.keys(entries[0]).length !== 2 || entries[0].ref !== expected.ref) {
    throw new Error('signed receipt evidence must contain only kind and ref, with ref equal to receiptSha256');
  }
  if (planes.some(p => agreed.signoffs[p].reviewedCommit !== target.commit)) {
    throw new Error('agreement reviewedCommit must match the signed candidate on both planes');
  }
  if (['component', 'version', 'commit', 'vsixSha256'].some(k => typeof target[k] !== 'string' || composite?.candidate?.[k] !== target[k])) {
    throw new Error('composite candidate must match the signed candidate component, version, commit and vsixSha256');
  }
  const digest = reviewerVerdictDigest(verdict);
  if (reviewerVerdictDigest(composite?.visual?.verdict) !== digest || composite.visual.signOff?.subject?.verdictDigest !== digest) {
    throw new Error('composite and agreement must reference the same signed visual verdict');
  }
}

function readJson(file) {
  try { return JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')); }
  catch { throw new Error(`cannot read or parse ${file}`); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const version = args.at(-1);
  if (!(args.length === 1 || (args.length === 3 && args[0] === '--component' && args[1] === 'extension')) || !versionPattern.test(version)) {
    console.error('usage: verify-reviewer-infrastructure.mjs [--component extension] X.Y.Z');
    process.exit(2);
  }
  try {
    verifyReviewerInfrastructure({
      version, components: readJson('release-components.json'),
      agreement: readJson('tools/release-governance/release-agreement.json'),
      composite: readJson('reviewer-workstation/composite-release-decision-receipt.json'),
      allowlist: readJson('tools/release-governance/reviewer-allowlist.json'),
    });
    console.log(`OK: ext-v${version} meets the reviewer infrastructure record requirement.`);
  } catch (error) {
    console.error(`FAIL (fail-closed): ext-v${version}: ${error.message}`);
    process.exitCode = 1;
  }
}
