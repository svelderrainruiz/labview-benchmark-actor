#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { renameSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { selectContainerNetworkTarget } from './experiment-core.mjs';
import { probeTcpEndpoint } from './tcp-relay.mjs';

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || argv[i + 1] === undefined) throw new Error(`invalid argument near '${argv[i] ?? ''}'`);
    args[argv[i].slice(2)] = argv[i + 1];
  }
  return args;
}

function atomicJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temp, file);
}

async function docker(args, timeout = 15_000) {
  return execFileAsync('docker', args, { timeout, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const containerId = args['container-id'];
  const output = args.output;
  const timeoutMs = Number(args['timeout-ms'] ?? 5000);
  if (!/^[a-f0-9]{64}$/i.test(containerId ?? '')) throw new Error('network preflight requires the immutable 64-hex container ID');
  if (!output) throw new Error('network preflight requires --output');
  let record = {
    schema: 'labview-benchmark-actor/windows-docker-network-preflight@1',
    status: 'failed',
    containerId,
    wallTime: new Date().toISOString(),
    classification: 'container-network-inspection-failed',
  };
  try {
    const [{ stdout: inspectStdout }, { stdout: portStdout }] = await Promise.all([
      docker(['container', 'inspect', containerId]),
      docker(['port', containerId]),
    ]);
    const inspection = JSON.parse(inspectStdout)[0];
    const selected = selectContainerNetworkTarget(inspection, { expectedContainerId: containerId });
    const dockerPortOutput = portStdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (dockerPortOutput.length !== 0) throw new Error(`container has Docker port output: ${dockerPortOutput.join(', ')}`);
    const directProbe = await probeTcpEndpoint({ host: selected.target.ipAddress, port: 5900, timeoutMs });
    record = {
      ...record,
      target: selected.target,
      dockerPublishedPorts: selected.publishedPorts,
      dockerPortOutput,
      directProbe: {
        ...directProbe,
        endpoint: `${selected.target.ipAddress}:5900`,
        clock: 'host process.hrtime.bigint',
      },
    };
    if (!directProbe.connected) {
      record.classification = 'host-to-container-route-unavailable';
      record.error = directProbe.error?.message ?? 'host TCP probe did not connect';
      atomicJson(output, record);
      return 2;
    }
    record.status = 'passed';
    record.classification = null;
    atomicJson(output, record);
    return 0;
  } catch (error) {
    record.error = error.message;
    atomicJson(output, record);
    return 2;
  }
}

process.exitCode = await main().catch((error) => {
  console.error(`network-preflight: ${error.message}`);
  return 2;
});
