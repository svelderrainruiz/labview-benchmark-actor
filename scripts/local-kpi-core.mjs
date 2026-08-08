function requiredMatch(value, pattern, label) {
  const match = String(value).match(pattern);
  if (!match) throw new Error(`${label} output is missing its governed summary.`);
  return match;
}

export function parseCoverageSummary(output) {
  const metric = (name) => {
    const match = requiredMatch(
      output,
      new RegExp(`${name}\\s*:\\s*([0-9.]+)%\\s*\\(\\s*(\\d+)\\/(\\d+)\\s*\\)`, 'i'),
      name,
    );
    return { percent: Number(match[1]), covered: Number(match[2]), total: Number(match[3]) };
  };
  return {
    statements: metric('Statements'),
    branches: metric('Branches'),
    functions: metric('Functions'),
    lines: metric('Lines'),
  };
}

export function parseLocalGateSummary(output) {
  const match = requiredMatch(output, /(\d+)\/(\d+) checks passed/, 'Local-gate');
  return { passed: Number(match[1]), total: Number(match[2]) };
}

export function parseCorrespondenceSummary(output) {
  const match = requiredMatch(output, /governed-tests=(\d+)/, 'Correspondence');
  if (!String(output).includes('all correspondence rules PASS')) {
    throw new Error('Correspondence graph is not conformant.');
  }
  return { passed: Number(match[1]), total: Number(match[1]), graphConformant: true };
}

export function buildCandidateProof({
  sourceCommit,
  branch,
  vsixSha256,
  vsixSize,
  cleanBefore,
  cleanAfter,
}) {
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error('Candidate source commit must be a full Git SHA.');
  if (!/^[0-9a-f]{64}$/.test(vsixSha256)) throw new Error('Candidate VSIX SHA-256 is invalid.');
  if (!cleanBefore || !cleanAfter) throw new Error('Candidate worktree must be clean before and after local CI.');
  return {
    sourceCommit,
    branch,
    worktreeCleanBefore: true,
    worktreeCleanAfter: true,
    vsixSha256,
    vsixSize,
  };
}
