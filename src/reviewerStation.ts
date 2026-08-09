export type ReviewerStation = 'WINDOWS_VM' | 'UBUNTU_VM' | 'LINUX_CODESPACE';

export function reviewerStationForEnvironment(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  stagedStation?: unknown,
): ReviewerStation {
  if (platform === 'linux' && String(env.CODESPACES || '').toLowerCase() === 'true') {
    if (stagedStation === 'LINUX_CODESPACE') return 'LINUX_CODESPACE';
    throw new Error('Codespaces reviewer verdicts require independently staged LINUX_CODESPACE identity');
  }
  if (platform === 'linux') {
    if (stagedStation === 'UBUNTU_VM') return 'UBUNTU_VM';
    throw new Error('Linux reviewer verdicts require a candidate-bound UBUNTU_VM staging marker');
  }
  if (platform === 'win32') return 'WINDOWS_VM';
  throw new Error(`Reviewer verdicts are unsupported on ${platform}`);
}
