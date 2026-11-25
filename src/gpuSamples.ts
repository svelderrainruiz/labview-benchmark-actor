/**
 * GPU samples for a capture (#134 slice 2) and the automatic GPU agent cues (#134 slice 3).
 *
 * While a capture runs, a ONE-SHOT `nvidia-smi --query-gpu=timestamp,utilization.gpu,memory.used,power.draw` runs
 * per sample at the CPU/RAM/disk sampler's 100 ms cadence. The sample time is nvidia-smi's own `timestamp` column
 * (local 'yyyy/MM/dd HH:mm:ss.fff', converted to epoch ms: the CPU/RAM/disk sampler's axis), never the time the
 * output arrived (#134: nvidia-smi's own `-lms` loop buffers its output on Windows and loses the tail when
 * killed). The GPU identity (index + name) is recorded once. A missing nvidia-smi, or a failure, marks the
 * series unavailable WITH the reason: a reading that is not there is never written as zero. Parsing and cue
 * detection are pure functions.
 */
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

export const NVIDIA_SMI_QUERY_ARGS: readonly string[] = [
  '--query-gpu=timestamp,utilization.gpu,memory.used,power.draw',
  '--format=csv,noheader,nounits'
];
export const NVIDIA_SMI_IDENTITY_ARGS: readonly string[] = ['--query-gpu=index,name', '--format=csv,noheader'];
export const GPU_SERIES_SCHEMA = 'labview-benchmark-actor/gpu-series@v1';
export const GPU_HEADER_FILE = 'gpu.json';
export const GPU_SAMPLES_FILE = 'gpu.jsonl';
export const DEFAULT_GPU_SAMPLE_INTERVAL_MS = 100;
// #134 laptop measurement: a 0.33 s generation peaked at 17% utilization on Windows, so 10% (not 20%).
export const DEFAULT_GPU_CUE_UTIL_THRESHOLD_PCT = 10;
export const DEFAULT_GPU_CUE_MEMORY_RISE_MB = 100;
export const DEFAULT_GPU_CUE_REARM_MS = 1000;

export interface GpuIdentity {
  index: number;
  name: string;
}
export interface GpuReading {
  index: number;
  utilizationPct: number | null;
  memoryUsedMb: number | null;
  powerW: number | null;
}
export interface GpuSample {
  ms: number;
  gpus: GpuReading[];
}
export type GpuParse<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * How late nvidia-smi's `utilization.gpu` reports real compute, measured on the #134 hosts (first token vs the
 * first utilization sample over threshold): about 0.45 s on Windows 11 and 0.18-0.38 s on Linux.
 */
export const GPU_UTILIZATION_LAG_MS: Readonly<Record<'win32' | 'linux', { minMs: number; maxMs: number }>> = {
  win32: { minMs: 450, maxMs: 450 },
  linux: { minMs: 180, maxMs: 380 }
};
export interface GpuUtilizationLag {
  platform: 'win32' | 'linux';
  minMs: number;
  maxMs: number;
  source: string;
}
/** The measured utilization lag of a capture platform (`WIN`/`win32`, `LINUX`/`linux`); null when unmeasured. */
export function gpuUtilizationLag(platform: unknown): GpuUtilizationLag | null {
  const key = platform === 'WIN' || platform === 'win32' ? 'win32' : platform === 'LINUX' || platform === 'linux' ? 'linux' : null;
  return key ? { platform: key, ...GPU_UTILIZATION_LAG_MS[key], source: 'measured in #134' } : null;
}
function lagText(lag: GpuUtilizationLag): string {
  const seconds = (ms: number): string => (ms / 1000).toFixed(2).replace(/0$/, '');
  return lag.minMs === lag.maxMs ? `~${seconds(lag.minMs)} s` : `${seconds(lag.minMs)}-${seconds(lag.maxMs)} s`;
}

export interface GpuSeriesHeader {
  schema: typeof GPU_SERIES_SCHEMA;
  source: 'nvidia-smi';
  available: boolean;
  reason?: string;
  gpus: GpuIdentity[];
  sampleCount?: number;
  failedSamples?: number;
  lastError?: string;
}

function rows(text: string): string[] {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function excerpt(line: string): string {
  return line.length > 60 ? `${line.slice(0, 60)}...` : line;
}

/** nvidia-smi's `timestamp` ('yyyy/MM/dd HH:mm:ss.fff', host local time) as epoch ms; undefined when invalid. */
export function parseNvidiaSmiTimestamp(raw: string): number | undefined {
  const match = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(raw.trim());
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const millis = Number((match[7] ?? '0').padEnd(3, '0'));
  const date = new Date(year, month - 1, day, hour, minute, second, millis);
  // Reject impossible dates (2026/02/31 would otherwise roll over into March).
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day || date.getHours() !== hour) return undefined;
  return date.getTime();
}

