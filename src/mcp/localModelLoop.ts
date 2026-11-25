#!/usr/bin/env node
/**
 * Local-model loop (#134 slice 4): ONE command, no VS Code, on the machine that holds the screen.
 *
 *   1. creates `run-<uuid>/` under the captures root the installed extension reads (capture-meta.json,
 *      active-capture-session.json, capture-status.json, later capture.json), so "Open Benchmark Frame Correlator"
 *      opens it like any extension capture;
 *   2. starts the frame capture (gdigrab on Windows, x11grab on Xorg, or `--source test`: ffmpeg lavfi testsrc),
 *      the CPU/RAM/disk sampler and the GPU sampler, with the extension's own arguments and scripts;
 *   3. after `--lead-ms`, sends the prompt to a local Ollama model THROUGH the bridge (ollamaMcpBridge: the same
 *      MCP discovery and `--allow-tool` allow-list, or no tools with `--no-tools`), streamed, and records "prompt
 *      sent", "first token" (any kind, thinking included), "answer started" and "response done";
 *   4. keeps capturing `--tail-ms`, stops, assembles capture.json with the automatic GPU cues (memory rise = model
 *      load, utilization through the threshold = compute, with the platform's measured lag) and the three agent cues;
 *   5. exports a clip from min(prompt sent, first GPU cue) - 1 s to response done + 1 s into `<capture>/clips/`;
 *   6. prints ONE JSON receipt (metadata, hashes, at most a 200-character response excerpt; never pixels) and
 *      writes it next to the clip.
 *
 * Reference mode (#139 slice 2, `--reference openwebui`): between the lead and the local prompt, the same prompt is
 * streamed through an Open WebUI chat-completions API (cues "reference sent", "reference first token", "reference
 * done" on the same axis) while the laptop GPU sampler keeps running as the idle control; both sides use temperature
 * 0, `--seed` and `--max-tokens`, and the receipt gets one `comparison` block. The token stays in openWebUiReference.
 * Like-for-like (#143): the receipt says whether the reference id is an Open WebUI alias (with tools / default
 * features the server adds to the prompt), and `--no-tools` sends the local model no tools at all.
 *
 * Every process runs through spawn/execFile with an argument array, never a shell string.
 */
import { ChildProcess, execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { assembleCaptureFromDir, CaptureBuilder, LaunchCaptureRecord, readResourceSamples } from '../captureAssemble';
import { ClipRunner, execFileRunner, exportCaptureClip, MISSING_FFMPEG_MESSAGE } from '../captureClip';
import { resolveFfmpegCommand } from '../captureHost';
import { buildAgentCueMarker, loadMarkerImageGrab, MarkerImageGrabFn, writeCaptureRecord } from '../captureMarkers';
import {
  CaptureMetadata, captureFramesPerSecond, defaultCapturesDir, ffmpegFrameCaptureArgs, ffmpegTestSourceArgs,
  parseX11DisplaySize, resourceSamplerCommand, x11DisplayForCapture
} from '../capturePlatform';
import { ActiveCaptureState, buildActiveCaptureSession, newCaptureRunId, writeActiveCaptureSession } from '../captureSession';
import {
  DEFAULT_GPU_CUE_MEMORY_RISE_MB, DEFAULT_GPU_CUE_UTIL_THRESHOLD_PCT, GpuSeriesHeader, NvidiaSmiRunner, nvidiaSmiRunner,
  readGpuSeries, startGpuSampler
} from '../gpuSamples';
import { OLLAMA_DEFAULT_TOOLS } from './benchmarkActorMcpServer';
import { api, BridgeConfig, BridgeHooks, BridgeRun, ChatStreamStats, isObject, runBridge } from './ollamaMcpBridge';
import {
  DEFAULT_REFERENCE_TIMEOUT_MS, nodeTokenFileOps, parseReferenceEndpoint, readTokenFile, redact, ReferenceConfig, ReferenceError,
  REFERENCE_MODEL_ID, ReferenceModelInfo, referencePreflight, ReferenceResult, REFERENCE_KINDS, ReferenceKind, runReferenceChat, TokenFileOps
} from './openWebUiReference';

export const LOOP_RECEIPT_SCHEMA = 'labview-benchmark-actor/local-model-loop@v1';
export const LOOP_DEFAULTS = {
  model: 'qwen2.5vl:3b',
  ollama: 'http://127.0.0.1:11434',
  prompt: 'In two short sentences: what does a GPU do while a language model writes an answer?',
  fps: 4,
  leadMs: 2000,
  tailMs: 3000,
  clipPadMs: 1000,
  maxTurns: 4,
  maxTokens: 256,
  seed: 42
} as const;
export const MAX_LOOP_WAIT_MS = 600_000;
export const RESPONSE_EXCERPT_CHARS = 200;
/** #143: "first token" = the first token of any kind (thinking included); "answer started" = the first content/tool call. */
export const LOOP_CUE_LABELS = { promptSent: 'prompt sent', firstToken: 'first token', answerStarted: 'answer started', responseDone: 'response done' } as const;
export const REFERENCE_CUE_LABELS = {
  sent: 'reference sent', firstToken: 'reference first token', answerStarted: 'reference answer started', done: 'reference done'
} as const;
export const LOOP_COMPARISON_SCHEMA = 'labview-benchmark-actor/local-model-loop-comparison@v1';

/**
 * Exit codes: 2 usage (also a bad --token-file), 3 a prerequisite is missing (also the reference preflight), 4 the
 * capture failed, 5 the model run failed, 6 the clip failed, 7 the reference run failed, 8 the reference timed out.
 */
export const LOOP_EXIT = { usage: 2, prerequisite: 3, capture: 4, model: 5, clip: 6, reference: 7, referenceTimeout: 8 } as const;

export const LOOP_USAGE =
  'usage: node out/mcp/localModelLoop.js [--source desktop|test] [--fps <n>] [--lead-ms <ms>] [--tail-ms <ms>] ' +
  '[--model <name>] [--ollama <url>] [--prompt <text>] [--image <png>] [--allow-tool <name>]... | [--no-tools] [--max-turns <n>] ' +
  '[--cold] [--captures-dir <dir>] [--ffmpeg <path>] [--nvidia-smi <path>] [--gpu-threshold-pct <n>] [--gpu-memory-rise-mb <n>] ' +
  '[--max-tokens <n>] [--seed <n>] [--reference openwebui --endpoint <https url> --token-file <path> --reference-model <id> ' +
  '[--reference-timeout-ms <ms>]]';

/** A loop failure with its exit code; the message is for the operator (no model text, no pixels). */
export class LoopError extends Error {
  constructor(message: string, readonly exitCode: number) {
    super(message);
  }
}

export interface LoopConfig {
  source: 'desktop' | 'test';
  fps: number;
  leadMs: number;
  tailMs: number;
  model: string;
  endpoint: URL;
  prompt: string;
  image?: string;
  allowTools: string[];
  /** #143: offer the local model no tools (the /api/chat body has no `tools` key). */
  noTools: boolean;
  maxTurns: number;
  cold: boolean;
  capturesDir: string;
  ffmpeg?: string;
  nvidiaSmi: string;
  gpuThresholdPct: number;
  gpuMemoryRiseMb: number;
  /** #139: fixed decoding (temperature 0, seed, max tokens); applied when `fixedDecoding` is true. */
  seed: number;
  maxTokens: number;
  /** True in reference mode or when --seed / --max-tokens is given; otherwise Ollama's defaults, as before #139. */
  fixedDecoding: boolean;
  /** #139 reference mode; the token lives only inside `reference.token()`. */
  reference?: ReferenceConfig;
}

function referenceUsage(error: unknown): never {
  if (error instanceof ReferenceError) throw new LoopError(error.message, LOOP_EXIT.usage);
  throw error;
}

function intOption(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new LoopError(`--${name} must be an integer from ${min} through ${max}`, LOOP_EXIT.usage);
  const value = Number(raw);
  if (value < min || value > max) throw new LoopError(`--${name} must be an integer from ${min} through ${max}`, LOOP_EXIT.usage);
  return value;
}

function numberOption(name: string, raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+(\.\d+)?$/.test(raw.trim()) || value <= 0 || value > max) {
    throw new LoopError(`--${name} must be a number above 0 and at most ${max}`, LOOP_EXIT.usage);
  }
  return value;
}

