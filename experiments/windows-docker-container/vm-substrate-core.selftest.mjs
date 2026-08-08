import assert from 'node:assert/strict';
import { deriveVmPreflight, parseMachineReadable, parseVagrantBoxes, parseVirtualBoxVmList } from './vm-substrate-core.mjs';

assert.deepEqual(parseVirtualBoxVmList('"actor" {6680988b-5eb3-434d-96c6-8cf22f3055b9}\n'), [{
  name: 'actor',
  id: '6680988b-5eb3-434d-96c6-8cf22f3055b9',
}]);
assert.deepEqual(parseMachineReadable('name="actor"\nostype="Windows11_64"\nVMState="poweroff"\n'), {
  name: 'actor',
  ostype: 'Windows11_64',
  VMState: 'poweroff',
});
assert.deepEqual(parseVagrantBoxes('There are no installed boxes! Use `vagrant box add` to add some.'), []);
assert.deepEqual(parseVagrantBoxes('actor/win11-labview2026 (virtualbox, 1.0.0)'), [{
  name: 'actor/win11-labview2026',
  provider: 'virtualbox',
  version: '1.0.0',
}]);
assert.throws(() => parseVirtualBoxVmList('bad row'), /malformed/);
assert.throws(() => parseVagrantBoxes('bad row'), /malformed/);

const base = {
  generatedWallTime: '2026-08-07T00:00:00Z',
  virtualBox: {
    available: true,
    version: '7.2.8',
    vms: [{ name: 'ubuntu', osType: 'Ubuntu_64', state: 'poweroff' }],
  },
  vagrant: { available: true, version: '2.4.9', boxes: [] },
  hyperv: { available: true, managementPermitted: false, vms: [], error: 'permission denied' },
  vmware: { available: false, version: null, windowsLabviewVmEstablished: false },
  assets: {
    windowsInstallationSource: { present: false, path: null },
    labviewInstallationSource: { present: false, path: null },
    labviewLicensingReady: null,
  },
};
const blocked = deriveVmPreflight(base);
assert.equal(blocked.ready, false);
assert.equal(blocked.recommendedOption, 'virtualbox-vagrant');
assert.ok(blocked.options.virtualboxVagrant.missing.some((item) => item.includes('actor/win11')));
assert.ok(blocked.options.hyperv.missing.includes('authorized elevated Hyper-V management access'));
assert.equal(blocked.constraints.noDownloadsPerformed, true);

const ready = deriveVmPreflight({
  ...base,
  vagrant: {
    ...base.vagrant,
    boxes: [{ name: 'actor/win11-labview2026', provider: 'virtualbox', version: '1.0.0' }],
  },
});
assert.equal(ready.ready, true);
assert.equal(ready.options.virtualboxVagrant.status, 'ready');

const activationBlocked = deriveVmPreflight({
  ...base,
  virtualBox: {
    ...base.virtualBox,
    vms: [{ name: 'lba-win11-labview2026-build', osType: 'Windows 11 (64-bit)', state: 'poweroff' }],
  },
  assets: { ...base.assets, labviewLicensingReady: false },
});
assert.equal(activationBlocked.ready, false);
assert.equal(activationBlocked.nextDecisionRequired, 'activate-existing-windows-labview-vm');
assert.ok(activationBlocked.options.virtualboxVagrant.missing.some((item) => item.includes('activation')));

console.log('Windows VM substrate preflight core self-test: PASS');
