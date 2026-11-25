/**
 * Reference mode for the local-model loop (#139 slice 2): the same prompt, streamed through an Open WebUI
 * (OpenAI-compatible) chat-completions API, so the local GPU run has a reference on the same capture time axis.
 *
 * The API token is read ONCE from a key file and lives only in a closure; it is sent only as the
 * `Authorization: Bearer` header. No message produced here quotes the token, a response body, a response header or
 * the endpoint host: errors carry fixed text and at most an HTTP status code.
 */
import { readFileSync, statSync } from 'node:fs';

export const REFERENCE_KINDS = ['openwebui'] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];
export const DEFAULT_REFERENCE_TIMEOUT_MS = 300_000;
export const REDACTED = '[redacted]';

/** Failure classes: `usage` (bad flags / token file), `prerequisite` (preflight), `run` (the streamed chat), `timeout`. */
export type ReferenceErrorKind = 'usage' | 'prerequisite' | 'run' | 'timeout';
export class ReferenceError extends Error {
  constructor(message: string, readonly kind: ReferenceErrorKind) {
    super(message);
  }
}

export interface ReferenceConfig {
  kind: ReferenceKind;
  endpoint: URL;
  model: string;
  timeoutMs: number;
  /** The bearer token; a function so the value never serializes with the config. */
  token(): string;
}

export interface TokenFileOps {
  stat(file: string): { isFile(): boolean; mode: number };
  read(file: string): string;
}
export const nodeTokenFileOps: TokenFileOps = { stat: (file) => statSync(file), read: (file) => readFileSync(file, 'utf8') };

/**
 * Read the token file once. Missing, empty, not a regular file, or (POSIX) accessible by group/others: a usage
 * error whose message never shows the content. The token must be visible ASCII (a header value).
 */
export function readTokenFile(file: string, platform: NodeJS.Platform, ops: TokenFileOps = nodeTokenFileOps): () => string {
  let info: { isFile(): boolean; mode: number };
  try {
    info = ops.stat(file);
  } catch (error) {
    throw new ReferenceError(`--token-file could not be read (${(error as NodeJS.ErrnoException).code ?? 'error'})`, 'usage');
  }
  if (!info.isFile()) throw new ReferenceError('--token-file must name a regular file', 'usage');
  if (platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw new ReferenceError('--token-file must be readable by its owner only (chmod 600 <file>)', 'usage');
  }
  let raw: string;
  try {
    raw = ops.read(file);
  } catch (error) {
    throw new ReferenceError(`--token-file could not be read (${(error as NodeJS.ErrnoException).code ?? 'error'})`, 'usage');
  }
  const token = raw.trim();
  if (!token) throw new ReferenceError('--token-file is empty', 'usage');
  if (!/^[\x21-\x7e]+$/.test(token)) throw new ReferenceError('--token-file must hold one token of visible ASCII characters', 'usage');
  return () => token;
}

/** https only; plain http only for a loopback test server (127.0.0.1 or localhost). No credentials, query or fragment. */
export function parseReferenceEndpoint(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ReferenceError('--endpoint must be an https URL', 'usage');
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new ReferenceError('--endpoint must be an https URL (plain http only for 127.0.0.1 or localhost)', 'usage');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ReferenceError('--endpoint must not carry credentials, a query or a fragment', 'usage');
  }
  return url;
}

/** `<endpoint>/<path>`, keeping a base path the server may be mounted under. */
export function referenceUrl(endpoint: URL, apiPath: string): URL {
  return new URL(`${endpoint.href.replace(/\/+$/, '')}/${apiPath.replace(/^\/+/, '')}`);
}