/** Parse and validate the CLI arguments (pure apart from checking that `--image` exists). */
export function parseLoopArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  tokenOps: TokenFileOps = nodeTokenFileOps
): LoopConfig {
  let values: Record<string, string | boolean | string[] | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        source: { type: 'string' }, fps: { type: 'string' }, 'lead-ms': { type: 'string' }, 'tail-ms': { type: 'string' },
        model: { type: 'string' }, ollama: { type: 'string' }, prompt: { type: 'string' }, image: { type: 'string' },
        'allow-tool': { type: 'string', multiple: true }, 'no-tools': { type: 'boolean' }, 'max-turns': { type: 'string' }, cold: { type: 'boolean' },
        'captures-dir': { type: 'string' }, ffmpeg: { type: 'string' }, 'nvidia-smi': { type: 'string' },
        'gpu-threshold-pct': { type: 'string' }, 'gpu-memory-rise-mb': { type: 'string' },
        'max-tokens': { type: 'string' }, seed: { type: 'string' }, reference: { type: 'string' }, endpoint: { type: 'string' },
        'token-file': { type: 'string' }, 'reference-model': { type: 'string' }, 'reference-timeout-ms': { type: 'string' }
      }
    }));
  } catch (error) {
    throw new LoopError((error as Error).message, LOOP_EXIT.usage);
  }
  const text = (name: string): string | undefined => values[name] as string | undefined;
  const source = text('source') ?? 'desktop';
  if (source !== 'desktop' && source !== 'test') throw new LoopError('--source must be desktop or test', LOOP_EXIT.usage);
  let fps: number;
  try {
    fps = text('fps') === undefined ? LOOP_DEFAULTS.fps : captureFramesPerSecond(Number(text('fps')));
  } catch (error) {
    throw new LoopError(`--fps: ${(error as Error).message}`, LOOP_EXIT.usage);
  }
  const model = (text('model') ?? LOOP_DEFAULTS.model).trim();
  if (!model) throw new LoopError('--model must not be empty', LOOP_EXIT.usage);
  const host = text('ollama') ?? LOOP_DEFAULTS.ollama;
  let endpoint: URL;
  try {
    endpoint = new URL(host.includes('://') ? host : `http://${host}`);
  } catch {
    throw new LoopError('--ollama must be an http(s) URL', LOOP_EXIT.usage);
  }
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new LoopError('--ollama must be an http(s) URL', LOOP_EXIT.usage);
  const prompt = text('prompt') ?? LOOP_DEFAULTS.prompt;
  if (!prompt.trim()) throw new LoopError('--prompt must not be empty', LOOP_EXIT.usage);
  const image = text('image');
  if (image !== undefined && (!/\.png$/i.test(image) || !existsSync(image))) {
    throw new LoopError('--image must name an existing .png file', LOOP_EXIT.usage);
  }
  const allowTools = (values['allow-tool'] as string[] | undefined) ?? [];
  if (allowTools.some((name) => !/^[A-Za-z0-9_.-]{1,64}$/.test(name))) throw new LoopError('--allow-tool needs a tool name', LOOP_EXIT.usage);
  const noTools = values['no-tools'] === true;
  if (noTools && allowTools.length > 0) throw new LoopError('--no-tools and --allow-tool exclude each other', LOOP_EXIT.usage);
  const capturesDir = text('captures-dir') ?? defaultCapturesDir(platform, env, home);
  if (!capturesDir.trim()) throw new LoopError('--captures-dir must not be empty', LOOP_EXIT.usage);
  const seed = intOption('seed', text('seed'), LOOP_DEFAULTS.seed, 0, 2_147_483_647);
  const maxTokens = intOption('max-tokens', text('max-tokens'), LOOP_DEFAULTS.maxTokens, 1, 131_072);
  const reference = parseReferenceArgs(text, platform, tokenOps);
  return {
    source,
    fps,
    leadMs: intOption('lead-ms', text('lead-ms'), LOOP_DEFAULTS.leadMs, 0, MAX_LOOP_WAIT_MS),
    tailMs: intOption('tail-ms', text('tail-ms'), LOOP_DEFAULTS.tailMs, 0, MAX_LOOP_WAIT_MS),
    model,
    endpoint,
    prompt,
    ...(image !== undefined ? { image } : {}),
    allowTools,
    noTools,
    maxTurns: intOption('max-turns', text('max-turns'), LOOP_DEFAULTS.maxTurns, 1, 32),
    cold: values.cold === true,
    capturesDir,
    ...(text('ffmpeg') !== undefined ? { ffmpeg: text('ffmpeg') } : {}),
    nvidiaSmi: text('nvidia-smi') ?? 'nvidia-smi',
    gpuThresholdPct: numberOption('gpu-threshold-pct', text('gpu-threshold-pct'), DEFAULT_GPU_CUE_UTIL_THRESHOLD_PCT, 100),
    gpuMemoryRiseMb: numberOption('gpu-memory-rise-mb', text('gpu-memory-rise-mb'), DEFAULT_GPU_CUE_MEMORY_RISE_MB, 1_000_000),
    seed,
    maxTokens,
    fixedDecoding: reference !== undefined || text('seed') !== undefined || text('max-tokens') !== undefined,
    ...(reference ? { reference } : {})
  };
}

