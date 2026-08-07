import assert from 'node:assert/strict';
import { evaluateVagrantBoxConsumerProof, parseVagrantBoxList, SCHEMA } from './vagrant-box-proof-core.mjs';

const baseReceipt = {
  schema: SCHEMA,
  package: {
    name: 'actor/win11-labview2026',
    provider: 'virtualbox',
    path: 'C:\\artifacts\\actor-win11-labview2026.box',
    size: 417,
    sha256: 'a'.repeat(64),
    role: 'box-package',
  },
  registration: {
    name: 'actor/win11-labview2026',
    provider: 'virtualbox',
    persistentVagrantHome: 'D:\\vagrant-home',
    consumerVagrantHome: 'D:\\lba-vagrant-proof\\run-1',
    providerUuid: '3e29a8af-ee1f-442f-8e28-2eaa07832786',
    providerUuidOwnership: 'run-owned',
    exactPackageAdded: true,
    exactPackageSha256: 'a'.repeat(64),
    addInvocation: {
      command: 'vagrant',
      args: [
        'box', 'add', '--force', '--name', 'actor/win11-labview2026',
        '--provider', 'virtualbox', 'C:\\artifacts\\actor-win11-labview2026.box',
      ],
    },
    upInvocation: {
      command: 'vagrant',
      args: ['up', 'default', '--provider', 'virtualbox', '--no-provision'],
      noProvision: true,
    },
  },
  evidence: [
    {
      path: 'C:\\evidence\\capture-summary.json',
      size: 1024,
      sha256: 'b'.repeat(64),
      role: 'capture-summary',
    },
  ],
  proof: {
    winrm: {
      authenticated: true,
      host: '127.0.0.1',
      port: 55985,
    },
    desktop: {
      interactive: true,
      windowStation: 'WinSta0',
      desktop: 'Default',
      monitorRectangles: [{ left: 0, top: 0, right: 1024, bottom: 768 }],
    },
    labview: {
      installed: true,
      activated: true,
      title: 'LabVIEW 2026',
    },
    capture: {
      rfb: {
        authenticated: true,
        loopbackOnly: true,
        boundAddress: '127.0.0.1',
        port: 5901,
        securityType: 2,
      },
      mprr: {
        passed: true,
        launchMs: 121.5,
        settleMs: 415.25,
        resourceSamples: [
          { ms: 1, cpuPct: 12.5, ramMb: 512 },
          { ms: 2, cpuPct: 10.1, ramMb: 520, diskPct: 0.2 },
        ],
      },
    },
    sourceVm: {
      activated: true,
      preserved: true,
      name: 'lba-win11-labview2026-build',
      providerUuid: '3e29a8af-ee1f-442f-8e28-2eaa07832786',
      snapshotUuid: '01702c17-1d86-4d94-9d2e-62a8c3fec3f1',
      configSha256Before: 'c'.repeat(64),
      configSha256After: 'c'.repeat(64),
    },
    cleanup: {
      runOwnedVmAbsent: true,
      natListenerAbsent: true,
      vncListenerAbsent: true,
      secretsRemoved: true,
      localDotfileRemoved: true,
      consumerVagrantHomeRemoved: true,
      lifecycleLockRemoved: true,
    },
  },
};

const clone = (value) => JSON.parse(JSON.stringify(value));

const pass = evaluateVagrantBoxConsumerProof(baseReceipt);
assert.equal(pass.status, 'passed');
assert.equal(pass.reason, 'all-required-proofs-present');
assert.equal(pass.package.sha256, 'a'.repeat(64));
assert.deepEqual(
  parseVagrantBoxList('actor/win11-labview2026 (virtualbox, 0, (amd64))'),
  [{ name: 'actor/win11-labview2026', provider: 'virtualbox', version: '0', architecture: 'amd64' }],
);

assert.throws(() => evaluateVagrantBoxConsumerProof({
  ...clone(baseReceipt),
  package: { ...clone(baseReceipt.package), sha256: undefined },
}), /package\.sha256/);

assert.throws(() => evaluateVagrantBoxConsumerProof({
  ...clone(baseReceipt),
  package: { ...clone(baseReceipt.package), size: undefined },
}), /package\.size/);

assert.throws(() => evaluateVagrantBoxConsumerProof({
  ...clone(baseReceipt),
  registration: { ...clone(baseReceipt.registration), persistentVagrantHome: '' },
}), /registration\.persistentVagrantHome/);

assert.throws(() => evaluateVagrantBoxConsumerProof({
  ...clone(baseReceipt),
  registration: {
    ...clone(baseReceipt.registration),
    upInvocation: { ...clone(baseReceipt.registration.upInvocation), noProvision: false },
  },
}), /--no-provision/);

assert.throws(() => evaluateVagrantBoxConsumerProof({
  ...clone(baseReceipt),
  registration: { ...clone(baseReceipt.registration), providerUuid: '' },
}), /registration\.providerUuid/);

assert.throws(() => evaluateVagrantBoxConsumerProof({
  ...clone(baseReceipt),
  registration: { ...clone(baseReceipt.registration), exactPackageSha256: 'd'.repeat(64) },
}), /exactPackageSha256/);

assert.throws(() => evaluateVagrantBoxConsumerProof({
  ...clone(baseReceipt),
  outcome: 'unsupported',
}), /outcome.*contradicts/);

assert.equal(evaluateVagrantBoxConsumerProof({
  ...clone(baseReceipt),
  proof: {},
}).reason, 'missing-proof');

assert.equal(evaluateVagrantBoxConsumerProof({
  ...clone(baseReceipt),
  proof: {
    ...clone(baseReceipt.proof),
    desktop: {
      ...clone(baseReceipt.proof.desktop),
      windowStation: 'Service-0x1',
    },
  },
}).reason, 'contradictory-evidence');

assert.equal(evaluateVagrantBoxConsumerProof({
  ...clone(baseReceipt),
  proof: {
    ...clone(baseReceipt.proof),
    capture: {
      ...clone(baseReceipt.proof.capture),
      rfb: {
        ...clone(baseReceipt.proof.capture.rfb),
        boundAddress: '10.0.0.5',
      },
    },
  },
}).reason, 'wrong-loopback');

assert.equal(evaluateVagrantBoxConsumerProof({
  ...clone(baseReceipt),
  proof: {
    support: { supported: false, reason: 'interactive-gui-unsupported' },
  },
}).status, 'unsupported');

assert.equal(evaluateVagrantBoxConsumerProof({
  ...clone(baseReceipt),
  proof: undefined,
}).status, 'unverified');

assert.equal(evaluateVagrantBoxConsumerProof({
  ...clone(baseReceipt),
  proof: {
    ...clone(baseReceipt.proof),
    cleanup: {
      ...clone(baseReceipt.proof.cleanup),
      vncListenerAbsent: false,
    },
  },
}).reason, 'cleanup-failed');

const activationRequiredReceipt = clone(baseReceipt);
activationRequiredReceipt.outcome = 'activation-required';
activationRequiredReceipt.proof.labview.activated = false;
activationRequiredReceipt.proof.labview.activationRequired = true;
activationRequiredReceipt.proof.capture = {
  rfb: clone(baseReceipt.proof.capture.rfb),
  blocker: {
    classification: 'labview-activation-required',
    frameCount: 1080,
    resourceSampleCount: 90,
  },
};
const activationRequired = evaluateVagrantBoxConsumerProof(activationRequiredReceipt);
assert.equal(activationRequired.status, 'activation-required');
assert.equal(activationRequired.reason, 'new-vm-identity-requires-ni-activation');

console.log('vagrant box proof core self-test: PASS');