/** One nvidia-smi csv field: a number, `null` for "[N/A]"/"[Not Supported]", or `undefined` for garbage. */
export function parseNvidiaSmiField(raw: string): number | null | undefined {
  const field = raw.trim();
  if (/^\[?(N\/A|Not Supported|Unknown Error)\]?$/i.test(field)) return null;
  if (!/^-?\d+(\.\d+)?$/.test(field)) return undefined;
  return Number(field);
}

/** Parse `nvidia-smi --query-gpu=index,name --format=csv,noheader` (one line per GPU). */
export function parseNvidiaSmiIdentity(text: string): GpuParse<GpuIdentity[]> {
  const lines = rows(text);
  if (lines.length === 0) return { ok: false, reason: 'nvidia-smi listed no GPUs' };
  const gpus: GpuIdentity[] = [];
  for (const line of lines) {
    const match = /^(\d+)\s*,\s*(\S.*)$/.exec(line);
    if (!match) return { ok: false, reason: `unexpected nvidia-smi GPU line: "${excerpt(line)}"` };
    gpus.push({ index: Number(match[1]), name: match[2].trim() });
  }
  return { ok: true, value: gpus };
}

/**
 * Parse `nvidia-smi --query-gpu=timestamp,utilization.gpu,memory.used,power.draw --format=csv,noheader,nounits`:
 * one line per GPU, in nvidia-smi's enumeration order (the same order as {@link parseNvidiaSmiIdentity}). The
 * sample time is the first row's `timestamp` (epoch ms). "[N/A]" becomes `null` (never 0). A malformed line or
 * timestamp, or a GPU count that differs from `identity`, fails the sample.
 */
export function parseNvidiaSmiQuery(text: string, identity?: readonly GpuIdentity[]): GpuParse<GpuSample> {
  const lines = rows(text);
  if (lines.length === 0) return { ok: false, reason: 'nvidia-smi returned no GPU rows' };
  if (identity && lines.length !== identity.length) {
    return { ok: false, reason: `nvidia-smi returned ${lines.length} GPU rows, expected ${identity.length}` };
  }
  const gpus: GpuReading[] = [];
  let ms: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    const [stamp, ...rest] = lines[i].split(',');
    const at = parseNvidiaSmiTimestamp(stamp);
    const fields = rest.map(parseNvidiaSmiField);
    if (at === undefined || fields.length !== 3 || fields.some((value) => value === undefined)) {
      return { ok: false, reason: `unexpected nvidia-smi row: "${excerpt(lines[i])}"` };
    }
    ms = ms ?? at;
    const [utilizationPct, memoryUsedMb, powerW] = fields as Array<number | null>;
    gpus.push({ index: identity ? identity[i].index : i, utilizationPct, memoryUsedMb, powerW });
  }
  return { ok: true, value: { ms: ms as number, gpus } };
}

export type NvidiaSmiRunner = (args: readonly string[]) => Promise<string>;

/** Run nvidia-smi with an argument array (never a shell string). */
export function nvidiaSmiRunner(command = 'nvidia-smi', timeoutMs = 5000): NvidiaSmiRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(command, [...args], { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
        if (error) reject(error);
        else resolve(String(stdout));
      });
    });
}

function reasonOf(error: unknown): string {
  const err = error as NodeJS.ErrnoException;
  if (err && err.code === 'ENOENT') return 'nvidia-smi not found on PATH';
  return error instanceof Error ? error.message : String(error);
}

export interface GpuSamplerOptions {
  dir: string;
  run: NvidiaSmiRunner;
  now?: () => number;
  intervalMs?: number;
}
export interface GpuSampler {
  /** Resolves once the GPU identity probe finished (header written). */
  readonly ready: Promise<GpuSeriesHeader>;
  /** Stop sampling, wait for an in-flight sample, and write the final header. */
  stop(): Promise<GpuSeriesHeader>;
}

/**
 * Sample the GPUs into `<dir>/gpu.jsonl` (`{ms,gpus}` per line) and describe the series in `<dir>/gpu.json`.
 * Each sample is one one-shot nvidia-smi call, stamped with nvidia-smi's own `timestamp`. Samples never
 * overlap; the next one starts `intervalMs` after the previous one started (`now` only paces the loop), or
 * immediately when nvidia-smi took longer than that.
 */
