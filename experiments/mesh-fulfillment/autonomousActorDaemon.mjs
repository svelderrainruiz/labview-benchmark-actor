#!/usr/bin/env node

import { execFile as execFileCallback, spawn as spawnProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  createAutonomousActorService,
  createCommandWorkloadAdapter,
} from './autonomousActorService.mjs';

export const DAEMON_CONFIG_SCHEMA = 'labview-benchmark-actor/autonomous-actor-service-config@1';
export const BUS_SCHEMA = 'labview-benchmark-actor/bus-msg@1';
export const CURSOR_SCHEMA = 'labview-benchmark-actor/autonomous-actor-log-cursor@1';
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_BATCH_BYTES = 4 * MAX_FRAME_BYTES;
const execFileAsync = promisify(execFileCallback);

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

function resolveFrom(base, path) {
  if (typeof path !== 'string' || !path) throw new Error('configured path is required');
  return isAbsolute(path) ? path : resolve(base, path);
}

export function parseBusRequest(busEnvelope) {
  if (busEnvelope?.schema !== BUS_SCHEMA || busEnvelope.type !== 'CLAIM') return null;
  if (typeof busEnvelope.payload !== 'string' || Buffer.byteLength(busEnvelope.payload, 'utf8') > MAX_FRAME_BYTES) return null;
  let requestEnvelope;
  try { requestEnvelope = JSON.parse(busEnvelope.payload); }
  catch { return null; }
  const request = requestEnvelope?.request;
  if (typeof request?.taskId !== 'string' || busEnvelope.task !== request.taskId) return null;
  if (typeof request?.requesterId !== 'string' || typeof busEnvelope.senderId !== 'string'
    || busEnvelope.senderId.toUpperCase() !== request.requesterId.toUpperCase()) return null;
  return requestEnvelope;
}

function loadCursor(path) {
  if (!existsSync(path)) return 0;
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (value?.schema !== CURSOR_SCHEMA || !Number.isInteger(value.offset) || value.offset < 0) throw new Error('actor log cursor is malformed');
  return value.offset;
}

export function createBusLogPump({ logPath, cursorPath, service, sendResponse } = {}) {
  if (!logPath || !cursorPath || typeof service?.handleRequest !== 'function' || typeof sendResponse !== 'function') {
    throw new Error('logPath, cursorPath, service, and sendResponse are required');
  }
  let offset = loadCursor(cursorPath);
  let pumping = false;

  async function pumpOnce() {
    if (pumping || !existsSync(logPath)) return { processed: 0, offset };
    pumping = true;
    try {
      const size = statSync(logPath).size;
      if (size < offset) offset = 0;
      const bytesToRead = Math.min(size - offset, MAX_BATCH_BYTES);
      if (bytesToRead <= 0) return { processed: 0, offset };
      const buffer = Buffer.alloc(bytesToRead);
      const file = openSync(logPath, 'r');
      let bytesRead;
      try { bytesRead = readSync(file, buffer, 0, bytesToRead, offset); }
      finally { closeSync(file); }
      const chunk = buffer.subarray(0, bytesRead);
      const finalNewline = chunk.lastIndexOf(0x0a);
      if (finalNewline < 0) {
        if (chunk.length > MAX_FRAME_BYTES) throw new Error('unterminated bus log entry exceeds one frame');
        return { processed: 0, offset };
      }
      const consumed = chunk.subarray(0, finalNewline + 1);
      const lines = consumed.toString('utf8').split('\n').filter((line) => line.trim());
      let processed = 0;
      const deliveries = lines.map(async (line) => {
        let busEnvelope;
        try { busEnvelope = JSON.parse(line); }
        catch { return; }
        const requestEnvelope = parseBusRequest(busEnvelope);
        if (!requestEnvelope) return;
        const responseEnvelope = await service.handleRequest(requestEnvelope);
        await sendResponse(responseEnvelope);
        processed += 1;
      });
      await Promise.all(deliveries);
      offset += consumed.length;
      atomicJson(cursorPath, { schema: CURSOR_SCHEMA, offset });
      return { processed, offset };
    } finally {
      pumping = false;
    }
  }

  return { pumpOnce, inspect: () => ({ offset, pumping }) };
}

