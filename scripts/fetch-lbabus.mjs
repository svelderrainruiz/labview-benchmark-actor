#!/usr/bin/env node
// Fetch the pinned lbabus release (release-components.json `lbabusRelease`) with fail-closed checks.
//
//   node scripts/fetch-lbabus.mjs binary --rid linux-x64|win-x64 [--out FILE] [--attest]
//   node scripts/fetch-lbabus.mjs source [--cache DIR]
//
// binary: downloads the release asset and fails unless its SHA-256 equals the pin; --attest also runs
//         `gh attestation verify` against svelderrainruiz/lbabus.
// source: clones the pinned tag and fails unless the tag object and the commit equal the pin and the tree is clean.
// Both print the verified path on stdout and nothing else, so callers can capture it.
// Test hooks: --pin FILE (alternative pin), --repository URL (alternative origin, e.g. a local repository or server).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedAssetNames, pinProblems } from './lbabus-pin.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadPin(pinFile = join(root, 'release-components.json')) {
  const components = JSON.parse(readFileSync(pinFile, 'utf8'));
  const problems = pinProblems(components);
  if (problems.length > 0) throw new Error(`unusable lbabus pin: ${problems.join('; ')}`);
  return components;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function fetchBinary({ components, rid, out, repository, attest = false, cacheDir }) {
  const pin = components.lbabusRelease;
  const asset = expectedAssetNames(components.lbabus)[rid];
  if (!asset || rid === 'package' || rid === 'sums') throw new Error(`unknown runtime identifier '${rid}' (linux-x64 or win-x64)`);
  const url = `${repository ?? pin.repository}/releases/download/${pin.tag}/${asset}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed (${response.status}) for ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== pin.assets[asset]) {
    throw new Error(`SHA-256 mismatch for ${asset}: pinned ${pin.assets[asset]}, downloaded ${actual}`);
  }
  const target = resolve(out ?? join(cacheDir ?? defaultCache(), pin.tag, asset));
  mkdirSync(dirname(target), { recursive: true });
  const partial = `${target}.${process.pid}.part`;
  writeFileSync(partial, bytes);
  if (attest) {
    try {
      execFileSync('gh', ['attestation', 'verify', partial, '--repo', 'svelderrainruiz/lbabus'], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      rmSync(partial, { force: true });
      throw new Error(`attestation verification failed for ${asset}: ${error.stderr?.toString().trim() || error.message}`);
    }
  }
  renameSync(partial, target);
  if (rid !== 'package') chmodSync(target, 0o755);
  return target;
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function verifyCheckout(dir, pin) {
  const commit = git(dir, 'rev-parse', 'HEAD');
  if (commit !== pin.commit) throw new Error(`${pin.tag} resolves to commit ${commit}, not the pinned ${pin.commit}`);
  const tagObject = git(dir, 'rev-parse', `refs/tags/${pin.tag}`);
  if (tagObject !== pin.tagObject) throw new Error(`tag ${pin.tag} is object ${tagObject}, not the pinned ${pin.tagObject}`);
  if (git(dir, 'status', '--porcelain')) throw new Error(`the ${pin.tag} checkout at ${dir} has local changes`);
}

export function checkoutSource({ components, repository, cacheDir }) {
  const pin = components.lbabusRelease;
  const dir = join(cacheDir ?? defaultCache(), `src-${pin.commit}`);
  if (existsSync(join(dir, '.git'))) {
    verifyCheckout(dir, pin);
    return dir;
  }
  const staging = `${dir}.${process.pid}.tmp`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(dirname(dir), { recursive: true });
  try {
    execFileSync('git', ['clone', '--quiet', '--depth', '1', '--branch', pin.tag, repository ?? pin.repository, staging], { stdio: ['ignore', 'ignore', 'pipe'] });
    verifyCheckout(staging, pin);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  renameSync(staging, dir);
  return dir;
}

function defaultCache() {
  return process.env.LBABUS_CACHE || join(tmpdir(), 'lba-lbabus-cache');
}

async function main(argv) {
  const [mode, ...rest] = argv;
  const option = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const components = loadPin(option('--pin'));
  if (mode === 'binary') {
    const rid = option('--rid');
    if (!rid) throw new Error('binary mode needs --rid linux-x64|win-x64');
    return fetchBinary({ components, rid, out: option('--out'), repository: option('--repository'), attest: rest.includes('--attest'), cacheDir: option('--cache') });
  }
  if (mode === 'source') return checkoutSource({ components, repository: option('--repository'), cacheDir: option('--cache') });
  throw new Error('usage: fetch-lbabus.mjs binary --rid <rid> [--out FILE] [--attest] | source [--cache DIR]');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (path) => { process.stdout.write(`${path}\n`); },
    (error) => { process.stderr.write(`fetch-lbabus: ${error.message}\n`); process.exitCode = 1; },
  );
}
