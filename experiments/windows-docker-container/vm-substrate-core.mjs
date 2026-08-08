export function parseVirtualBoxVmList(text) {
  return String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const match = /^"(.+)"\s+\{([0-9a-f-]{36})\}$/i.exec(line);
    if (!match) throw new Error(`malformed VirtualBox VM row '${line}'`);
    return { name: match[1], id: match[2].toLowerCase() };
  });
}

export function parseMachineReadable(text) {
  const values = {};
  for (const line of String(text).split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    const match = /^([^=]+)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\"/g, '"');
    values[match[1]] = value;
  }
  return values;
}

export function parseVagrantBoxes(text) {
  const clean = String(text).trim();
  if (!clean || /There are no installed boxes!/i.test(clean)) return [];
  return clean.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const match = /^(.+?)\s+\(([^,]+),\s*([^)]+)\)$/.exec(line);
    if (!match) throw new Error(`malformed Vagrant box row '${line}'`);
    return { name: match[1].trim(), provider: match[2].trim(), version: match[3].trim() };
  });
}

export function deriveVmPreflight(input) {
  const virtualBoxWindowsLabviewVms = input.virtualBox.vms.filter((vm) => (
    /windows/i.test(vm.osType ?? '') && /labview/i.test(`${vm.name} ${vm.description ?? ''}`)
  ));
  const approvedBox = input.vagrant.boxes.find((box) => (
    box.name === 'actor/win11-labview2026' && box.provider === 'virtualbox'
  )) ?? null;
  const windowsSource = input.assets.windowsInstallationSource;
  const labviewSource = input.assets.labviewInstallationSource;
  const licensing = input.assets.labviewLicensingReady;
  const establishedVmReady = virtualBoxWindowsLabviewVms.length > 0 && licensing === true;
  const virtualBoxReady = input.virtualBox.available
    && input.vagrant.available
    && (approvedBox !== null || establishedVmReady);
  const hypervReady = input.hyperv.available
    && input.hyperv.managementPermitted
    && windowsSource.present
    && labviewSource.present
    && licensing === true;
  const vmwareReady = input.vmware.available
    && input.vmware.windowsLabviewVmEstablished === true;
  const options = {
    virtualboxVagrant: {
      status: virtualBoxReady ? 'ready' : 'blocked-missing-approved-asset',
      recommended: true,
      missing: [
        ...(!input.virtualBox.available ? ['VirtualBox'] : []),
        ...(!input.vagrant.available ? ['Vagrant'] : []),
        ...(approvedBox === null && virtualBoxWindowsLabviewVms.length === 0
          ? ['maintainer-held actor/win11-labview2026 VirtualBox box or approved existing Windows/LabVIEW VM']
          : []),
        ...(approvedBox === null && virtualBoxWindowsLabviewVms.length > 0 && licensing !== true
          ? ['successful interactive LabVIEW activation/licensing proof for the existing Windows/LabVIEW VM']
          : []),
      ],
      capturePath: 'VirtualBox VRDE VNC -> existing vbox-vnc-source.mjs -> MPRR workload pipeline',
    },
    hyperv: {
      status: hypervReady ? 'ready' : 'blocked-missing-permission-or-assets',
      recommended: false,
      missing: [
        ...(!input.hyperv.available ? ['Hyper-V PowerShell'] : []),
        ...(!input.hyperv.managementPermitted ? ['authorized elevated Hyper-V management access'] : []),
        ...(!windowsSource.present ? ['approved Windows installation source'] : []),
        ...(!labviewSource.present ? ['approved LabVIEW 2026 installation source'] : []),
        ...(licensing !== true ? ['approved LabVIEW activation/licensing readiness'] : []),
      ],
      capturePath: 'full Windows VM interactive desktop -> guest TightVNC on local-only transport -> shared RFB/MPRR pipeline',
    },
    vmware: {
      status: vmwareReady ? 'ready' : 'unavailable',
      recommended: false,
      missing: [
        ...(!input.vmware.available ? ['VMware vmrun/provider tooling'] : []),
        ...(input.vmware.available && input.vmware.windowsLabviewVmEstablished !== true
          ? ['approved Windows/LabVIEW VMware VM']
          : []),
      ],
      capturePath: 'VMware RemoteDisplay VNC -> existing vmware-vnc-source.mjs -> MPRR workload pipeline',
    },
  };
  return {
    schema: 'labview-benchmark-actor/windows-vm-substrate-preflight@1',
    generatedWallTime: input.generatedWallTime,
    tools: input,
    discovered: {
      virtualBoxWindowsLabviewVms,
      approvedVirtualBoxVagrantBox: approvedBox,
    },
    options,
    ready: Object.values(options).some((option) => option.status === 'ready'),
    recommendedOption: 'virtualbox-vagrant',
    nextDecisionRequired: virtualBoxReady
      ? 'approve-use-of-established-virtualbox-asset'
      : virtualBoxWindowsLabviewVms.length > 0 && licensing !== true
        ? 'activate-existing-windows-labview-vm'
        : 'provide-or-register-actor/win11-labview2026',
    constraints: {
      noDownloadsPerformed: true,
      noVmsStartedOrModified: true,
      noEulasAccepted: true,
      noLicensingChanges: true,
    },
  };
}
