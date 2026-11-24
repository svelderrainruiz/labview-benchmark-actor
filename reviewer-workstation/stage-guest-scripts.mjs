#!/usr/bin/env node
// stage-guest-scripts.mjs -- the hypervisor-independent half of release phase 7. Given the candidate, it computes the
// stage identity (task id, VSIX hash, review-target evidence), writes the three guest-side scripts (sender, install,
// configure-visual) and prints one JSON plan. release-stage-win.mjs (VirtualBox) and hyperv/release-stage-win.ps1
// (Hyper-V) build the same scripts from the same functions; neither keeps its own copy of the rules.
//
//   node reviewer-workstation/stage-guest-scripts.mjs --version X.Y.Z --commit <sha> --vsix <file> --attestation <file> \
//        --host <address the guest reaches the host on> --out-dir <dir> --share <dir> [--tcp 7420] [--user <guest user>] \
//        [--reviewer <id>] [--candidate-root <candidate checkout>] [--no-set-target]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BUS_TCP, GUEST_DIR, GUEST_LBABUS, GUEST_NODE, GUEST_POWERSHELL, GUEST_VSIX,
  buildConfigureVisual, buildInstallScript, buildStageSender, stageIdentity, stagePaths,
} from './release-stage-win.mjs';
import { expectedAssetNames } from '../scripts/lbabus-pin.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export function prepareStage(o, readFile = readFileSync, writeFile = (path, data) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); }) {
  const { version, commit, vsix, attestation, host, outDir, share, user, reviewerId = 'reviewer@vi-tech.nl', tcp = BUS_TCP, setTarget = true } = o;
  if (!host) throw new Error('--host is required: the address the guest reaches the host on (there is no default on Hyper-V)');
  if (!user) throw new Error('--user is required: the guest account whose profile holds the VS Code settings');
  const candidateRoot = resolve(o.candidateRoot ?? join(here, '..'));
  const pkg = JSON.parse(readFile(join(candidateRoot, 'package.json'), 'utf8'));
  const components = JSON.parse(readFile(join(candidateRoot, 'release-components.json'), 'utf8'));
  const extensionId = `${pkg.publisher}.${pkg.name}`;
  const { vsixSha256, taskId, evidence } = stageIdentity({ version, commit, vsix, attestation, components, setTarget }, readFile);
  const files = {
    sender: join(outDir, `lba-send-stage-${version}.mjs`),
    install: join(outDir, `lba-install-${version}.ps1`),
    configure: join(outDir, `lba-configure-visual-${version}.ps1`),
  };
  writeFile(files.sender, buildStageSender({ version, commit, vsixSha256, host, tcp }));
  writeFile(files.install, buildInstallScript({ extensionId, version, user }));
  writeFile(files.configure, buildConfigureVisual({ extensionId, version, reviewerId, user }));
  const asset = expectedAssetNames(components.lbabus)['win-x64'];
  return {
    version, commit, taskId, vsixSha256, evidence, extensionId, host, tcp, user, files,
    lbabus: { asset, version: components.lbabus, sha256: components.lbabusRelease?.assets?.[asset] ?? null },
    guest: {
      dir: GUEST_DIR, vsix: GUEST_VSIX, lbabus: GUEST_LBABUS, node: GUEST_NODE, powershell: GUEST_POWERSHELL,
      keyDir: win32.join('C:\\', 'Users', user, '.config', 'lba', 'reviewer', version),
    },
    paths: stagePaths({ share, version }),
  };
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--no-set-target') { o.setTarget = false; continue; }
    if (!key.startsWith('--') || i + 1 >= argv.length) throw new Error(`bad or valueless argument: ${key}`);
    o[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[i += 1];
  }
  if (o.tcp !== undefined) o.tcp = /^\d+$/.test(o.tcp) ? Number(o.tcp) : NaN;
  return o;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(prepareStage(parseArgs(process.argv.slice(2))), null, 2)}\n`);
  } catch (error) {
    console.error(`stage-guest-scripts: ${error.message}`);
    process.exit(1);
  }
}