/** The reference flags: all four together, or none. The token file is read last, once, after every other check. */
function parseReferenceArgs(text: (name: string) => string | undefined, platform: NodeJS.Platform, tokenOps: TokenFileOps): ReferenceConfig | undefined {
  const kind = text('reference');
  const dependent = ['endpoint', 'token-file', 'reference-model', 'reference-timeout-ms'].filter((name) => text(name) !== undefined);
  if (kind === undefined) {
    if (dependent.length > 0) throw new LoopError(`--${dependent[0]} needs --reference openwebui`, LOOP_EXIT.usage);
    return undefined;
  }
  if (!(REFERENCE_KINDS as readonly string[]).includes(kind)) throw new LoopError(`--reference must be ${REFERENCE_KINDS.join(' or ')}`, LOOP_EXIT.usage);
  for (const name of ['endpoint', 'token-file', 'reference-model']) {
    if (text(name) === undefined) throw new LoopError(`--reference ${kind} needs --${name}`, LOOP_EXIT.usage);
  }
  const model = (text('reference-model') as string).trim();
  if (!REFERENCE_MODEL_ID.test(model)) throw new LoopError('--reference-model needs a model id (e.g. gemma4:e4b)', LOOP_EXIT.usage);
  let endpoint: URL;
  try {
    endpoint = parseReferenceEndpoint(text('endpoint') as string);
  } catch (error) {
    referenceUsage(error);
  }
  const timeoutMs = intOption('reference-timeout-ms', text('reference-timeout-ms'), DEFAULT_REFERENCE_TIMEOUT_MS, 100, 3_600_000);
  let token: () => string;
  try {
    token = readTokenFile(text('token-file') as string, platform, tokenOps);
  } catch (error) {
    referenceUsage(error);
  }
  return { kind: kind as ReferenceKind, endpoint, model, timeoutMs, token };
}

export interface CaptureSourcePlan {
  meta: CaptureMetadata;
  args: string[];
}

/** The frame source: ffmpeg arguments + capture-meta.json for the platform (the extension's own capture argv). */
export function planCaptureSource(
  config: Pick<LoopConfig, 'source' | 'fps'>,
  platform: NodeJS.Platform,
  framePattern: string,
  env: NodeJS.ProcessEnv,
  x11VideoSize?: string
): CaptureSourcePlan {
  const plane: CaptureMetadata['plane'] = platform === 'win32' ? 'WIN' : 'LINUX';
  if (config.source === 'test') {
    return {
      meta: { workload: 'desktop-capture', plane, source: 'ffmpeg-lavfi-testsrc', framesPerSecond: config.fps },
      args: ffmpegTestSourceArgs(framePattern, config.fps)
    };
  }
  if (platform !== 'win32' && platform !== 'linux') {
    throw new LoopError(`desktop capture is supported on Windows and Linux (Xorg), not ${platform}; use --source test`, LOOP_EXIT.prerequisite);
  }
  try {
    return {
      meta: { workload: 'desktop-capture', plane, source: platform === 'win32' ? 'ffmpeg-gdigrab' : 'ffmpeg-x11grab', framesPerSecond: config.fps },
      args: ffmpegFrameCaptureArgs(platform, framePattern, String(config.fps), env, x11VideoSize)
    };
  } catch (error) {
    throw new LoopError(`desktop capture unavailable: ${(error as Error).message}; use --source test`, LOOP_EXIT.prerequisite);
  }
}

export interface OllamaModelInfo {
  ollamaVersion: string;
  name: string;
  digest: string | null;
  sizeBytes: number | null;
  /** /api/show capabilities (e.g. completion, vision, tools); null when this Ollama does not report them. */
  capabilities: string[] | null;
}

/** Ollama is reachable, and the model is pulled: version, digest (/api/tags) and capabilities (/api/show). */
export async function ollamaPreflight(endpoint: URL, model: string): Promise<OllamaModelInfo> {
  const origin = endpoint.origin;
  let version: unknown;
  try {
    version = await api(endpoint, '/api/version');
  } catch {
    throw new LoopError(`Ollama is not reachable at ${origin} (start it with "ollama serve" or pass --ollama <url>)`, LOOP_EXIT.prerequisite);
  }
  if (!isObject(version) || typeof version.version !== 'string') throw new LoopError(`${origin} did not answer like Ollama (/api/version)`, LOOP_EXIT.prerequisite);
  let tags: unknown;
  try {
    tags = await api(endpoint, '/api/tags');
  } catch {
    throw new LoopError(`Ollama at ${origin} did not list its models (/api/tags)`, LOOP_EXIT.prerequisite);
  }
  const models = isObject(tags) && Array.isArray(tags.models) ? tags.models.filter(isObject) : [];
  const wanted = model.includes(':') ? model : `${model}:latest`;
  const hit = models.find((m) => m.name === model || m.model === model || m.name === wanted || m.model === wanted);
  if (!hit) throw new LoopError(`model ${model} is not available on Ollama at ${origin}; pull it first: ollama pull ${model}`, LOOP_EXIT.prerequisite);
  let capabilities: string[] | null = null;
  try {
    const show = await api(endpoint, '/api/show', { model });
    if (isObject(show) && Array.isArray(show.capabilities)) capabilities = show.capabilities.filter((c): c is string => typeof c === 'string');
  } catch {
    /* older Ollama: capabilities unknown, the tools are offered as the bridge does */
  }
  return {
    ollamaVersion: version.version,
    name: model,
    digest: typeof hit.digest === 'string' ? hit.digest : null,
    sizeBytes: typeof hit.size === 'number' ? hit.size : null,
    capabilities
  };
}

export interface LoopInstants {
  promptSentMs?: number;
  /** The first streamed token of any kind (thinking/reasoning, content or tool call). */
  firstTokenMs?: number;
  /** #143: the first content or tool-call token. */
  firstAnswerMs?: number;
  responseDoneMs?: number;
}

export interface LoopClipWindow {
  anchor: 'prompt sent' | 'gpu cue' | 'reference sent';
  startInstantMs: number;
  endInstantMs: number;
  fromFrame: number;
  toFrame: number;
}

