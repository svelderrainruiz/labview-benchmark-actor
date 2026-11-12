import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync, Stats } from 'node:fs';
import * as path from 'node:path';
import { crc32 } from 'node:zlib';

import { ActiveCaptureSession, validateActiveCaptureSession } from '../captureSession';

const RUN_ID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const RUN_DIRECTORY_PATTERN = new RegExp(`^run-(${RUN_ID_PATTERN})$`, 'i');
const MAX_SESSIONS = 20;
const MAX_BATCH_SIZE = 12;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_SAMPLE_LOG_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_FILE_BYTES = 16 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export interface McpResourceDescriptor {
  uri: string;
  name: string;
  mimeType: string;
  description: string;
}

export interface McpResourceContents {
  uri: string;
  mimeType: string;
  text?: string;
  blob?: string;
}

export interface ActiveCaptureResourceProvider {
  listResources(): McpResourceDescriptor[];
  readResource(uri: string): McpResourceContents[];
}

class ResourceUnavailableError extends Error {}

function unchangedFile(before: Stats, after: Stats): boolean {
  return after.isFile() && before.dev === after.dev && before.ino === after.ino &&
    before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

function safeReadFile(filePath: string, maximumBytes: number): Buffer | null {
  let descriptor: number | undefined;
  try {
    const before = lstatSync(filePath);
    if (!before.isFile() || before.isSymbolicLink() || before.size > maximumBytes) return null;
    descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW as number));
    const opened = fstatSync(descriptor);
    if (!unchangedFile(before, opened)) return null;
    const data = Buffer.alloc(opened.size + 1);
    let bytesRead = 0;
    while (bytesRead < data.length) {
      const count = readSync(descriptor, data, bytesRead, data.length - bytesRead, bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead !== opened.size || !unchangedFile(opened, fstatSync(descriptor))) return null;
    return data.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function validPng(data: Buffer): boolean {
  if (data.length < 45 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  let offset = 8;
  let first = true;
  let sawIdat = false;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('ascii', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (!/^[A-Za-z]{4}$/.test(type) || end > data.length) return false;
    if (crc32(data.subarray(offset + 4, offset + 8 + length)) !== data.readUInt32BE(offset + 8 + length)) return false;
    if (first) {
      if (type !== 'IHDR' || length !== 13) return false;
      const width = data.readUInt32BE(offset + 8);
      const height = data.readUInt32BE(offset + 12);
      if (width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 50000000) return false;
      first = false;
    } else if (type === 'IHDR') {
      return false;
    }
    if (type === 'IDAT') sawIdat = true;
    if (type === 'IEND') return length === 0 && sawIdat && end === data.length;
    offset = end;
  }
  return false;
}

function finiteMetric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function projectSample(value: unknown, sequence: number): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sample = value as Record<string, unknown>;
  const ms = finiteMetric(sample.ms);
  if (ms === null || ms < 0) return null;
  const disks = Array.isArray(sample.disks)
    ? sample.disks.slice(0, 32).flatMap((raw) => {
        if (!raw || typeof raw !== 'object') return [];
        const disk = raw as Record<string, unknown>;
        if (typeof disk.name !== 'string' || !/^[A-Za-z0-9 _.-]{1,64}$/.test(disk.name)) return [];
        return [{
          name: disk.name,
          writeMBs: finiteMetric(disk.writeMBs),
          readMBs: finiteMetric(disk.readMBs)
        }];
      })
    : [];
  return {
    sequence,
    capturedAt: new Date(ms).toISOString(),
    cpuPct: finiteMetric(sample.cpuPct),
    ramMb: finiteMetric(sample.ramMb),
    diskPct: finiteMetric(sample.diskPct),
    disks
  };
}

function readSamples(directory: string, after: number, limit: number): {
  records: Array<Record<string, unknown>>;
  watermark: number;
  invalidSequences: number[];
  partialTail: boolean;
  unavailable: boolean;
} {
  const filePath = path.join(directory, 'resources.jsonl');
  let data: Buffer | null;
  try {
    if (!lstatSync(filePath).isFile()) return { records: [], watermark: 0, invalidSequences: [], partialTail: false, unavailable: true };
    data = safeReadFile(filePath, MAX_SAMPLE_LOG_BYTES);
  } catch {
    return { records: [], watermark: 0, invalidSequences: [], partialTail: false, unavailable: true };
  }
  if (!data) return { records: [], watermark: 0, invalidSequences: [], partialTail: false, unavailable: true };
  const text = data.toString('utf8');
  const partialTail = text.length > 0 && !text.endsWith('\n');
  const lines = text.split('\n');
  if (partialTail) lines.pop();
  const records: Array<Record<string, unknown>> = [];
  const invalidSequences: number[] = [];
  let sequence = 0;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    sequence += 1;
    try {
      const projected = projectSample(JSON.parse(line), sequence);
      if (!projected) invalidSequences.push(sequence);
      else if (sequence > after && records.length < limit) records.push(projected);
    } catch {
      invalidSequences.push(sequence);
    }
  }
  return { records, watermark: sequence, invalidSequences, partialTail, unavailable: false };
}

function frameSequences(directory: string): { sequences: number[]; unsafe: number[] } {
  const sequences: number[] = [];
  const unsafe: number[] = [];
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return { sequences, unsafe };
  }
  for (const entry of entries) {
    const match = /^frame-(\d+)\.png$/.exec(entry.name);
    if (!match) continue;
    const sequence = Number(match[1]);
    if (!Number.isSafeInteger(sequence) || sequence < 1) continue;
    if (!entry.isFile()) unsafe.push(sequence);
    else sequences.push(sequence);
  }
  sequences.sort((a, b) => a - b);
  return { sequences, unsafe };
}

