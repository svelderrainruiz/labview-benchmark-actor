// canonical-repo.mjs -- the canonical GitHub repository for gh calls (#59). gh resolves the repository from git
// remotes, and a checkout may also carry an `upstream` remote that points elsewhere, so every gh call made by the
// release tooling names the repository explicitly. The canonical repository is package.json repository.url (#56).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export function canonicalRepo(pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))) {
  const url = typeof pkg?.repository === 'string' ? pkg.repository : pkg?.repository?.url;
  const match = String(url ?? '').trim().replace(/^git\+/, '').replace(/\.git$/i, '').replace(/\/+$/, '')
    .match(/^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/);
  if (!match) throw new Error(`package.json repository.url is not a GitHub repository URL: ${url}`);
  return `${match[1]}/${match[2]}`;
}

// The gh argument vector with the canonical repository named explicitly.
export function ghRepoArgs(args, repo = canonicalRepo()) {
  return [...args, '--repo', repo];
}