export function startGpuSampler(options: GpuSamplerOptions): GpuSampler {
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? DEFAULT_GPU_SAMPLE_INTERVAL_MS;
  const headerFile = path.join(options.dir, GPU_HEADER_FILE);
  const samplesFile = path.join(options.dir, GPU_SAMPLES_FILE);
  const header: GpuSeriesHeader = { schema: GPU_SERIES_SCHEMA, source: 'nvidia-smi', available: false, gpus: [] };
  let sampleCount = 0;
  let failedSamples = 0;
  let lastError: string | undefined;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  const writeHeader = (): void => writeFileSync(headerFile, `${JSON.stringify(header, null, 2)}\n`);

  const sampleOnce = async (): Promise<void> => {
    const started = now();
    try {
      const parsed = parseNvidiaSmiQuery(await options.run(NVIDIA_SMI_QUERY_ARGS), header.gpus);
      if (!parsed.ok) throw new Error(parsed.reason);
      appendFileSync(samplesFile, `${JSON.stringify(parsed.value)}\n`);
      sampleCount += 1;
    } catch (error) {
      failedSamples += 1;
      lastError = reasonOf(error);
    }
    if (!stopped) {
      timer = setTimeout(tick, Math.max(0, intervalMs - (now() - started)));
      timer.unref();
    }
  };
  const tick = (): void => {
    inFlight = sampleOnce();
  };

  const ready = (async (): Promise<GpuSeriesHeader> => {
    try {
      const identity = parseNvidiaSmiIdentity(await options.run(NVIDIA_SMI_IDENTITY_ARGS));
      if (identity.ok) {
        header.available = true;
        header.gpus = identity.value;
      } else {
        header.reason = identity.reason;
      }
    } catch (error) {
      header.reason = reasonOf(error);
    }
    writeHeader();
    if (header.available) tick();
    return { ...header };
  })();

  return {
    ready,
    async stop(): Promise<GpuSeriesHeader> {
      await ready;
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
      if (header.available) {
        header.sampleCount = sampleCount;
        header.failedSamples = failedSamples;
        if (lastError !== undefined) header.lastError = lastError;
        if (sampleCount === 0) {
          header.available = false;
          header.reason = `no GPU sample succeeded (${String(lastError)})`;
        }
      }
      writeHeader();
      return { ...header };
    }
  };
}

export interface GpuSeries {
  header: GpuSeriesHeader;
  samples: GpuSample[];
}

/** Read a capture's GPU series; `null` when the capture predates GPU sampling (no gpu.json). */
export function readGpuSeries(dir: string): GpuSeries | null {
  const headerFile = path.join(dir, GPU_HEADER_FILE);
  if (!existsSync(headerFile)) return null;
  let header: GpuSeriesHeader;
  try {
    header = JSON.parse(readFileSync(headerFile, 'utf8')) as GpuSeriesHeader;
  } catch (error) {
    return {
      header: { schema: GPU_SERIES_SCHEMA, source: 'nvidia-smi', available: false, reason: `gpu.json unreadable: ${reasonOf(error)}`, gpus: [] },
      samples: []
    };
  }
  const samples: GpuSample[] = [];
  const samplesFile = path.join(dir, GPU_SAMPLES_FILE);
  if (header.available && existsSync(samplesFile)) {
    for (const line of rows(readFileSync(samplesFile, 'utf8'))) {
      try {
        const sample = JSON.parse(line) as GpuSample;
        if (Number.isFinite(sample.ms) && Array.isArray(sample.gpus)) samples.push(sample);
      } catch {
        /* a partial last line from an interrupted capture */
      }
    }
  }
  return { header, samples };
}

/** Project a GPU series into the capture.json `gpu` block (each sample also gets `tMs` on the frame axis). */
export function gpuRecordBlock(series: GpuSeries, startMs: number): Record<string, unknown> {
  const { header } = series;
  return {
    schema: GPU_SERIES_SCHEMA,
    source: header.source,
    available: header.available,
    ...(header.reason ? { reason: header.reason } : {}),
    gpus: header.gpus,
    sampleCount: series.samples.length,
    ...(header.failedSamples ? { failedSamples: header.failedSamples } : {}),
    samples: series.samples.map((sample) => ({ tMs: sample.ms - startMs, ms: sample.ms, gpus: sample.gpus }))
  };
}

/**
 * Attach a GPU series to an assembled launch-capture record (additive): `record.gpu` carries the series, and
 * every frame gets `gpus` from the GPU sample nearest its instant. Frames are untouched when the series is
 * unavailable, so an old capture (no series) and a GPU-less host both keep their frames byte-identical.
 */
