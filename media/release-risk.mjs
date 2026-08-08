const GATES = ['coverage', 'cm', 'req', 'arch', 'doc', 'dod'];

export function assessReleaseRisk(baseline, { artifactExists = () => true, scoreBaseline = null } = {}) {
  const reasons = [];
  if (baseline?.schema !== 'labview-benchmark-actor/release-risk-baseline@1') {
    reasons.push('unsupported risk-baseline schema');
  }
  if (!Array.isArray(baseline?.releaseEvidence)) {
    reasons.push('releaseEvidence must be an array');
  }
  const expectedMaturity = ['REQ', 'ARCH', 'TEST', 'CM', 'DOC'];
  if (
    Object.keys(baseline?.staticBaseline?.maturity ?? {}).join(',') !== expectedMaturity.join(',')
    || expectedMaturity.some((area) => baseline.staticBaseline.maturity[area] !== 5)
  ) {
    reasons.push('static maturity baseline must remain REQ/ARCH/TEST/CM/DOC 5/5');
  }
  const rows = [];
  for (const gate of GATES) {
    const source = baseline?.releaseEvidence?.find((row) => row.gate === gate);
    if (!source) {
      reasons.push(`missing release-risk row ${gate}`);
      continue;
    }
    const staticGate = baseline.staticBaseline?.gates?.[gate];
    const expectedConfidence = gate === 'dod' ? 'Med' : 'High';
    if (
      staticGate?.status !== 'PASS'
      || staticGate?.confidence !== expectedConfidence
      || staticGate?.rawMissingProof !== '-'
    ) {
      reasons.push(`static baseline ${gate} does not preserve PASS/${expectedConfidence}/dash`);
    }
    if (!Array.isArray(source.proofs) || source.proofs.length === 0) {
      reasons.push(`${gate} has no release proofs`);
      continue;
    }
    const invalid = source.proofs.filter((proof) => !['present', 'missing'].includes(proof.status));
    if (invalid.length) reasons.push(`${gate} has invalid proof statuses`);
    for (const proof of source.proofs) {
      if (proof.status === 'present') {
        if (typeof proof.evidence !== 'string' || !proof.evidence.trim()) {
          reasons.push(`${gate}/${proof.id} is present without evidence`);
        }
        if (!Array.isArray(proof.artifacts) || proof.artifacts.length === 0) {
          reasons.push(`${gate}/${proof.id} is present without artifacts`);
        } else {
          for (const artifact of proof.artifacts) {
            if (typeof artifact !== 'string' || !artifactExists(artifact)) {
              reasons.push(`${gate}/${proof.id} artifact does not resolve: ${artifact}`);
            }
          }
        }
      } else if (proof.evidence !== null || proof.artifacts !== undefined) {
        reasons.push(`${gate}/${proof.id} is missing but carries success-shaped evidence`);
      }
    }
    const present = source.proofs.filter((proof) => proof.status === 'present').length;
    const missing = source.proofs.filter((proof) => proof.status === 'missing').length;
    rows.push({
      gate,
      workbench: baseline.staticBaseline.gates[gate],
      present,
      missing,
      total: source.proofs.length,
      completionPercent: Math.round((present / source.proofs.length) * 1000) / 10,
      releaseStatus: missing === 0 ? 'READY' : gate === 'dod' ? 'BLOCKED' : 'AT_RISK',
      risk: source.risk,
      action: source.action,
      missingProofs: source.proofs.filter((proof) => proof.status === 'missing').map((proof) => proof.id),
    });
  }
  const present = rows.reduce((sum, row) => sum + row.present, 0);
  const total = rows.reduce((sum, row) => sum + row.total, 0);
  const result = {
    ok: reasons.length === 0,
    reasons,
    releaseVersion: baseline?.releaseVersion ?? null,
    workbenchVersion: baseline?.source?.workbenchVersion ?? null,
    present,
    missing: total - present,
    total,
    completionPercent: total ? Math.round((present / total) * 1000) / 10 : 0,
    status: rows.some((row) => row.releaseStatus === 'BLOCKED') ? 'BLOCKED'
      : rows.some((row) => row.releaseStatus === 'AT_RISK') ? 'AT_RISK' : 'READY',
    rows,
  };
  if (scoreBaseline) {
    if (scoreBaseline.schema !== 'labview-benchmark-actor/standards-score-baseline@1') {
      result.reasons.push('unsupported standards score baseline schema');
    }
    for (const area of expectedMaturity) {
      if (
        scoreBaseline.maturity?.[area]?.score !== baseline.staticBaseline.maturity[area]
        || scoreBaseline.maturity?.[area]?.confidence !== 'High'
      ) {
        result.reasons.push(`standards score baseline ${area} drifted`);
      }
    }
    for (const gate of GATES) {
      if (JSON.stringify(scoreBaseline.gates?.[gate]) !== JSON.stringify(baseline.staticBaseline.gates[gate])) {
        result.reasons.push(`standards score baseline ${gate} drifted`);
      }
    }
    if (scoreBaseline.source?.rawScoreSha256 !== baseline.source?.rawScoreSha256) {
      result.reasons.push('standards raw score hash drifted');
    }
    result.ok = result.reasons.length === 0;
  }
  return result;
}

export function riskSummaryLines(assessment) {
  return [
    `release evidence ${assessment.present}/${assessment.total} (${assessment.completionPercent}%) ${assessment.status}`,
    ...assessment.rows.map((row) => (
      `${row.gate}: workbench=${row.workbench.status}/${row.workbench.confidence}; `
      + `release=${row.releaseStatus} ${row.present}/${row.total}; `
      + `missing=${row.missingProofs.join(',') || 'none'}; action=${row.action}`
    )),
  ];
}

export function verifyGovernedRisk(assessment, expected) {
  const reasons = [];
  if (!assessment?.ok) reasons.push('release-risk assessment is invalid');
  if (assessment?.present !== expected?.present) reasons.push('governed present-proof count drifted');
  if (assessment?.total !== expected?.total) reasons.push('governed total-proof count drifted');
  if (assessment?.status !== expected?.status) reasons.push('governed release-risk status drifted');
  return { ok: reasons.length === 0, reasons };
}
