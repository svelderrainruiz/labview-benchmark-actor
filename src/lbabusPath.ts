import { existsSync } from 'node:fs';
import * as path from 'node:path';

export function resolveLbabusExecutable(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  pathExists: (candidate: string) => boolean = existsSync,
): string {
  const configured = String(env.LBA_LBABUS_PATH ?? '').trim();
  if (configured && pathExists(configured)) return configured;
  if (platform === 'win32') {
    const staged = 'C:\\lba-tools\\lbabus\\lbabus.exe';
    if (pathExists(staged)) return staged;
    const localAppData = String(env.LOCALAPPDATA ?? '').trim();
    if (localAppData) {
      const local = path.join(localAppData, 'lba', 'lbabus.exe');
      if (pathExists(local)) return local;
    }
  }
  return 'lbabus';
}