export function attachGpuSeries(record: { startMs?: unknown; frames: Array<Record<string, unknown>>; [k: string]: unknown }, series: GpuSeries | null): void {
  if (!series) return;
  const startMs = typeof record.startMs === 'number' && Number.isFinite(record.startMs) ? record.startMs : 0;
  record.gpu = gpuRecordBlock(series, startMs);
  if (!series.header.available || series.samples.length === 0) return;
  let j = 0;
  for (const frame of record.frames) {
    const at = startMs + Number(frame.tMs);
    if (!Number.isFinite(at)) continue;
    while (j + 1 < series.samples.length && Math.abs(series.samples[j + 1].ms - at) <= Math.abs(series.samples[j].ms - at)) j += 1;
    frame.gpus = series.samples[j].gpus;
  }
}

export interface GpuCue {
  ms: number;
  edge: 'model-load' | 'compute';
  gpuIndex: number;
  label: string;
  /** The capture platform's measured nvidia-smi utilization lag (null when unmeasured). */
  utilizationLag: GpuUtilizationLag | null;
}
export interface GpuCueOptions {
  utilThresholdPct?: number;
  memoryRiseMb?: number;
  rearmMs?: number;
  /** Capture platform (`WIN`/`LINUX` plane or `win32`/`linux`) for the measured utilization lag. */
  platform?: unknown;
}

/**
 * Rising edges of `value(sample) > level` with time debounce: an edge needs the signal to have been below the
 * level first, and after an edge the detector re-arms only once the signal stayed below for `rearmMs`. A noisy
 * signal around the level therefore yields one edge, not one per sample. `null` readings are skipped.
 */
export function risingEdges(points: ReadonlyArray<{ ms: number; value: number | null }>, above: (value: number) => boolean, rearmMs: number): number[] {
  const edges: number[] = [];
  let armed: boolean | undefined;
  let belowSince: number | undefined;
  for (const point of points) {
    if (point.value === null || !Number.isFinite(point.value)) continue;
    if (above(point.value)) {
      if (armed === true) edges.push(point.ms);
      armed = false;
      belowSince = undefined;
      continue;
    }
    if (armed === undefined) {
      armed = true;
      continue;
    }
    belowSince = belowSince ?? point.ms;
    if (!armed && point.ms - belowSince >= rearmMs) armed = true;
  }
  return edges;
}

/**
 * The two automatic GPU agent cues (#134 slice 3, measured in #134): `memory.used` rising more than
 * `memoryRiseMb` above the capture's first sample ("model load", the primary edge: it leads compute), and
 * `utilization.gpu` rising through `utilThresholdPct` ("compute", which nvidia-smi reports late: ~0.45 s on
 * Windows, 0.18-0.38 s on Linux; the platform's lag rides on every cue and in the compute label).
 * Per GPU, sorted by time.
 */
export function gpuCues(samples: readonly GpuSample[], options: GpuCueOptions = {}): GpuCue[] {
  const utilThresholdPct = options.utilThresholdPct ?? DEFAULT_GPU_CUE_UTIL_THRESHOLD_PCT;
  const memoryRiseMb = options.memoryRiseMb ?? DEFAULT_GPU_CUE_MEMORY_RISE_MB;
  const rearmMs = options.rearmMs ?? DEFAULT_GPU_CUE_REARM_MS;
  const utilizationLag = gpuUtilizationLag(options.platform);
  const computeNote = utilizationLag ? `compute, util lags ${lagText(utilizationLag)}` : 'compute';
  const indices = [...new Set(samples.flatMap((s) => s.gpus.map((g) => g.index)))].sort((a, b) => a - b);
  const cues: GpuCue[] = [];
  for (const gpuIndex of indices) {
    const prefix = indices.length > 1 ? `GPU ${gpuIndex}` : 'GPU';
    const series = (field: 'utilizationPct' | 'memoryUsedMb') =>
      samples.map((s) => ({ ms: s.ms, value: s.gpus.find((g) => g.index === gpuIndex)?.[field] ?? null }));
    const memory = series('memoryUsedMb');
    const baseline = memory.find((p) => p.value !== null && Number.isFinite(p.value))?.value;
    if (baseline !== undefined && baseline !== null) {
      for (const ms of risingEdges(memory, (v) => v - baseline > memoryRiseMb, rearmMs)) {
        cues.push({ ms, edge: 'model-load', gpuIndex, label: `${prefix} memory rose >${memoryRiseMb} MiB above start (model load)`, utilizationLag });
      }
    }
    for (const ms of risingEdges(series('utilizationPct'), (v) => v >= utilThresholdPct, rearmMs)) {
      cues.push({ ms, edge: 'compute', gpuIndex, label: `${prefix} rose above ${utilThresholdPct}% (${computeNote})`, utilizationLag });
    }
  }
  return cues.sort((a, b) => a.ms - b.ms || a.gpuIndex - b.gpuIndex);
}
