#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().toLowerCase();

if (!/^[a-f0-9]{40}$/.test(commit)) {
  throw new Error(`Git did not return a full commit SHA: ${JSON.stringify(commit)}`);
}

writeFileSync(resolve(here, '.source-commit'), `${commit}\n`);