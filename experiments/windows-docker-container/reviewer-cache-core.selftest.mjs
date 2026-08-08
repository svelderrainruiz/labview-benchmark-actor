import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  SCHEMA,
  evaluateReviewerCacheReceipt,
  verifyReviewerCacheReceipt,
} from './reviewer-cache-core.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const scratchRoot = path.join(import.meta.dirname, 'evidence', 'reviewer-cache-selftest');

const uuidA = '3e29a8af-ee1f-442f-8e28-2eaa07832786';
const uuidB = 'f5de7ff5-d858-4f0e-9bab-3b2e252926b5';
const snapUuid = 'c00da84d-61b1-4c1d-94ed-d063022db42a';
const makeFile = (relative, content) => {
  const file = path.join(scratchRoot, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
};
const fileRef = (relative, content, role = null) => {
  const file = makeFile(relative, content);
  return {
    path: file,
    size: Buffer.byteLength(content, 'utf8'),
    sha256: digest(content),
    role,
  };
};

const digest = (content) => createHash('sha256').update(content).digest('hex');

function buildReceipt(overrides = {}) {
  const packageFile = fileRef('package.box', 'package-box-content', 'box-package');
  const sourceBoxFile = fileRef('source-box.box', 'package-box-content', 'box-package');
  const sourceVmConfig = fileRef('source-vm.vbox', '<VirtualBoxMachine />', null);
  const vsixFile = fileRef('reviewer.vsix', 'vsix-content', null);
  const mprrEvidence = fileRef('mprr.json', '{"activated":true}', 'mprr-proof');

  return {
    schema: SCHEMA,
    outcome: 'passed',
    package: {
      ...packageFile,
      name: 'actor/win11-reviewer-cache',
      provider: 'virtualbox',
      version: '1.0.0',
    },
    registration: {
      name: 'actor/win11-reviewer-cache',
      provider: 'virtualbox',
      pinnedVagrantHome: path.join(repoRoot, 'test-vagrant-home'),
      persistentVagrantDotfilePath: path.join(repoRoot, 'test-vagrant-home', '.vagrant.d'),
      providerVm: {
        name: 'reviewer-cache-run-vm',
        uuid: uuidB,
        hardwareUuid: uuidA,
        ownership: 'run-owned',
        state: 'poweroff',
      },
      addInvocation: {
        command: 'vagrant',
        args: [
          'box', 'add', '--force', '--name', 'actor/win11-reviewer-cache', '--provider', 'virtualbox',
          packageFile.path,
        ],
      },
      upInvocation: {
        command: 'vagrant',
        args: ['up', 'default', '--provider', 'virtualbox', '--no-provision'],
      },
    },
    provenance: {
      sourceBox: {
        ...sourceBoxFile,
        name: 'actor/win11-reviewer-cache',
        provider: 'virtualbox',
        version: '1.0.0',
      },
      sourceVm: {
        name: 'lba-win11-labview2026-build',
        uuid: uuidA,
        hardwareUuid: uuidA,
        snapshotUuid: snapUuid,
        configFile: sourceVmConfig,
      },
      worktree: {
        path: repoRoot,
        commit: '0123456789abcdef0123456789abcdef01234567',
        branch: 'windows-docker-tightvnc-labview-experiment',
        repository: 'labview-benchmark-actor',
      },
    },
    vsix: {
      ...vsixFile,
      version: '2.3.4',
      worktree: {
        path: repoRoot,
        commit: '0123456789abcdef0123456789abcdef01234567',
        branch: 'windows-docker-tightvnc-labview-experiment',
        repository: 'labview-benchmark-actor',
      },
      installProof: {
        profile: 'interactive',
        command: 'powershell -File install-vsix.ps1',
        owner: 'run-owned',
        installed: true,
        worktreePath: repoRoot,
      },
    },
    proof: {
      support: { supported: true, reason: 'virtualbox-reviewer-cache-supported' },
      activation: {
        exactProviderVmUuid: uuidB,
        challengeVmUuid: uuidB,
        activated: true,
        liveProof: {
          vmUuid: uuidB,
          hardwareUuid: uuidA,
          profile: 'interactive',
          exactUuidObserved: true,
        },
        mprr: {
          activationState: 'activated',
          activated: true,
          passed: true,
          launchMs: 12.5,
          settleMs: 64.25,
          resourceSamples: [{ ms: 1, cpuPct: 9.5, ramMb: 512 }],
          evidence: [mprrEvidence],
        },
      },
      lifecycle: {
        snapshotUuid: snapUuid,
        state: 'sealed',
        cacheReady: true,
        sealed: true,
        exclusiveLockReleased: true,
        vmPoweredOff: true,
        lockPath: path.join(repoRoot, 'locks', 'reviewer-cache.lock'),
        lockOwner: 'run-owned',
      },
      cleanup: {
        vmPoweredOff: true,
        vncListenerAbsent: true,
        natListenerAbsent: true,
        tasksAbsent: true,
        processesAbsent: true,
        secretsRemoved: true,
        listenersAbsent: true,
      },
    },
    resume: {
      environment: {
        VAGRANT_HOME: path.join(repoRoot, 'test-vagrant-home'),
        VAGRANT_DOTFILE_PATH: path.join(repoRoot, 'test-vagrant-home', '.vagrant.d'),
      },
      command: 'node experiments/windows-docker-container/reviewer-cache-core.mjs resume',
      commands: [
        'vagrant up default --provider virtualbox --no-provision',
        'node experiments/windows-docker-container/reviewer-cache-core.mjs resume',
      ],
      owner: 'run-owned',
    },
    intentionalDestroy: {
      command: 'vagrant destroy -f default',
      owner: 'run-owned',
      reason: 'intentional reviewer cache teardown',
    },
    liveChecks: false,
    ...overrides,
  };
}

try {
  const pass = evaluateReviewerCacheReceipt(buildReceipt());
  assert.equal(pass.status, 'passed');
  assert.equal(pass.reason, 'reviewer-cache-ready');
  assert.equal(pass.resume.environment.VAGRANT_HOME, path.join(repoRoot, 'test-vagrant-home'));
  assert.equal(pass.intentionalDestroy.owner, 'run-owned');

  assert.throws(() => evaluateReviewerCacheReceipt(buildReceipt({
    package: { ...buildReceipt().package, name: 'actor/win11-other' },
  })), /registration\.name|must match package\.name/);

  assert.equal(evaluateReviewerCacheReceipt(buildReceipt({
    outcome: undefined,
    proof: {
      ...buildReceipt().proof,
      activation: undefined,
    },
  })).reason, 'missing-activation-proof');

  assert.equal(evaluateReviewerCacheReceipt(buildReceipt({
    outcome: undefined,
    proof: {
      ...buildReceipt().proof,
      activation: {
        ...buildReceipt().proof.activation,
        exactProviderVmUuid: uuidA,
      },
    },
  })).reason, 'stale-activation-challenge');

  assert.equal(evaluateReviewerCacheReceipt(buildReceipt({
    outcome: undefined,
    vsix: undefined,
  })).reason, 'missing-vsix-proof');

  assert.equal(evaluateReviewerCacheReceipt(buildReceipt({
    outcome: undefined,
    vsix: {
      ...buildReceipt().vsix,
      installProof: {
        ...buildReceipt().vsix.installProof,
        profile: 'quiet',
      },
    },
  })).reason, 'wrong-interactive-profile');

  const recoveredReceipt = buildReceipt();
  const installedManifest = fileRef(
    'installed-extension-manifest.json',
    '{"schema":"installed-extension"}',
    'installed-extension-manifest',
  );
  const installedArchive = fileRef(
    'installed-extension.zip',
    'installed-extension-archive',
    'installed-extension-archive',
  );
  recoveredReceipt.vsix = {
    ...recoveredReceipt.vsix,
    sourceArtifactRetained: false,
    installedSnapshotProof: {
      sourceVmUuid: uuidB,
      sourceSnapshotUuid: snapUuid,
      extensionId: 'svelderrainruiz.labview-benchmark-actor',
      version: recoveredReceipt.vsix.version,
      manifest: installedManifest,
      archive: installedArchive,
    },
  };
  rmSync(recoveredReceipt.vsix.path);
  assert.equal(evaluateReviewerCacheReceipt(recoveredReceipt).status, 'passed');
  await verifyReviewerCacheReceipt(recoveredReceipt, { baseDir: repoRoot, live: false });
  assert.equal(
    evaluateReviewerCacheReceipt({
      ...recoveredReceipt,
      outcome: undefined,
      vsix: {
        ...recoveredReceipt.vsix,
        installedSnapshotProof: {
          ...recoveredReceipt.vsix.installedSnapshotProof,
          sourceSnapshotUuid: uuidA,
        },
      },
    }).reason,
    'invalid-installed-snapshot-proof',
  );
  writeFileSync(installedArchive.path, 'tampered-installed-extension-archive');
  await assert.rejects(
    () => verifyReviewerCacheReceipt(recoveredReceipt, { baseDir: repoRoot, live: false }),
    /size mismatch|SHA-256 mismatch/,
  );

  assert.equal(evaluateReviewerCacheReceipt(buildReceipt({
    outcome: undefined,
    proof: {
      ...buildReceipt().proof,
      lifecycle: {
        ...buildReceipt().proof.lifecycle,
        snapshotUuid: uuidA,
      },
    },
  })).reason, 'snapshot-mismatch');

  assert.equal(evaluateReviewerCacheReceipt(buildReceipt({
    outcome: undefined,
    proof: {
      ...buildReceipt().proof,
      lifecycle: {
        ...buildReceipt().proof.lifecycle,
        exclusiveLockReleased: false,
      },
    },
  })).reason, 'lock-unreleased');

  assert.equal(evaluateReviewerCacheReceipt(buildReceipt({
    outcome: undefined,
    proof: {
      ...buildReceipt().proof,
      cleanup: {
        ...buildReceipt().proof.cleanup,
        vncListenerAbsent: false,
      },
    },
  })).reason, 'listener-failure');

  assert.equal(evaluateReviewerCacheReceipt(buildReceipt({
    outcome: undefined,
    proof: { support: { supported: false, reason: 'virtualbox-not-available' } },
  })).status, 'unsupported');

  assert.equal(evaluateReviewerCacheReceipt(buildReceipt({
    outcome: undefined,
    proof: undefined,
  })).status, 'unverified');

  const tamperRoot = path.join(scratchRoot, 'tamper');
  mkdirSync(tamperRoot, { recursive: true });
  const tamperBox = path.join(tamperRoot, 'tampered.box');
  writeFileSync(tamperBox, 'initial');
  writeFileSync(path.join(tamperRoot, 'source-vm.vbox'), '<VirtualBoxMachine />');
  writeFileSync(path.join(tamperRoot, 'reviewer.vsix'), 'vsix');
  writeFileSync(path.join(tamperRoot, 'mprr.json'), 'activated');
  const tamperReceipt = {
    schema: SCHEMA,
    outcome: 'passed',
    package: {
      path: tamperBox,
      size: Buffer.byteLength('initial'),
      sha256: digest('initial'),
      name: 'actor/win11-reviewer-cache',
      provider: 'virtualbox',
      version: '1.0.0',
      role: 'box-package',
    },
    registration: {
      name: 'actor/win11-reviewer-cache',
      provider: 'virtualbox',
      pinnedVagrantHome: path.join(repoRoot, 'test-vagrant-home'),
      persistentVagrantDotfilePath: path.join(repoRoot, 'test-vagrant-home', '.vagrant.d'),
      providerVm: {
        name: 'reviewer-cache-run-vm',
        uuid: uuidB,
        hardwareUuid: uuidA,
        ownership: 'run-owned',
        state: 'poweroff',
      },
      addInvocation: {
        command: 'vagrant',
        args: ['box', 'add', '--force', '--name', 'actor/win11-reviewer-cache', '--provider', 'virtualbox', tamperBox],
      },
      upInvocation: {
        command: 'vagrant',
        args: ['up', 'default', '--provider', 'virtualbox', '--no-provision'],
      },
    },
    provenance: {
      sourceBox: {
        path: tamperBox,
        size: Buffer.byteLength('initial'),
        sha256: digest('initial'),
        name: 'actor/win11-reviewer-cache',
        provider: 'virtualbox',
        version: '1.0.0',
        role: 'box-package',
      },
      sourceVm: {
        name: 'lba-win11-labview2026-build',
        uuid: uuidA,
        hardwareUuid: uuidA,
        snapshotUuid: snapUuid,
        configFile: {
          path: path.join(tamperRoot, 'source-vm.vbox'),
          size: Buffer.byteLength('<VirtualBoxMachine />'),
          sha256: digest('<VirtualBoxMachine />'),
        },
      },
      worktree: {
        path: repoRoot,
        commit: '0123456789abcdef0123456789abcdef01234567',
        branch: 'windows-docker-tightvnc-labview-experiment',
        repository: 'labview-benchmark-actor',
      },
    },
    vsix: {
      path: path.join(tamperRoot, 'reviewer.vsix'),
      size: Buffer.byteLength('vsix'),
      sha256: digest('vsix'),
      version: '2.3.4',
      worktree: {
        path: repoRoot,
        commit: '0123456789abcdef0123456789abcdef01234567',
        branch: 'windows-docker-tightvnc-labview-experiment',
        repository: 'labview-benchmark-actor',
      },
      installProof: {
        profile: 'interactive',
        command: 'powershell -File install-vsix.ps1',
        owner: 'run-owned',
        installed: true,
        worktreePath: repoRoot,
      },
    },
    proof: {
      support: { supported: true, reason: 'virtualbox-reviewer-cache-supported' },
      activation: {
        exactProviderVmUuid: uuidB,
        challengeVmUuid: uuidB,
        activated: true,
        liveProof: {
          vmUuid: uuidB,
          hardwareUuid: uuidA,
          profile: 'interactive',
          exactUuidObserved: true,
        },
        mprr: {
          activationState: 'activated',
          activated: true,
          passed: true,
          launchMs: 12.5,
          settleMs: 64.25,
          resourceSamples: [{ ms: 1, cpuPct: 9.5, ramMb: 512 }],
          evidence: [{
            path: path.join(tamperRoot, 'mprr.json'),
            size: Buffer.byteLength('activated'),
            sha256: digest('activated'),
            role: 'mprr-proof',
          }],
        },
      },
      lifecycle: {
        snapshotUuid: snapUuid,
        state: 'sealed',
        cacheReady: true,
        sealed: true,
        exclusiveLockReleased: true,
        vmPoweredOff: true,
        lockPath: path.join(repoRoot, 'locks', 'reviewer-cache.lock'),
        lockOwner: 'run-owned',
      },
      cleanup: {
        vmPoweredOff: true,
        vncListenerAbsent: true,
        natListenerAbsent: true,
        tasksAbsent: true,
        processesAbsent: true,
        secretsRemoved: true,
        listenersAbsent: true,
      },
    },
    resume: {
      environment: {
        VAGRANT_HOME: path.join(repoRoot, 'test-vagrant-home'),
        VAGRANT_DOTFILE_PATH: path.join(repoRoot, 'test-vagrant-home', '.vagrant.d'),
      },
      command: 'node experiments/windows-docker-container/reviewer-cache-core.mjs resume',
      commands: ['vagrant up default --provider virtualbox --no-provision'],
      owner: 'run-owned',
    },
    intentionalDestroy: {
      command: 'vagrant destroy -f default',
      owner: 'run-owned',
    },
    liveChecks: false,
  };

  await verifyReviewerCacheReceipt(tamperReceipt, { baseDir: repoRoot, live: false });
  writeFileSync(tamperBox, 'changed');
  await assert.rejects(
    () => verifyReviewerCacheReceipt(tamperReceipt, { baseDir: repoRoot, live: false }),
    /SHA-256 mismatch/,
  );

  console.log('Windows vagrant reviewer cache core self-test: PASS');
} finally {
  rmSync(scratchRoot, { recursive: true, force: true });
}