export function createLbabusSender({ lbabusPath, hosts, tcpPort = 7420, session = 'autonomous-actors', runtimeDir, actorId } = {}, { execFile = execFileAsync } = {}) {
  if (!lbabusPath || !hosts || !runtimeDir || !actorId) throw new Error('lbabusPath, hosts, runtimeDir, and actorId are required');
  mkdirSync(runtimeDir, { recursive: true });
  return async (responseEnvelope) => {
    const status = responseEnvelope?.response?.status;
    const type = status === 'SUCCESS' || status === 'FAILED' ? 'DONE' : 'ACK';
    const messageFile = join(runtimeDir, `response-${randomUUID()}.json`);
    writeFileSync(messageFile, `${JSON.stringify(responseEnvelope)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      await execFile(lbabusPath, [
        'net', 'send', '--hosts', hosts, '--tcp', String(tcpPort), '--session', session,
        '--type', type, '--task', responseEnvelope.response.taskId, '--message-file', messageFile,
      ], {
        timeout: 30_000,
        maxBuffer: MAX_FRAME_BYTES,
        windowsHide: true,
        shell: false,
        env: { ...process.env, VIHS_COLLAB_AGENT: actorId },
      });
    } finally {
      try { unlinkSync(messageFile); } catch { /* best-effort runtime cleanup */ }
    }
  };
}

export function loadDaemonConfig(configPath, { execFile = execFileAsync } = {}) {
  const absoluteConfig = resolve(configPath);
  const base = dirname(absoluteConfig);
  const config = JSON.parse(readFileSync(absoluteConfig, 'utf8'));
  if (config?.schema !== DAEMON_CONFIG_SCHEMA) throw new Error(`daemon config schema must be ${DAEMON_CONFIG_SCHEMA}`);
  const privateKeyPem = readFileSync(resolveFrom(base, config.privateKeyPath), 'utf8');
  const requesterKeys = JSON.parse(readFileSync(resolveFrom(base, config.requesterKeysPath), 'utf8'));
  const bus = config.bus ?? {};
  const workloads = Object.fromEntries(Object.entries(config.workloads ?? {}).map(([id, spec]) => [
    id,
    createCommandWorkloadAdapter({
      ...spec,
      cwd: spec.cwd ? resolveFrom(base, spec.cwd) : undefined,
      executable: spec.executable,
    }, { execFile }),
  ]));
  return {
    actorId: config.actorId,
    plane: config.plane,
    privateKeyPem,
    requesterKeys,
    expectedCandidate: config.expectedCandidate,
    statePath: resolveFrom(base, config.statePath),
    artifactDir: resolveFrom(base, config.artifactDir),
    workloads,
    bus: {
      lbabusPath: resolveFrom(base, bus.lbabusPath),
      logPath: resolveFrom(base, bus.logPath),
      cursorPath: resolveFrom(base, bus.cursorPath),
      runtimeDir: resolveFrom(base, bus.runtimeDir),
      hosts: bus.hosts,
      tcpPort: bus.tcpPort ?? 7420,
      bind: bus.bind ?? '0.0.0.0',
      session: bus.session ?? 'autonomous-actors',
      pollMs: bus.pollMs ?? 250,
    },
  };
}

export async function startAutonomousActorDaemon(config, { spawn = spawnProcess, execFile = execFileAsync, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
  const service = createAutonomousActorService(config);
  const sender = createLbabusSender({ ...config.bus, actorId: config.actorId }, { execFile });
  const pump = createBusLogPump({ ...config.bus, service, sendResponse: sender });
  mkdirSync(dirname(config.bus.logPath), { recursive: true });
  const listener = spawn(config.bus.lbabusPath, [
    'net', 'listen', '--tcp', String(config.bus.tcpPort), '--bind', config.bus.bind,
    '--session', config.bus.session, '--log', config.bus.logPath,
  ], {
    stdio: 'inherit',
    windowsHide: true,
    shell: false,
    env: { ...process.env, VIHS_COLLAB_AGENT: config.actorId },
  });
  const interrupted = service.recoverInterrupted();
  if (interrupted) await sender(interrupted);
  await pump.pumpOnce();
  const timer = setIntervalFn(() => { void pump.pumpOnce().catch((error) => console.error(`[autonomous-actor] pump failed: ${error.message}`)); }, config.bus.pollMs);
  const stop = () => {
    clearIntervalFn(timer);
    if (!listener.killed) listener.kill();
  };
  return { service, pump, listener, stop };
}

function configArgument(argv) {
  const index = argv.indexOf('--config');
  return index >= 0 ? argv[index + 1] : null;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const configPath = configArgument(process.argv.slice(2));
  if (!configPath) {
    console.error('usage: node autonomousActorDaemon.mjs --config <actor-service.json>');
    process.exitCode = 2;
  } else {
    const daemon = await startAutonomousActorDaemon(loadDaemonConfig(configPath));
    console.error(`[autonomous-actor] ${daemon.service.inspect().actorId} listening on ${daemon.listener.pid}`);
    process.once('SIGINT', () => { daemon.stop(); process.exitCode = 130; });
    process.once('SIGTERM', () => { daemon.stop(); });
  }
}