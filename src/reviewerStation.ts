export type ReviewerStation = 'WINDOWS_VM' | 'UBUNTU_VM' | 'LINUX_CODESPACE';

export function reviewerStationForEnvironment(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ReviewerStation {
  if (platform === 'linux' && String(env.CODESPACES || '').toLowerCase() === 'true') return 'LINUX_CODESPACE';
  if (platform === 'linux') return 'UBUNTU_VM';
  return 'WINDOWS_VM';
}
