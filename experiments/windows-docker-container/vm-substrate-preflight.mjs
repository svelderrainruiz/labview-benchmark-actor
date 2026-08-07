#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deriveVmPreflight, parseMachineReadable, parseVagrantBoxes, parseVirtualBoxVmList } from './vm-substrate-core.mjs';

function run(file, args = []) {
  try {
    return { available: true, ok: true, stdout: execFileSync(file, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim(), error: null };
  } catch (error) {
    return {
      available: error.code !== 'ENOENT',
      ok: false,
      stdout: String(error.stdout ?? '').trim(),
      error: String(error.stderr ?? error.message).trim(),
    };
  }
}

function envAsset(name) {
  const value = process.env[name]?.trim() || null;
  return { present: Boolean(value && existsSync(value)), path: value, source: value ? `environment:${name}` : 'not-supplied' };
}

const virtualBoxVersion = run('VBoxManage', ['--version']);
const virtualBoxList = virtualBoxVersion.available ? run('VBoxManage', ['list', 'vms']) : { ok: false, stdout: '' };
const vms = [];
if (virtualBoxList.ok) {
  for (const vm of parseVirtualBoxVmList(virtualBoxList.stdout)) {
    const info = run('VBoxManage', ['showvminfo', vm.name, '--machinereadable']);
    const values = info.ok ? parseMachineReadable(info.stdout) : {};
    vms.push({
      ...vm,
      osType: values.ostype ?? null,
      state: values.VMState ?? null,
      configFile: values.CfgFile ?? null,
      vrde: values.vrde ?? null,
      description: values.description ?? null,
      inspectionError: info.error,
    });
  }
}
const vagrantVersion = run('vagrant', ['--version']);
const vagrantBoxes = vagrantVersion.available ? run('vagrant', ['box', 'list']) : { ok: false, stdout: '' };
const vmrunVersion = run('vmrun', ['-T', 'ws', 'list']);
const hypervScript = `
$ErrorActionPreference = "Stop"
$available = [bool](Get-Command Get-VM -ErrorAction SilentlyContinue)
if (-not $available) {
  [pscustomobject]@{ available = $false; managementPermitted = $false; vms = @(); error = "Get-VM unavailable" } |
    ConvertTo-Json -Depth 6 -Compress
  exit 0
}
try {
  $vms = @(Get-VM | Select-Object Name, State, Generation, Path)
  [pscustomobject]@{ available = $true; managementPermitted = $true; vms = $vms; error = $null } |
    ConvertTo-Json -Depth 6 -Compress
} catch {
  [pscustomobject]@{ available = $true; managementPermitted = $false; vms = @(); error = $_.Exception.Message } |
    ConvertTo-Json -Depth 6 -Compress
}
`;
const hypervRun = run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', hypervScript]);
const hyperv = hypervRun.ok
  ? JSON.parse(hypervRun.stdout)
  : { available: false, managementPermitted: false, vms: [], error: hypervRun.error };

const input = {
  generatedWallTime: new Date().toISOString(),
  virtualBox: {
    available: virtualBoxVersion.available && virtualBoxVersion.ok,
    version: virtualBoxVersion.stdout || null,
    error: virtualBoxVersion.error,
    vms,
  },
  vagrant: {
    available: vagrantVersion.available && vagrantVersion.ok,
    version: vagrantVersion.stdout || null,
    error: vagrantVersion.error,
    boxes: vagrantBoxes.ok ? parseVagrantBoxes(vagrantBoxes.stdout) : [],
  },
  hyperv,
  vmware: {
    available: vmrunVersion.available,
    version: null,
    probeResult: vmrunVersion.ok ? vmrunVersion.stdout : null,
    error: vmrunVersion.error,
    windowsLabviewVmEstablished: false,
  },
  assets: {
    windowsInstallationSource: envAsset('LBA_WINDOWS_INSTALL_SOURCE'),
    labviewInstallationSource: envAsset('LBA_LABVIEW_INSTALL_SOURCE'),
    labviewLicensingReady: process.env.LBA_LABVIEW_LICENSE_READY === 'true'
      ? true
      : process.env.LBA_LABVIEW_LICENSE_READY === 'false'
        ? false
        : null,
  },
};
const receipt = deriveVmPreflight(input);
const outputArg = process.argv.indexOf('--output');
const output = outputArg >= 0 ? process.argv[outputArg + 1] : path.join(import.meta.dirname, 'decisions', 'windows-vm-substrate-preflight.json');
if (!output) throw new Error('--output requires a path');
const absolute = path.resolve(output);
mkdirSync(path.dirname(absolute), { recursive: true });
const temp = `${absolute}.${process.pid}.tmp`;
writeFileSync(temp, `${JSON.stringify(receipt, null, 2)}\n`);
renameSync(temp, absolute);
console.log(JSON.stringify({
  ready: receipt.ready,
  recommendedOption: receipt.recommendedOption,
  nextDecisionRequired: receipt.nextDecisionRequired,
  output: absolute,
}));