/** Replace every occurrence of the token (belt and braces for text that came from the server). */
export function redact(text: string, token: string): string {
  return token ? text.split(token).join(REDACTED) : text;
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function headers(config: ReferenceConfig, json: boolean): Record<string, string> {
  return { Authorization: `Bearer ${config.token()}`, Accept: json ? 'application/json' : 'text/event-stream', ...(json ? {} : { 'Content-Type': 'application/json' }) };
}

function transportError(error: unknown, what: string, kind: ReferenceErrorKind, timeoutMs: number): ReferenceError {
  const name = (error as Error | undefined)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return new ReferenceError(`${what} timed out after ${timeoutMs} ms`, 'timeout');
  // The fetch error (and its cause) may quote request details: a fixed message only.
  return new ReferenceError(`${what} failed: the reference endpoint is not reachable`, kind);
}

function statusHint(status: number): string {
  return status === 401 || status === 403 ? ' (check the token file)' : '';
}

export interface ReferenceModelInfo {
  id: string;
  /** Number of models the endpoint lists. */
  listed: number;
}

/** GET <endpoint>/api/models: the token is accepted and the model id is served. Failures are prerequisite errors. */
export async function referencePreflight(config: ReferenceConfig): Promise<ReferenceModelInfo> {
  let response: Response;
  try {
    response = await fetch(referenceUrl(config.endpoint, 'api/models'), { redirect: 'manual', signal: AbortSignal.timeout(config.timeoutMs), headers: headers(config, true) });
  } catch (error) {
    throw transportError(error, 'reference preflight (/api/models)', 'prerequisite', config.timeoutMs);
  }
  let body: unknown;
  try {
    const text = await response.text();
    if (response.status < 200 || response.status > 299) {
      throw new ReferenceError(`reference preflight (/api/models) answered HTTP ${response.status}${statusHint(response.status)}`, 'prerequisite');
    }
    body = JSON.parse(text);
  } catch (error) {
    if (error instanceof ReferenceError) throw error;
    if ((error as Error)?.name === 'TimeoutError') throw transportError(error, 'reference preflight (/api/models)', 'prerequisite', config.timeoutMs);
    throw new ReferenceError('reference preflight (/api/models) did not answer like Open WebUI', 'prerequisite');
  }
  const list = isObject(body) && Array.isArray(body.data) ? body.data.filter(isObject) : null;
  if (!list) throw new ReferenceError('reference preflight (/api/models) did not answer like Open WebUI', 'prerequisite');
  if (!list.some((m) => m.id === config.model)) {
    throw new ReferenceError(`reference model ${config.model} is not served by the reference endpoint (${list.length} models listed)`, 'prerequisite');
  }
  return { id: config.model, listed: list.length };
}

export interface ReferenceRequest {
  prompt: string;
  /** PNG bytes sent as an image_url data URL next to the prompt (vision models). */
  image?: Buffer;
  temperature: number;
  seed: number;
  maxTokens: number;
}

export interface ReferenceTiming {
  onSent?(): void;
  onFirstToken?(): void;
  onDone?(): void;
}

export interface ReferenceResult {
  /** The answer (content deltas); the caller keeps only its sha256 and a redacted excerpt. */
  text: string;
  /** reasoning_content / reasoning characters, when a thinking model streams them separately. */
  reasoningChars: number;
  /** Non-empty content or reasoning deltas. */
  chunks: number;
  usage: { completionTokens: number | null; promptTokens: number | null };
  finishReason: string | null;
  sawDone: boolean;
}

/** The OpenAI-compatible request body; the token is NOT part of it. */
export function referenceChatBody(model: string, request: ReferenceRequest): Record<string, unknown> {
  const content = request.image
    ? [{ type: 'text', text: request.prompt }, { type: 'image_url', image_url: { url: `data:image/png;base64,${request.image.toString('base64')}` } }]
    : request.prompt;
  return {
    model,
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: 'user', content }],
    temperature: request.temperature,
    seed: request.seed,
    max_tokens: request.maxTokens
  };
}

const count = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

/** POST <endpoint>/api/chat/completions with `stream: true` and fold the SSE `data:` lines up to `[DONE]`. */
export async function runReferenceChat(config: ReferenceConfig, request: ReferenceRequest, timing: ReferenceTiming = {}): Promise<ReferenceResult> {
  const what = 'reference chat (/api/chat/completions)';
  const signal = AbortSignal.timeout(config.timeoutMs);
  let response: Response;
  timing.onSent?.();
  try {
    response = await fetch(referenceUrl(config.endpoint, 'api/chat/completions'), {
      method: 'POST', redirect: 'manual', signal, headers: headers(config, false), body: JSON.stringify(referenceChatBody(config.model, request))
    });
  } catch (error) {
    throw transportError(error, what, 'run', config.timeoutMs);
  }
  if (response.status < 200 || response.status > 299) {
    await response.body?.cancel().catch(() => undefined);
    throw new ReferenceError(`${what} answered HTTP ${response.status}${statusHint(response.status)}`, 'run');
  }
  const result: ReferenceResult = { text: '', reasoningChars: 0, chunks: 0, usage: { completionTokens: null, promptTokens: null }, finishReason: null, sawDone: false };
  let first = true;
  const take = (rawLine: string): void => {
    const line = rawLine.replace(/\r$/, '');
    if (result.sawDone || !line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data) return;
    if (data === '[DONE]') {
      result.sawDone = true;
      return;
    }
    let chunk: unknown;
    try {
      chunk = JSON.parse(data);
    } catch {
      throw new ReferenceError(`${what}: invalid JSON in the stream`, 'run');
    }
    if (!isObject(chunk)) throw new ReferenceError(`${what}: invalid chunk in the stream`, 'run');
    if (chunk.error !== undefined && chunk.error !== null) throw new ReferenceError(`${what}: the stream reported an error`, 'run');
    if (isObject(chunk.usage)) {
      const tokens = count(chunk.usage.completion_tokens) ?? count(chunk.usage.eval_count);
      if (tokens !== null) result.usage.completionTokens = tokens;
      const prompt = count(chunk.usage.prompt_tokens) ?? count(chunk.usage.prompt_eval_count);
      if (prompt !== null) result.usage.promptTokens = prompt;
    }
    const choice = Array.isArray(chunk.choices) && isObject(chunk.choices[0]) ? chunk.choices[0] : null;
    if (!choice) return;
    const delta = isObject(choice.delta) ? choice.delta : {};
    const text = typeof delta.content === 'string' ? delta.content : '';
    const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : typeof delta.reasoning === 'string' ? delta.reasoning : '';
    result.text += text;
    result.reasoningChars += reasoning.length;
    if (text.length > 0 || reasoning.length > 0) {
      result.chunks += 1;
      if (first) {
        first = false;
        timing.onFirstToken?.();
      }
    }
    if (typeof choice.finish_reason === 'string') result.finishReason = choice.finish_reason;
  };
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() as string;
      lines.forEach(take);
      if (result.sawDone) break;
    }
    if (!result.sawDone) take(buffer + decoder.decode());
  } catch (error) {
    if (error instanceof ReferenceError) throw error;
    throw transportError(error, what, 'run', config.timeoutMs);
  } finally {
    if (result.sawDone) await response.body?.cancel().catch(() => undefined);
  }
  if (!result.sawDone && result.finishReason === null) throw new ReferenceError(`${what}: the stream ended before [DONE]`, 'run');
  timing.onDone?.();
  return result;
}