/**
 * The clip window on the frame axis: from the earliest of (prompt sent, first GPU cue) minus `padMs` to response
 * done plus `padMs`, widened to whole frames (the last frame at or before the start, the first at or after the end)
 * and clamped to the capture. In reference mode (#139) the window starts at the earliest of reference sent, prompt
 * sent and the first GPU cue, so the clip shows the idle control too.
 */
export function planLoopClip(
  frames: ReadonlyArray<{ tMs?: unknown }>,
  promptSentInstantMs: number,
  responseDoneInstantMs: number,
  gpuCueInstantsMs: readonly number[],
  padMs: number = LOOP_DEFAULTS.clipPadMs,
  referenceSentInstantMs?: number
): LoopClipWindow {
  if (frames.length === 0) throw new LoopError('the capture has no frames to clip', LOOP_EXIT.clip);
  const firstGpu = gpuCueInstantsMs.length > 0 ? Math.min(...gpuCueInstantsMs) : Infinity;
  const reference = referenceSentInstantMs ?? Infinity;
  const anchor = reference < Math.min(promptSentInstantMs, firstGpu) ? 'reference sent' : firstGpu < promptSentInstantMs ? 'gpu cue' : 'prompt sent';
  const startInstantMs = Math.min(promptSentInstantMs, firstGpu, reference) - padMs;
  const endInstantMs = responseDoneInstantMs + padMs;
  const times = frames.map((f) => Number(f.tMs));
  let fromFrame = 0;
  times.forEach((t, i) => {
    if (t <= startInstantMs) fromFrame = i;
  });
  let toFrame = times.findIndex((t) => t >= endInstantMs);
  if (toFrame < 0) toFrame = frames.length - 1;
  return { anchor, startInstantMs, endInstantMs, fromFrame, toFrame: Math.max(fromFrame, toFrame) };
}

function epochCueMarkers(
  record: LaunchCaptureRecord, steps: ReadonlyArray<[number | undefined, string]>, kind: string, grab: MarkerImageGrabFn, createdAt?: string
): Array<Record<string, unknown>> {
  const startMs = Number(record.startMs);
  const out: Array<Record<string, unknown>> = [];
  for (const [at, label] of steps) {
    if (at === undefined) continue;
    const view = { ...record, markers: [...(Array.isArray(record.markers) ? record.markers : []), ...out] };
    const marker = buildAgentCueMarker(view, { instantMs: at - startMs, label, ...(createdAt ? { createdAt } : {}) }, grab);
    out.push({ ...marker, source: { kind, epochMs: at } });
  }
  return out;
}

/** The loop cues as agent-cue markers on the frame axis, in time order (missing instants are skipped). */
export function loopCueMarkers(record: LaunchCaptureRecord, instants: LoopInstants, grab: MarkerImageGrabFn, createdAt?: string): Array<Record<string, unknown>> {
  return epochCueMarkers(record, [
    [instants.promptSentMs, LOOP_CUE_LABELS.promptSent],
    [instants.firstTokenMs, LOOP_CUE_LABELS.firstToken],
    [instants.firstAnswerMs, LOOP_CUE_LABELS.answerStarted],
    [instants.responseDoneMs, LOOP_CUE_LABELS.responseDone]
  ], 'local-model-loop', grab, createdAt);
}

/** #139: the reference cues (source kind `openwebui-reference`), same axis and image grab as the loop cues. */
export function referenceCueMarkers(record: LaunchCaptureRecord, instants: LoopInstants, grab: MarkerImageGrabFn, createdAt?: string): Array<Record<string, unknown>> {
  return epochCueMarkers(record, [
    [instants.promptSentMs, REFERENCE_CUE_LABELS.sent],
    [instants.firstTokenMs, REFERENCE_CUE_LABELS.firstToken],
    [instants.firstAnswerMs, REFERENCE_CUE_LABELS.answerStarted],
    [instants.responseDoneMs, REFERENCE_CUE_LABELS.done]
  ], 'openwebui-reference', grab, createdAt);
}

export interface GpuWindowStats {
  fromEpochMs: number;
  toEpochMs: number;
  sampleCount: number;
  maxUtilizationPct: number | null;
  meanUtilizationPct: number | null;
  memoryUsedMb: { min: number | null; max: number | null };
  /** Utilization stayed under the threshold and memory rose less than the rise (null without samples). */
  idle: boolean | null;
}

