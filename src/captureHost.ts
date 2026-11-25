/**
 * Capture host helpers shared by the extension and the vscode-free local-model loop CLI (#134 slice 4): ffmpeg
 * resolution (configured path -> the VM-local copy install-lba.cmd stages under %LOCALAPPDATA%\lba -> `ffmpeg`
 * on PATH -> the WinGet Links shim -> the Gyan.FFmpeg package store) with a runnability probe.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';

// ffmpeg resolution + a runnability probe: resolveFfmpegCommand returns null when NONE is a spawnable binary,
// so the capture fails FAST with an actionable message instead of a raw `spawn ffmpeg ENOENT` mid-run (the v1.0.0
// Marketplace complaint: a fresh install has no ffmpeg on PATH).
export function ffmpegRunnable(cmd: string): boolean {
  try {
    // `-version` is a fast, side-effect-free probe. We only care that the binary SPAWNS (no ENOENT): a present
    // ffmpeg exits 0, and even a mismatched build still spawns. spawnSync sets `.error` (does not throw) on ENOENT.
    return !spawnSync(cmd, ['-version'], { windowsHide: true, timeout: 5000 }).error;
  } catch {
    return false;
  }
}

function findWingetPackageFfmpeg(localAppData: string): string | null {
  const packagesRoot = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
  let packages;
  try {
    packages = readdirSync(packagesRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const findBelow = (directory: string, depth: number): string | null => {
    if (depth > 3) return null;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === 'ffmpeg.exe' && ffmpegRunnable(candidate)) return candidate;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const found = findBelow(path.join(directory, entry.name), depth + 1);
      if (found) return found;
    }
    return null;
  };
  for (const packageDir of packages) {
    if (!packageDir.isDirectory() || !/^Gyan\.FFmpeg_/i.test(packageDir.name)) continue;
    const found = findBelow(path.join(packagesRoot, packageDir.name), 0);
    if (found) return found;
  }
  return null;
}

export function resolveFfmpegCommand(configuredPath = '', env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = configuredPath.trim();
  if (configured) return ffmpegRunnable(configured) ? configured : null;
  const localAppData = env.LOCALAPPDATA;
  const staged = localAppData ? path.join(localAppData, 'lba', 'ffmpeg.exe') : '';
  if (staged && existsSync(staged)) return staged;
  if (ffmpegRunnable('ffmpeg')) return 'ffmpeg';
  // A winget-installed ffmpeg (the "Install ffmpeg (winget)" button installs Gyan.FFmpeg) often symlinks ffmpeg.exe
  // into %LOCALAPPDATA%\Microsoft\WinGet\Links and adds that dir to the USER PATH. The extension-host process can
  // retain its pre-install PATH, and some WinGet installations omit the Links shim entirely; check both the shim and
  // the Gyan package store directly so the capture works without a VS Code or terminal restart.
  if (localAppData) {
    const wingetLink = path.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe');
    if (existsSync(wingetLink) && ffmpegRunnable(wingetLink)) return wingetLink;
    const wingetPackageFfmpeg = findWingetPackageFfmpeg(localAppData);
    if (wingetPackageFfmpeg) return wingetPackageFfmpeg;
  }
  return null;
}

