#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function verifyUbuntuBaseBootstrapContract({ bootstrap, builder }) {
  const failures = [];
  const requiredPackages = ['openssh-server', 'git', 'virtualbox-guest-utils'];
  for (const packageName of requiredPackages) {
    if (!new RegExp(`apt-get install[\\s\\S]*\\b${packageName}\\b`).test(bootstrap)) {
      failures.push(`bootstrap must install ${packageName}`);
    }
  }
  if (!/systemctl enable ssh\.service/.test(bootstrap)) failures.push('bootstrap must enable ssh.service');
  if (!/systemctl is-active ssh\.service/.test(bootstrap)) failures.push('receipt must probe active ssh.service');
  if (!/systemctl is-enabled ssh\.service/.test(bootstrap)) failures.push('receipt must probe enabled ssh.service');
  if (!/command -v git/.test(bootstrap)) failures.push('receipt must resolve Git');
  if (!/systemctl enable virtualbox-guest-utils\.service/.test(bootstrap)) {
    failures.push('bootstrap must enable VirtualBox guest utilities');
  }
  if (!/systemctl is-active virtualbox-guest-utils\.service/.test(bootstrap)) {
    failures.push('receipt must probe VirtualBox guest utilities');
  }
  if (!/systemctl is-enabled virtualbox-guest-utils\.service/.test(bootstrap)) {
    failures.push('receipt must probe enabled VirtualBox guest utilities');
  }
  if (!/unsupported OS/.test(bootstrap) || !/unsupported Ubuntu version/.test(bootstrap)) {
    failures.push('unsupported guests must fail closed');
  }
  if (!/VirtualBox guest hardware was not detected/.test(bootstrap)) {
    failures.push('non-VirtualBox hardware must fail closed');
  }
  if (!/case "\$VM_NAME" in \*'@@'\*/.test(bootstrap)
      || !/case "\$VM_UUID" in \*'@@'\*/.test(bootstrap)) {
    failures.push('unmaterialized VM identity placeholders must fail closed without self-substitution');
  }
  if (!/labview-benchmark-actor\/ubuntu-base-bootstrap@1/.test(bootstrap)) {
    failures.push('bootstrap receipt schema is missing');
  }
  if (!/OnBootSec=30s/.test(bootstrap)
      || !/systemctl restart virtualbox-guest-utils\.service/.test(bootstrap)
      || !/systemctl enable lba-base-bootstrap-receipt\.timer/.test(bootstrap)) {
    failures.push('guest-utils must be revalidated after installer cleanup');
  }
  for (const field of ['"os"', '"vm"', '"tools"', '"services"', '"timings"', '"failures"', '"outcome"']) {
    if (!bootstrap.includes(field)) failures.push(`bootstrap receipt field is missing: ${field}`);
  }

  if (!/--post-install-template/.test(builder)) failures.push('builder must use the unattended post-install template');
  if (!/missing unattended bootstrap template/.test(builder)) failures.push('missing bootstrap template must fail closed');
  if (!/does not support unattended --post-install-template/.test(builder)) {
    failures.push('unsupported VBoxManage bootstrap hook must fail closed');
  }
  if (!/--user-password-file=\$PWFILE/.test(builder)) failures.push('builder must use a private password file');
  if (!/GUEST_PASSWORD_FILE is empty/.test(builder)
      || !/password_mode/.test(builder)
      || !/8#\$password_mode & 077/.test(builder)) {
    failures.push('builder must require a non-empty owner-only password file');
  }
  if (!/run_redacted VBoxManage unattended install/.test(builder)
      || !/\(password\|user-password\|admin-password\)/.test(builder)
      || !/\[:=\]/.test(builder)
      || !/\[redacted\]/.test(builder)) {
    failures.push('VirtualBox credential diagnostics must be redacted');
  }
  if (/--(?:user-|admin-)?password=(?!file)/.test(builder) || /--token=/.test(builder)) {
    failures.push('passwords and tokens must not be passed as CLI values');
  }
  if (!/127\.0\.0\.1,\$SSH_HOST_PORT,,22/.test(builder)) {
    failures.push('SSH NAT forwarding must bind to host loopback');
  }
  if (/--natpf1[^]*0\.0\.0\.0/.test(builder)) failures.push('SSH NAT forwarding must not bind to all interfaces');
  if (builder.indexOf('missing unattended bootstrap template') > builder.indexOf('VBoxManage createvm')
      || builder.indexOf('does not support unattended --post-install-template') > builder.indexOf('VBoxManage createvm')) {
    failures.push('bootstrap mechanism preflight must run before VM creation');
  }
  return { ok: failures.length === 0, failures };
}

function main() {
  const bootstrap = readFileSync(new URL('../cleanroom/ubuntu-labview/base-bootstrap.sh', import.meta.url), 'utf8');
  const builder = readFileSync(new URL('../cleanroom/ubuntu-labview/build-virtualbox.sh', import.meta.url), 'utf8');
  const result = verifyUbuntuBaseBootstrapContract({ bootstrap, builder });
  if (!result.ok) {
    console.error('ubuntu-base-bootstrap contract: FAIL');
    for (const failure of result.failures) console.error(`  - ${failure}`);
    return 1;
  }
  console.log('ubuntu-base-bootstrap contract: PASS');
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