/** GPU utilization and memory over an epoch-ms window, all GPUs together (the #139 idle control and the VRAM peak). */
export function gpuWindowStats(
  samples: ReadonlyArray<{ ms: number; gpus: ReadonlyArray<{ utilizationPct: number | null; memoryUsedMb: number | null }> }>,
  fromEpochMs: number, toEpochMs: number, thresholdPct: number, memoryRiseMb: number
): GpuWindowStats {
  const inside = samples.filter((s) => s.ms >= fromEpochMs && s.ms <= toEpochMs);
  const utils = inside.flatMap((s) => s.gpus.map((g) => g.utilizationPct)).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const mems = inside.flatMap((s) => s.gpus.map((g) => g.memoryUsedMb)).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const max = (v: number[]): number | null => (v.length ? Math.max(...v) : null);
  const min = (v: number[]): number | null => (v.length ? Math.min(...v) : null);
  const memMin = min(mems);
  const memMax = max(mems);
  const utilMax = max(utils);
  return {
    fromEpochMs,
    toEpochMs,
    sampleCount: inside.length,
    maxUtilizationPct: utilMax,
    meanUtilizationPct: utils.length ? round2(utils.reduce((a, b) => a + b, 0) / utils.length) : null,
    memoryUsedMb: { min: memMin, max: memMax },
    idle: inside.length === 0 ? null : (utilMax ?? 0) < thresholdPct && (memMax ?? 0) - (memMin ?? 0) < memoryRiseMb
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface PhaseSide {
  /** Prompt sent to the first token of any kind (thinking/reasoning included). */
  firstTokenMs: number | null;
  /** #143: prompt sent to the first content (or tool-call) token. */
  firstAnswerMs: number | null;
  totalMs: number | null;
  outputTokens: number | null;
  /** `tokens` (usage / Ollama eval_count) or `chunks` (non-empty stream deltas, when no token count was reported). */
  outputUnit: 'tokens' | 'chunks';
  /** outputTokens per second of generation (first token of any kind to done; thinking tokens count as output). */
  tokensPerSecond: number | null;
}

/** One side of the comparison from its instants and its output count. */
export function phaseSide(instants: LoopInstants, outputTokens: number | null, outputUnit: 'tokens' | 'chunks'): PhaseSide {
  const { promptSentMs: sent, firstTokenMs: first, firstAnswerMs: answer, responseDoneMs: done } = instants;
  const genMs = first !== undefined && done !== undefined ? done - first : null;
  return {
    firstTokenMs: sent !== undefined && first !== undefined ? first - sent : null,
    firstAnswerMs: sent !== undefined && answer !== undefined ? answer - sent : null,
    totalMs: sent !== undefined && done !== undefined ? done - sent : null,
    outputTokens,
    outputUnit,
    tokensPerSecond: outputTokens !== null && genMs !== null && genMs > 0 ? round2(outputTokens / (genMs / 1000)) : null
  };
}

/** All markers of the capture in time order (stable: GPU cues before loop cues at the same instant). */
export function orderMarkers(markers: ReadonlyArray<Record<string, unknown>>): Array<Record<string, unknown>> {
  return markers
    .map((marker, i) => ({ marker, i }))
    .sort((a, b) => Number(a.marker.instantMs) - Number(b.marker.instantMs) || a.i - b.i)
    .map(({ marker }) => marker);
}

interface CueReceipt {
  label: string;
  source: string;
  edge?: string;
  gpuIndex?: number;
  instantMs: number;
  offsetFromPromptMs: number | null;
  imageGrab: { toleranceMs: number | null; nearestFrameIndex: number | null; deltaMs: number | null; admitted: boolean };
  utilizationLag?: unknown;
}

const finiteOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** Per-cue receipt rows: instant, offset from "prompt sent", the frame grab (deltaMs, admitted, toleranceMs). */
export function cueReceipts(markers: ReadonlyArray<Record<string, unknown>>, promptSentInstantMs: number | null): CueReceipt[] {
  return markers.map((marker) => {
    const grab = (isObject(marker.imageGrab) ? marker.imageGrab : {}) as Record<string, unknown>;
    const source = (isObject(marker.source) ? marker.source : {}) as Record<string, unknown>;
    const instantMs = Number(marker.instantMs);
    return {
      label: String(marker.label),
      source: typeof source.kind === 'string' ? source.kind : String(marker.kind),
      ...(typeof source.edge === 'string' ? { edge: source.edge, gpuIndex: Number(source.gpuIndex) } : {}),
      instantMs,
      offsetFromPromptMs: promptSentInstantMs === null ? null : instantMs - promptSentInstantMs,
      imageGrab: {
        toleranceMs: finiteOrNull(grab.toleranceMs),
        nearestFrameIndex: finiteOrNull(grab.nearestFrameIndex),
        deltaMs: finiteOrNull(grab.deltaMs),
        admitted: grab.admitted === true
      },
      ...(source.utilizationLag !== undefined ? { utilizationLag: source.utilizationLag } : {})
    };
  });
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** At most RESPONSE_EXCERPT_CHARS characters of the model's answer (whole code points). */
export function responseExcerpt(text: string): string {
  return [...text].slice(0, RESPONSE_EXCERPT_CHARS).join('');
}

export interface Recorder {
  /** Ask the recorder to finish (ffmpeg: `q` on stdin), wait for it, kill it after `graceMs`. */
  stop(graceMs?: number): Promise<void>;
  /** The last stderr line, when the recorder failed. */
  lastError(): string;
}
export interface StoppableProcess {
  stop(): void;
}

export interface LoopDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Repository / extension root holding media/ (launch-capture.mjs, markerImageGrab.mjs, captureStatus.mjs). */
  root: string;
  resolveFfmpeg(configured?: string): string | null;
  x11VideoSize(display: string): Promise<string>;
  startRecorder(ffmpeg: string, args: string[]): Recorder;
  startResourceSampler(platform: NodeJS.Platform, file: string): StoppableProcess;
  gpuRunner(nvidiaSmi: string): NvidiaSmiRunner;
  bridge(config: BridgeConfig, hooks: BridgeHooks): Promise<BridgeRun>;
  clipRun: ClipRunner;
}

const dynamicImport = new Function('u', 'return import(u)') as (u: string) => Promise<Record<string, unknown>>;

function spawnRecorder(ffmpeg: string, args: string[]): Recorder {
  const child: ChildProcess = spawn(ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  let exited = false;
  child.stderr?.on('data', (data: Buffer) => {
    stderr = (stderr + data.toString()).slice(-4000);
  });
  child.on('error', (error) => {
    stderr += `\n${error.message}`;
  });
  const closed = new Promise<void>((resolve) => {
    child.on('close', () => {
      exited = true;
      resolve();
    });
    child.on('error', () => {
      exited = true;
      resolve();
    });
  });
  child.stdin?.on('error', () => undefined);
  return {
    async stop(graceMs = 4000): Promise<void> {
      if (!exited) child.stdin?.write('q\n');
      const timer = setTimeout(() => child.kill(), graceMs);
      await closed;
      clearTimeout(timer);
    },
    lastError: () => stderr.trim().split(/\r?\n/).pop() ?? ''
  };
}

export const defaultLoopDeps: LoopDeps = {
  platform: process.platform,
  env: process.env,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  root: path.join(__dirname, '..', '..'),
  resolveFfmpeg: (configured) => resolveFfmpegCommand(configured ?? String(process.env.LBA_FFMPEG_PATH ?? '')),
  x11VideoSize: (display) =>
    new Promise((resolve, reject) => {
      execFile('xdpyinfo', ['-display', display], { timeout: 5000, windowsHide: true }, (error, stdout) => {
        if (error) reject(error);
        else {
          try {
            resolve(parseX11DisplaySize(String(stdout)));
          } catch (parseError) {
            reject(parseError);
          }
        }
      });
    }),
  startRecorder: spawnRecorder,
  startResourceSampler: (platform, file) => {
    const command = resourceSamplerCommand(platform, file);
    const child = spawn(command.command, command.args, command.windowsHide ? { windowsHide: true, stdio: 'ignore' } : { stdio: 'ignore' });
    child.on('error', () => undefined);
    return { stop: () => void child.kill() };
  },
  gpuRunner: (nvidiaSmi) => nvidiaSmiRunner(nvidiaSmi),
  bridge: runBridge,
  clipRun: execFileRunner
};

interface StatusBuilders {
  buildCapturingStatus(opts: unknown): unknown;
  buildCaptureStatus(record: unknown, samples: unknown, opts: unknown): unknown;
  buildFailedStatus(opts: unknown): unknown;
}

async function loadMedia<T>(root: string, file: string): Promise<T> {
  return (await dynamicImport(pathToFileURL(path.join(root, 'media', file)).href)) as unknown as T;
}

/** A reference failure as a LoopError; the message is fixed text, redacted once more for safety. */
function referenceLoopError(error: unknown, reference: ReferenceConfig): LoopError {
  if (!(error instanceof ReferenceError)) return new LoopError(redact(`reference failed: ${(error as Error)?.message ?? 'error'}`, reference.token()), LOOP_EXIT.reference);
  const code = { usage: LOOP_EXIT.usage, prerequisite: LOOP_EXIT.prerequisite, run: LOOP_EXIT.reference, timeout: LOOP_EXIT.referenceTimeout }[error.kind];
  return new LoopError(redact(error.message, reference.token()), code);
}

/**
 * #143: one stderr line when the reference id is an Open WebUI alias (the server adds the alias's tools and
 * default features to the prompt). Names only the two model ids, never the entry's tools or features.
 */
export function referenceAliasWarning(info: Pick<ReferenceModelInfo, 'id' | 'alias' | 'baseModelId'> | undefined): string | null {
  if (!info?.alias) return null;
  const base = info.baseModelId ?? '<base model id>';
  return `warning: reference model ${info.id} is an Open WebUI alias of ${base}; use --reference-model ${base} for a like-for-like comparison`;
}

/** Run the loop; returns the receipt (also written next to the clip). Throws LoopError with the exit code. */
export async function runLocalModelLoop(config: LoopConfig, deps: LoopDeps = defaultLoopDeps, log: (line: string) => void = () => undefined): Promise<Record<string, unknown>> {
  // 1. Prerequisites first: nothing is created when ffmpeg, the display, Ollama or the model is missing.
  const ffmpeg = deps.resolveFfmpeg(config.ffmpeg);
  if (!ffmpeg) throw new LoopError(MISSING_FFMPEG_MESSAGE, LOOP_EXIT.prerequisite);
  let x11VideoSize: string | undefined;
  if (config.source === 'desktop' && deps.platform === 'linux') {
    try {
      x11VideoSize = await deps.x11VideoSize(x11DisplayForCapture(deps.env));
    } catch (error) {
      throw new LoopError(`desktop capture unavailable: ${(error as Error).message}; use --source test`, LOOP_EXIT.prerequisite);
    }
  }
  const model = await ollamaPreflight(config.endpoint, config.model);
  const imageBytes = config.image ? readFileSync(config.image) : undefined;
  let referenceInfo: ReferenceModelInfo | undefined;
  if (config.reference) {
    try {
      referenceInfo = await referencePreflight(config.reference);
    } catch (error) {
      throw referenceLoopError(error, config.reference);
    }
    const warning = referenceAliasWarning(referenceInfo);
    if (warning) log(warning);
  }
  if (config.cold) {
    // keep_alive 0 unloads the model, so the capture sees the model load (the memory-rise GPU cue).
    try {
      await api(config.endpoint, '/api/generate', { model: config.model, keep_alive: 0 });
    } catch {
      throw new LoopError(`Ollama at ${config.endpoint.origin} could not unload ${config.model} for --cold`, LOOP_EXIT.prerequisite);
    }
  }

  // 2. The capture directory, in the extension's format.
  const runId = newCaptureRunId();
  const dir = path.join(config.capturesDir, `run-${runId}`);
  const framePattern = path.join(dir, 'frame-%05d.png');
  const plan = planCaptureSource(config, deps.platform, framePattern, deps.env, x11VideoSize);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'capture-meta.json'), `${JSON.stringify(plan.meta, null, 2)}\n`);
  const startedAt = new Date(deps.now()).toISOString();
  const status = await loadMedia<StatusBuilders>(deps.root, 'captureStatus.mjs');
  const setState = (state: ActiveCaptureState, stoppedAt?: string): void =>
    writeActiveCaptureSession(dir, buildActiveCaptureSession({ runId, workload: 'desktop-capture', state, plane: plan.meta.plane, source: plan.meta.source, startedAt, stoppedAt }));
  const writeStatus = (value: unknown): void => writeFileSync(path.join(dir, 'capture-status.json'), `${JSON.stringify(value, null, 2)}\n`);
  writeStatus(status.buildCapturingStatus({ runDir: dir, startedAt }));
  setState('capturing');
  log(`capture started: ${dir} (${plan.meta.source} at ${config.fps} fps + CPU/RAM/disk + GPU)`);

  const recorder = deps.startRecorder(ffmpeg, plan.args);
  const sampler = deps.startResourceSampler(deps.platform, path.join(dir, 'resources.jsonl'));
  const gpuSampler = startGpuSampler({ dir, run: deps.gpuRunner(config.nvidiaSmi) });

  // 3. Lead, [reference phase (#139), settle,] prompt through the bridge, tail.
  const instants: LoopInstants = {};
  const referenceInstants: LoopInstants = {};
  let referenceResult: ReferenceResult | undefined;
  let referenceFailure: LoopError | undefined;
  const localStats: ChatStreamStats[] = [];
  let bridgeRun: BridgeRun | undefined;
  let gpuHeader: GpuSeriesHeader;
  try {
    await deps.sleep(config.leadMs);
    if (config.reference) {
      log(`reference: ${config.reference.kind} model ${config.reference.model} (the local GPU should stay idle)`);
      try {
        referenceResult = await runReferenceChat(
          config.reference,
          { prompt: config.prompt, ...(imageBytes ? { image: imageBytes } : {}), temperature: 0, seed: config.seed, maxTokens: config.maxTokens },
          {
            onSent: () => { referenceInstants.promptSentMs = deps.now(); },
            onFirstToken: () => { referenceInstants.firstTokenMs = referenceInstants.firstTokenMs ?? deps.now(); },
            onFirstAnswer: () => { referenceInstants.firstAnswerMs = referenceInstants.firstAnswerMs ?? deps.now(); },
            onDone: () => { referenceInstants.responseDoneMs = deps.now(); }
          }
        );
      } catch (error) {
        referenceFailure = referenceLoopError(error, config.reference);
      }
      if (!referenceFailure) await deps.sleep(config.leadMs);
    }
    if (!referenceFailure) {
      const offerTools = !config.noTools && (model.capabilities === null || model.capabilities.includes('tools'));
      bridgeRun = await deps.bridge(
        {
          model: config.model, endpoint: config.endpoint, prompt: config.prompt, maxTurns: config.maxTurns, stream: true, offerTools,
          ...(config.noTools ? { omitTools: true } : {}),
          allow: new Set([...OLLAMA_DEFAULT_TOOLS, ...config.allowTools]),
          ...(imageBytes ? { images: [imageBytes.toString('base64')] } : {}),
          ...(config.fixedDecoding ? { options: { temperature: 0, seed: config.seed, num_predict: config.maxTokens } } : {})
        },
        {
          serverEnv: { ...deps.env, LBA_CAPTURE_ROOT: config.capturesDir, LBA_FFMPEG_PATH: ffmpeg },
          onChatRequest: (turn) => {
            if (turn === 0) instants.promptSentMs = deps.now();
          },
          onFirstToken: () => {
            instants.firstTokenMs = instants.firstTokenMs ?? deps.now();
          },
          onFirstAnswer: () => {
            instants.firstAnswerMs = instants.firstAnswerMs ?? deps.now();
          },
          onDone: () => {
            instants.responseDoneMs = deps.now();
          },
          onStats: (_turn, stats) => {
            localStats.push(stats);
          }
        }
      );
      if (!bridgeRun.failure) await deps.sleep(config.tailMs);
    }
  } finally {
    // 4. Stop everything, whatever happened above.
    sampler.stop();
    gpuHeader = await gpuSampler.stop();
    await recorder.stop();
  }

  const stoppedAt = new Date(deps.now()).toISOString();
  let record: LaunchCaptureRecord;
  try {
    const builder = await loadMedia<CaptureBuilder>(deps.root, 'launch-capture.mjs');
    const grab = await loadMarkerImageGrab(deps.root);
    record = assembleCaptureFromDir(dir, builder, { grab, gpuCue: { utilThresholdPct: config.gpuThresholdPct, memoryRiseMb: config.gpuMemoryRiseMb } });
    const existing = Array.isArray(record.markers) ? record.markers as Array<Record<string, unknown>> : [];
    const refMarkers = config.reference ? referenceCueMarkers(record, referenceInstants, grab, stoppedAt) : [];
    const loopMarkers = loopCueMarkers({ ...record, markers: [...existing, ...refMarkers] }, instants, grab, stoppedAt);
    record.markers = orderMarkers([...existing, ...refMarkers, ...loopMarkers]);
    writeCaptureRecord(path.join(dir, 'capture.json'), record);
  } catch (error) {
    const detail = recorder.lastError();
    const message = `the capture yielded no usable frames (${(error as Error).message})${detail ? `; ffmpeg: ${detail}` : ''}`;
    setState('failed', stoppedAt);
    writeStatus(status.buildFailedStatus({ runDir: dir, startedAt, stoppedAt, error: message }));
    // A reference failure is the root cause: its exit code wins over the (short) capture's.
    if (referenceFailure) throw new LoopError(`${referenceFailure.message}; ${message}`, referenceFailure.exitCode);
    throw new LoopError(message, LOOP_EXIT.capture);
  }
  writeStatus(status.buildCaptureStatus(record, readResourceSamples(dir), { runDir: dir, startedAt, stoppedAt }));
  setState('stopped', stoppedAt);

  // 5. Receipt (and the clip when the model answered).
  const startMs = Number(record.startMs);
  const markers = record.markers as Array<Record<string, unknown>>;
  const promptInstant = instants.promptSentMs === undefined ? null : instants.promptSentMs - startMs;
  const gpuEdges = cueReceipts(markers.filter((m) => isObject(m.source) && m.source.kind === 'gpu-edge'), promptInstant);
  const answer = bridgeRun?.finalText ?? '';
  const receipt: Record<string, unknown> = {
    schema: LOOP_RECEIPT_SCHEMA,
    captureId: runId,
    captureDir: dir,
    platform: deps.platform,
    source: plan.meta.source,
    fps: config.fps,
    frameCount: record.frameCount,
    startedAt,
    stoppedAt,
    model: {
      name: model.name,
      digest: model.digest,
      sizeBytes: model.sizeBytes,
      capabilities: model.capabilities,
      ollamaVersion: bridgeRun?.receipt.ollamaVersion || model.ollamaVersion,
      cold: config.cold,
      toolsOffered: bridgeRun?.toolsOffered ?? [],
      toolCalls: bridgeRun?.receipt.toolCalls ?? []
    },
    prompt: {
      sha256: sha256(config.prompt),
      chars: config.prompt.length,
      image: imageBytes ? { sha256: sha256(imageBytes), bytes: imageBytes.length } : null
    },
    response: { sha256: sha256(answer), chars: answer.length, excerpt: responseExcerpt(answer) },
    timing: {
      promptSentInstantMs: promptInstant,
      firstTokenLatencyMs: instants.firstTokenMs !== undefined && instants.promptSentMs !== undefined ? instants.firstTokenMs - instants.promptSentMs : null,
      firstAnswerLatencyMs: instants.firstAnswerMs !== undefined && instants.promptSentMs !== undefined ? instants.firstAnswerMs - instants.promptSentMs : null,
      responseMs: instants.responseDoneMs !== undefined && instants.promptSentMs !== undefined ? instants.responseDoneMs - instants.promptSentMs : null,
      leadMs: config.leadMs,
      tailMs: config.tailMs
    },
    cues: cueReceipts(markers, promptInstant),
    gpu: {
      available: gpuHeader.available,
      ...(gpuHeader.reason ? { reason: gpuHeader.reason } : {}),
      gpus: gpuHeader.gpus,
      sampleCount: gpuHeader.sampleCount ?? 0,
      failedSamples: gpuHeader.failedSamples ?? 0,
      thresholdPct: config.gpuThresholdPct,
      memoryRiseMb: config.gpuMemoryRiseMb,
      edges: gpuEdges
    },
    clip: null
  };
  if (config.fixedDecoding) receipt.decoding = { temperature: 0, seed: config.seed, maxTokens: config.maxTokens };
  if (config.reference) {
    const reference = config.reference;
    const token = reference.token();
    const samples = readGpuSeries(dir)?.samples ?? [];
    const refText = referenceResult?.text ?? '';
    const refSent = referenceInstants.promptSentMs;
    const refDone = referenceInstants.responseDoneMs;
    const control = refSent !== undefined && refDone !== undefined
      ? gpuWindowStats(samples, refSent, refDone, config.gpuThresholdPct, config.gpuMemoryRiseMb) : null;
    const localWindow = instants.promptSentMs !== undefined && instants.responseDoneMs !== undefined
      ? gpuWindowStats(samples, instants.promptSentMs, instants.responseDoneMs, config.gpuThresholdPct, config.gpuMemoryRiseMb) : null;
    const refTokens = referenceResult?.usage.completionTokens ?? null;
    const evalCounts = localStats.map((s) => s.evalCount);
    const localTokens = localStats.length > 0 && evalCounts.every((c) => c !== null) ? (evalCounts as number[]).reduce((a, b) => a + b, 0) : null;
    const localChunks = localStats.reduce((a, s) => a + s.streamChunks, 0);
    // The final turn's prompt_eval_count: its prompt holds the whole conversation (with --no-tools there is one turn).
    const localPromptTokens = localStats.length > 0 ? localStats[localStats.length - 1].promptEvalCount : null;
    const traits = {
      alias: referenceInfo?.alias ?? null,
      baseModelId: referenceInfo?.baseModelId ?? null,
      hasTools: referenceInfo?.hasTools ?? null,
      hasDefaultFeatures: referenceInfo?.hasDefaultFeatures ?? null
    };
    const refInstant = refSent === undefined ? null : refSent - startMs;
    const refDoneInstant = refDone === undefined ? null : refDone - startMs;
    receipt.reference = {
      kind: reference.kind,
      endpointScheme: reference.endpoint.protocol.replace(':', ''),
      endpointSha256: sha256(reference.endpoint.href),
      model: referenceInfo?.id ?? reference.model,
      modelsListed: referenceInfo?.listed ?? null,
      ...traits,
      response: { sha256: sha256(refText), chars: refText.length, excerpt: responseExcerpt(redact(refText, token)), reasoningChars: referenceResult?.reasoningChars ?? 0 },
      finishReason: referenceResult?.finishReason ?? null,
      sawDone: referenceResult?.sawDone ?? false,
      usage: referenceResult?.usage ?? null,
      chunks: referenceResult?.chunks ?? 0,
      sentInstantMs: refInstant,
      doneInstantMs: refDoneInstant
    };
    receipt.comparison = {
      schema: LOOP_COMPARISON_SCHEMA,
      models: { reference: reference.model, local: config.model },
      referenceModel: traits,
      decoding: { temperature: 0, seed: config.seed, maxTokens: config.maxTokens },
      reference: {
        ...phaseSide(referenceInstants, refTokens ?? (referenceResult ? referenceResult.chunks : null), refTokens !== null ? 'tokens' : 'chunks'),
        promptTokens: referenceResult?.usage.promptTokens ?? null,
        reasoningChars: referenceResult?.reasoningChars ?? 0,
        gpuControl: control
      },
      local: {
        ...phaseSide(instants, localTokens ?? (localStats.length > 0 ? localChunks : null), localTokens !== null ? 'tokens' : 'chunks'),
        promptTokens: localPromptTokens,
        thinkingChars: localStats.reduce((a, s) => a + s.thinkingChars, 0),
        toolsOffered: bridgeRun?.toolsOffered ?? [],
        vramPeakMb: localWindow?.memoryUsedMb.max ?? null,
        maxUtilizationPct: localWindow?.maxUtilizationPct ?? null,
        toolCalls: bridgeRun?.receipt.toolCalls.length ?? 0
      },
      gpuEdges: gpuEdges.map((e) => ({
        label: e.label,
        edge: e.edge ?? null,
        offsetFromPromptMs: e.offsetFromPromptMs,
        duringReference: refInstant !== null && refDoneInstant !== null && e.instantMs >= refInstant && e.instantMs <= refDoneInstant
      }))
    };
  }
  const writeReceipt = (file: string): Record<string, unknown> => {
    receipt.receiptFile = file;
    writeFileSync(path.join(dir, file), `${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
  };
  if (referenceFailure) {
    receipt.error = referenceFailure.message;
    writeReceipt('loop-receipt.json');
    throw Object.assign(referenceFailure, { receipt });
  }
  if (bridgeRun?.failure || instants.promptSentMs === undefined || instants.responseDoneMs === undefined) {
    const failure = bridgeRun?.failure ?? { stage: 'Ollama chat', message: 'no complete response.' };
    receipt.error = `${failure.stage} failed: ${failure.message}`;
    writeReceipt('loop-receipt.json');
    throw Object.assign(new LoopError(String(receipt.error), LOOP_EXIT.model), { receipt });
  }
  const window = planLoopClip(
    record.frames, promptInstant as number, instants.responseDoneMs - startMs, gpuEdges.map((e) => e.instantMs), LOOP_DEFAULTS.clipPadMs,
    referenceInstants.promptSentMs === undefined ? undefined : referenceInstants.promptSentMs - startMs
  );
  let clipReceipt: Record<string, unknown>;
  try {
    clipReceipt = await exportCaptureClip(dir, { fromFrame: window.fromFrame, toFrame: window.toFrame }, { ffmpeg, run: deps.clipRun });
  } catch (error) {
    receipt.error = `clip failed: ${(error as Error).message}`;
    writeReceipt('loop-receipt.json');
    throw Object.assign(new LoopError(String(receipt.error), LOOP_EXIT.clip), { receipt });
  }
  const clip = clipReceipt.clip as Record<string, unknown>;
  receipt.clip = {
    file: clip.file,
    sha256: clip.sha256,
    sizeBytes: clip.sizeBytes,
    durationMs: clip.durationMs,
    frameRange: clipReceipt.frameRange,
    window,
    receiptFile: `clips/clip-${window.fromFrame}-${window.toFrame}.json`
  };
  return writeReceipt(`clips/loop-${window.fromFrame}-${window.toFrame}.json`);
}

/** CLI entry: ONE JSON receipt on stdout, progress and errors on stderr; returns the exit code. */
export async function runLocalModelLoopCli(
  argv: readonly string[],
  io: { out(text: string): void; err(text: string): void },
  deps: LoopDeps = defaultLoopDeps
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.out(LOOP_USAGE);
    return 0;
  }
  try {
    const config = parseLoopArgs(argv, deps.env, deps.platform);
    io.out(JSON.stringify(await runLocalModelLoop(config, deps, (line) => io.err(line)), null, 2));
    return 0;
  } catch (error) {
    const receipt = (error as { receipt?: unknown }).receipt;
    if (receipt) io.out(JSON.stringify(receipt, null, 2));
    if (error instanceof LoopError) {
      io.err(`local-model-loop: ${error.message}`);
      if (error.exitCode === LOOP_EXIT.usage) io.err(LOOP_USAGE);
      return error.exitCode;
    }
    io.err(`local-model-loop: ${(error as Error).message}`);
    return 1;
  }
}

if (require.main === module) {
  void runLocalModelLoopCli(process.argv.slice(2), { out: (t) => console.log(t), err: (t) => console.error(t) }).then((code) => {
    process.exitCode = code;
  });
}