function rootDirectory(configuredRoot: string): string | null {
  if (!configuredRoot) return null;
  try {
    const resolved = realpathSync(configuredRoot);
    return lstatSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

function loadSession(root: string, runId: string): { directory: string; session: ActiveCaptureSession } | null {
  if (!new RegExp(`^${RUN_ID_PATTERN}$`, 'i').test(runId)) return null;
  const directory = path.join(root, `run-${runId}`);
  try {
    const dirStat = lstatSync(directory);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return null;
    const beacon = safeReadFile(path.join(directory, 'active-capture-session.json'), MAX_SESSION_FILE_BYTES);
    if (!beacon) return null;
    const session = validateActiveCaptureSession(JSON.parse(beacon.toString('utf8')), runId);
    return session ? { directory, session } : null;
  } catch {
    return null;
  }
}

function parseCursor(params: URLSearchParams, name: string, fallback: number, maximum: number): number {
  const values = params.getAll(name);
  if (values.length > 1) throw new ResourceUnavailableError();
  if (values.length === 0) return fallback;
  if (!/^\d+$/.test(values[0])) throw new ResourceUnavailableError();
  const parsed = Number(values[0]);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) throw new ResourceUnavailableError();
  return parsed;
}

function jsonContents(uri: string, value: unknown): McpResourceContents[] {
  return [{ uri, mimeType: 'application/json', text: JSON.stringify(value) }];
}

function frameGaps(sequences: number[], after: number, watermark: number): Array<{ from: number; to: number }> {
  const gaps: Array<{ from: number; to: number }> = [];
  let expected = after + 1;
  for (const sequence of sequences) {
    if (sequence <= after) continue;
    if (sequence > expected && gaps.length < MAX_BATCH_SIZE) gaps.push({ from: expected, to: sequence - 1 });
    expected = sequence + 1;
  }
  if (watermark >= expected && gaps.length < MAX_BATCH_SIZE) gaps.push({ from: expected, to: watermark });
  return gaps;
}

export function createActiveCaptureResourceProvider(configuredRoot: string): ActiveCaptureResourceProvider {
  function sessions(): Array<{ directory: string; session: ActiveCaptureSession }> {
    const root = rootDirectory(configuredRoot);
    if (!root) return [];
    try {
      return readdirSync(root, { withFileTypes: true })
        .flatMap((entry) => {
          const match = RUN_DIRECTORY_PATTERN.exec(entry.name);
          if (!match || !entry.isDirectory()) return [];
          const session = loadSession(root, match[1]);
          return session ? [session] : [];
        })
        .sort((a, b) => Date.parse(b.session.startedAt) - Date.parse(a.session.startedAt))
        .slice(0, MAX_SESSIONS);
    } catch {
      return [];
    }
  }

  return {
    listResources(): McpResourceDescriptor[] {
      return sessions().map(({ session }) => ({
        uri: `lba-capture://session/${session.runId}`,
        name: `Active capture ${session.runId}`,
        mimeType: 'application/json',
        description: `Read-only ${session.state} capture session metadata and evidence watermarks.`
      }));
    },

    readResource(uri: string): McpResourceContents[] {
      const sessionMatch = new RegExp(`^lba-capture://session/(${RUN_ID_PATTERN})$`, 'i').exec(uri);
      const batchMatch = new RegExp(`^lba-capture://session/(${RUN_ID_PATTERN})/batch(?:\\?(.*))?$`, 'i').exec(uri);
      const frameMatch = new RegExp(`^lba-capture://session/(${RUN_ID_PATTERN})/frame/(\\d+)\\?sha256=([0-9a-f]{64})$`, 'i').exec(uri);
      const match = sessionMatch ?? batchMatch ?? frameMatch;
      if (!match) throw new ResourceUnavailableError();
      const runId = match[1];
      const root = rootDirectory(configuredRoot);
      const loaded = root ? loadSession(root, runId) : null;
      if (!loaded) throw new ResourceUnavailableError();
      const { directory, session } = loaded;

      if (sessionMatch) {
        const frames = frameSequences(directory);
        const samples = readSamples(directory, 0, 0);
        const frameWatermark = Math.max(0, ...frames.sequences, ...frames.unsafe);
        return jsonContents(uri, {
          ...session,
          watermarks: { frameSequence: frameWatermark, sampleSequence: samples.watermark },
          incomplete: frames.unsafe.length > 0 || samples.invalidSequences.length > 0 || samples.partialTail || samples.unavailable
        });
      }

      if (batchMatch) {
        const params = new URLSearchParams(batchMatch[2] ?? '');
        for (const key of params.keys()) if (!['afterFrame', 'afterSample', 'limit'].includes(key)) throw new ResourceUnavailableError();
        const afterFrame = parseCursor(params, 'afterFrame', 0, 1000000000);
        const afterSample = parseCursor(params, 'afterSample', 0, 1000000000);
        const limit = parseCursor(params, 'limit', MAX_BATCH_SIZE, MAX_BATCH_SIZE);
        if (limit < 1) throw new ResourceUnavailableError();
        const inventory = frameSequences(directory);
        const frameWatermark = Math.max(0, ...inventory.sequences, ...inventory.unsafe);
        const sampleData = readSamples(directory, afterSample, limit);
        if (afterFrame > frameWatermark || afterSample > sampleData.watermark) throw new ResourceUnavailableError();
        const candidates = inventory.sequences.filter((sequence) => sequence > afterFrame).slice(0, limit);
        const frames: Array<Record<string, unknown>> = [];
        const incompleteFrames = [...inventory.unsafe];
        for (const sequence of candidates) {
          const filePath = path.join(directory, `frame-${String(sequence).padStart(5, '0')}.png`);
          const bytes = safeReadFile(filePath, MAX_FRAME_BYTES);
          if (!bytes || !validPng(bytes)) {
            incompleteFrames.push(sequence);
            continue;
          }
          const sha256 = createHash('sha256').update(bytes).digest('hex');
          let capturedAt: string | null = null;
          try { capturedAt = new Date(lstatSync(filePath).mtimeMs).toISOString(); } catch { /* incomplete timestamp */ }
          frames.push({
            sequence,
            capturedAt,
            sizeBytes: bytes.length,
            sha256,
            uri: `lba-capture://session/${runId}/frame/${sequence}?sha256=${sha256}`
          });
        }
        const gaps = frameGaps(inventory.sequences, afterFrame, frameWatermark);
        const returnedSampleMax = sampleData.records.reduce((max, sample) => Math.max(max, Number(sample.sequence)), afterSample);
        const returnedFrameMax = frames.reduce((max, frame) => Math.max(max, Number(frame.sequence)), afterFrame);
        const incomplete = gaps.length > 0 || incompleteFrames.length > 0 || sampleData.invalidSequences.length > 0 || sampleData.partialTail || sampleData.unavailable;
        return jsonContents(uri, {
          schema: 'active-capture-evidence-batch@1',
          runId,
          state: session.state,
          after: { frame: afterFrame, sample: afterSample },
          next: { frame: returnedFrameMax, sample: returnedSampleMax },
          watermarks: { frame: frameWatermark, sample: sampleData.watermark },
          frames,
          samples: sampleData.records,
          frameGaps: gaps,
          incompleteFrames: [...new Set(incompleteFrames)].sort((a, b) => a - b).slice(0, MAX_BATCH_SIZE),
          incompleteSamples: sampleData.invalidSequences.filter((sequence) => sequence > afterSample).slice(0, MAX_BATCH_SIZE),
          sampleTailIncomplete: sampleData.partialTail,
          sampleLogUnavailable: sampleData.unavailable,
          incomplete
        });
      }

      const sequence = Number(frameMatch![2]);
      if (!Number.isSafeInteger(sequence) || sequence < 1) throw new ResourceUnavailableError();
      const filePath = path.join(directory, `frame-${String(sequence).padStart(5, '0')}.png`);
      const bytes = safeReadFile(filePath, MAX_FRAME_BYTES);
      if (!bytes || !validPng(bytes) || createHash('sha256').update(bytes).digest('hex') !== frameMatch![3].toLowerCase()) {
        throw new ResourceUnavailableError();
      }
      return [{ uri, mimeType: 'image/png', blob: bytes.toString('base64') }];
    }
  };
}