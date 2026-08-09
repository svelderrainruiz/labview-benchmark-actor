#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyUbuntuBaseBootstrapContract } from '../scripts/verify-ubuntu-base-bootstrap.mjs';

const bootstrap = readFileSync(new URL('../cleanroom/ubuntu-labview/base-bootstrap.sh', import.meta.url), 'utf8');
const builder = readFileSync(new URL('../cleanroom/ubuntu-labview/build-virtualbox.sh', import.meta.url), 'utf8');

assert.equal(verifyUbuntuBaseBootstrapContract({ bootstrap, builder }).ok, true);

for (const packageName of ['openssh-server', 'git', 'virtualbox-guest-utils']) {
  const changed = bootstrap.replaceAll(packageName, 'absentpackage');
  assert.equal(
    verifyUbuntuBaseBootstrapContract({ bootstrap: changed, builder }).ok,
    false,
    `${packageName} is required`,
  );
}

assert.equal(
  verifyUbuntuBaseBootstrapContract({
    bootstrap: bootstrap.replace('systemctl enable ssh.service', ':'),
    builder,
  }).ok,
  false,
  'SSH must be enabled',
);
assert.equal(
  verifyUbuntuBaseBootstrapContract({
    bootstrap: bootstrap.replace('systemctl is-enabled ssh.service', 'printf unknown'),
    builder,
  }).ok,
  false,
  'the SSH enabled state must be probed',
);
assert.equal(
  verifyUbuntuBaseBootstrapContract({
    bootstrap: bootstrap.replace('systemctl is-active virtualbox-guest-utils.service', 'printf inactive'),
    builder,
  }).ok,
  false,
  'Guest Additions state must be checked',
);
assert.equal(
  verifyUbuntuBaseBootstrapContract({
    bootstrap: bootstrap.replace('OnBootSec=30s', 'OnBootSec=0'),
    builder,
  }).ok,
  false,
  'guest-utils validation must run after installer cleanup',
);
assert.equal(
  verifyUbuntuBaseBootstrapContract({
    bootstrap,
    builder: builder.replace('missing unattended bootstrap template', 'bootstrap unavailable'),
  }).ok,
  false,
  'a missing bootstrap template must fail closed',
);
assert.equal(
  verifyUbuntuBaseBootstrapContract({
    bootstrap,
    builder: builder.replace('GUEST_PASSWORD_FILE is empty', 'credential accepted'),
  }).ok,
  false,
  'an empty credential file must fail closed',
);
assert.equal(
  verifyUbuntuBaseBootstrapContract({
    bootstrap,
    builder: builder.replace('does not support unattended --post-install-template', 'unsupported hook'),
  }).ok,
  false,
  'an unsupported unattended hook must fail closed',
);
assert.equal(
  verifyUbuntuBaseBootstrapContract({
    bootstrap,
    builder: `${builder}\nVBoxManage unattended install --user-password=unsafe`,
  }).ok,
  false,
  'password CLI values are forbidden',
);
assert.equal(
  verifyUbuntuBaseBootstrapContract({
    bootstrap,
    builder: builder.replace('run_redacted VBoxManage unattended install', 'run VBoxManage unattended install'),
  }).ok,
  false,
  'VirtualBox credential diagnostics must be redacted',
);
assert.equal(
  verifyUbuntuBaseBootstrapContract({
    bootstrap: bootstrap.replace('case "$VM_NAME" in', 'case "materialized" in'),
    builder,
  }).ok,
  false,
  'placeholder sentinels must survive value materialization',
);

console.log('ubuntu-base-bootstrap tests: PASS');
