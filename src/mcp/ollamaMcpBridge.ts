import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import {
  BENCHMARK_ACTOR_MCP_PROTOCOL_VERSION, BenchmarkActorMcpTool, JsonRpcResponse, McpToolResult,
  OLLAMA_DEFAULT_TOOLS
} from './benchmarkActorMcpServer';

const usage = 'node out/mcp/ollamaMcpBridge.js --model <name> [--prompt <text> | --self-test] [--json] ' +
  '[--ollama <url>] [--allow-tool <name>]... [--max-turns <n>]';
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export interface BridgeConfig {
  model: string;
  selfTest?: boolean;
  json?: boolean;
  endpoint: URL;
  maxTurns: number;
  allow: Set<string>;
  prompt: string;
  /** #134 slice 4: stream /api/chat so the first-token and done instants can be recorded. */
  stream?: boolean;
  /** Base64 images attached to the user message (a vision model). */
  images?: string[];
  /** false withholds every tool (a model without the tools capability). */
  offerTools?: boolean;
  /** #139: Ollama decoding options sent with every /api/chat turn (e.g. temperature, seed, num_predict). */
  options?: Record<string, number>;
}

function options(): BridgeConfig {
  const { values } = parseArgs({ options: {
    model: { type: 'string' }, prompt: { type: 'string' }, 'self-test': { type: 'boolean' },
    json: { type: 'boolean' }, ollama: { type: 'string' }, 'max-turns': { type: 'string', default: '8' },
    'allow-tool': { type: 'string', multiple: true, default: [] }
  } });
  const maxTurns = Number(values['max-turns']);
  if (!values.model?.trim() || (values['self-test'] && values.prompt !== undefined) ||
      !Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new Error(usage);
  const host = values.ollama ?? process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
  const endpoint = new URL(host.includes('://') ? host : `http://${host}`);
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error(usage);
  return { model: values.model, selfTest: values['self-test'], json: values.json, endpoint, maxTurns,
    allow: new Set([...OLLAMA_DEFAULT_TOOLS, ...values['allow-tool']]),
    prompt: values['self-test'] ? 'Call get_host_capabilities, then summarize the result.' :
      values.prompt ?? 'What benchmark tools can you use?' };
}

// The bundled server sends one reply per request and no unsolicited messages. Keep only one RPC in flight.
function openServer(env?: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [join(__dirname, 'runBenchmarkActorMcpServer.js')], {
    shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], ...(env && { env })
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const closed = new AbortController();
  const stop = () => closed.abort();
  child.once('error', stop);
  child.stdin.on('error', stop);
  lines.once('close', stop);
  let sequence = 0;
  const write = (message: object) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');

  async function request(method: string, params: object = {}): Promise<JsonRpcResponse> {
    const id = ++sequence;
    const signal = AbortSignal.any([closed.signal, AbortSignal.timeout(45_000)]);
    const next = once(lines, 'line', { signal });
    write({ id, method, params });
    const [line] = await next;
    const response: JsonRpcResponse = JSON.parse(line);
    if (response.jsonrpc !== '2.0' || response.id !== id) throw new Error('Unexpected MCP response');
    return response;
  }

  async function list(): Promise<BenchmarkActorMcpTool[]> {
    const init = await request('initialize', { protocolVersion: BENCHMARK_ACTOR_MCP_PROTOCOL_VERSION,
      capabilities: {}, clientInfo: { name: 'ollama-mcp-bridge', version: '1' } });
    if ((init.result as { protocolVersion?: string })?.protocolVersion !== BENCHMARK_ACTOR_MCP_PROTOCOL_VERSION) {
      throw new Error('MCP initialization failed');
    }
    write({ method: 'notifications/initialized' });
    const { result } = await request('tools/list');
    const tools = (result as { tools?: BenchmarkActorMcpTool[] })?.tools;
    if (!Array.isArray(tools)) throw new Error('MCP tool listing failed');
    return tools;
  }
  return { list, request, close() { child.stdin.end(); child.kill(); } };
}

// The body was read in full and decoded, so Ollama was reached: a failure from here on is exit 1, not 2.
export class OllamaAnswered extends Error {}
// A transfer failure and a content-encoding failure look alike through fetch, so both are exit 2.
export class BodyUnread extends Error {}

type Json = Record<string, unknown>;
export const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export async function api(endpoint: URL, path: string, body?: object): Promise<unknown> {
  // Connection failures before any status propagate as plain errors (exit 2).
  const response = await fetch(new URL(path, endpoint), {
    redirect: 'manual', signal: AbortSignal.timeout(300_000),
    ...(body && { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  });
  let text: string;
  try {
    text = await response.text();
  } catch {
    // The error may quote body bytes, so it is dropped for a fixed diagnostic.
    throw new BodyUnread();
  }
  // The body is model or server text: never printed, only the status code.
  if (response.status < 200 || response.status > 299) throw new OllamaAnswered(`HTTP ${response.status}`);
  try { return JSON.parse(text) as unknown; } catch { throw new OllamaAnswered('invalid JSON'); }
}

interface ToolCall { function: { name: string; arguments: unknown } }
interface Message { role: 'assistant'; content: string; tool_calls?: ToolCall[] }

function chatMessage(body: unknown): Message {
  if (!isObject(body) || !isObject(body.message)) throw new OllamaAnswered('invalid message');
  const message = body.message;
  if (message.role !== 'assistant' || typeof message.content !== 'string') {
    throw new OllamaAnswered('invalid message');
  }
  if (message.tool_calls === undefined) return { role: 'assistant', content: message.content };
  if (!Array.isArray(message.tool_calls)) throw new OllamaAnswered('invalid message');
  for (const call of message.tool_calls as unknown[]) {
    if (!isObject(call) || !isObject(call.function) || typeof call.function.name !== 'string' ||
        !(isObject(call.function.arguments) || typeof call.function.arguments === 'string')) {
      throw new OllamaAnswered('invalid tool call');
    }
  }
  // Validated: replay it as Ollama sent it (thinking, call ids, function.index); only arguments are normalized.
  return message as unknown as Message;
}

/** What one streamed turn produced: non-empty content chunks and Ollama's own counts from the done chunk. */
export interface ChatStreamStats {
  contentChunks: number;
  evalCount: number | null;
  evalDurationNs: number | null;
}

export interface ChatTiming {
  onFirstToken?(turn: number): void;
  onDone?(turn: number): void;
  /** #139: called once per streamed turn, right after onDone. */
  onStats?(turn: number, stats: ChatStreamStats): void;
}

/** One streamed /api/chat turn: NDJSON chunks folded into one message; first content or tool call = first token. */
async function streamChat(endpoint: URL, body: object, turn: number, timing: ChatTiming): Promise<Message> {
  const response = await fetch(new URL('/api/chat', endpoint), {
    redirect: 'manual', signal: AbortSignal.timeout(300_000), method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (response.status < 200 || response.status > 299) {
    await response.body?.cancel().catch(() => undefined);
    throw new OllamaAnswered(`HTTP ${response.status}`);
  }
  let content = '';
  const toolCalls: unknown[] = [];
  let first = true;
  let done = false;
  let contentChunks = 0;
  const take = (line: string): void => {
    if (!line.trim() || done) return;
    let chunk: unknown;
    try { chunk = JSON.parse(line); } catch { throw new OllamaAnswered('invalid JSON'); }
    if (!isObject(chunk) || chunk.error !== undefined) throw new OllamaAnswered('stream error');
    const message = isObject(chunk.message) ? chunk.message : {};
    const text = typeof message.content === 'string' ? message.content : '';
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls as unknown[] : [];
    content += text;
    if (text.length > 0) contentChunks += 1;
    toolCalls.push(...calls);
    if (first && (text.length > 0 || calls.length > 0)) {
      first = false;
      timing.onFirstToken?.(turn);
    }
    if (chunk.done === true) {
      done = true;
      timing.onDone?.(turn);
      const count = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
      timing.onStats?.(turn, { contentChunks, evalCount: count(chunk.eval_count), evalDurationNs: count(chunk.eval_duration) });
    }
  };
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() as string;
      lines.forEach(take);
    }
  } catch (error) {
    if (error instanceof OllamaAnswered) throw error;
    throw new BodyUnread();
  }
  take(buffer + decoder.decode());
  if (!done) throw new OllamaAnswered('stream ended before done');
  return chatMessage({ message: { role: 'assistant', content, ...(toolCalls.length > 0 && { tool_calls: toolCalls }) } });
}

interface CallRecord { name: string; nameSha256?: string; argumentsSha256: string; ok: boolean }

function argumentsOf(raw: unknown): Json | undefined {
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { return undefined; }
  }
  return isObject(value) ? value : undefined;
}

export interface BridgeReceipt {
  ollamaVersion: string;
  model: string;
  toolsListed: string[];
  toolCalls: CallRecord[];
  finalTextSha256: string;
  exitCode: number;
}
export interface BridgeHooks extends ChatTiming {
  /** Environment of the bundled MCP server (default: this process's). */
  serverEnv?: NodeJS.ProcessEnv;
  /** Called right before each /api/chat request. */
  onChatRequest?(turn: number): void;
}
export interface BridgeRun {
  receipt: BridgeReceipt;
  finalText: string;
  toolsOffered: string[];
  /** Set when the run failed: the stage and the fixed, path-free diagnostic. */
  failure?: { stage: string; message: string };
}

/** The bridge loop (MCP discovery, allow-listed tools, Ollama chat turns); prints nothing. */
export async function runBridge(config: BridgeConfig, hooks: BridgeHooks = {}): Promise<BridgeRun> {
  const toolCalls: CallRecord[] = [];
  const receipt: BridgeReceipt = { ollamaVersion: '', model: config.model, toolsListed: [] as string[], toolCalls,
    finalTextSha256: sha256(''), exitCode: 2 };
  const server = openServer(hooks.serverEnv);
  let stage = 'MCP discovery';
  let finalText = '';
  let toolsOffered: string[] = [];
  let failure: BridgeRun['failure'];
  try {
    const listed = await server.list();
    receipt.toolsListed = listed.map(tool => tool.name);
    const tools = listed.filter(tool => config.offerTools !== false && config.allow.has(tool.name)).map(({ name, description, inputSchema }) =>
      ({ type: 'function', function: { name, description, parameters: inputSchema } }));
    const allowed = new Set(tools.map(tool => tool.function.name));
    toolsOffered = [...allowed];
    const known = new Set(receipt.toolsListed);
    stage = 'Ollama version';
    const about = await api(config.endpoint, '/api/version');
    if (!isObject(about) || typeof about.version !== 'string') throw new OllamaAnswered('missing version');
    receipt.ollamaVersion = about.version;
    const messages: object[] = [{ role: 'user', content: config.prompt, ...(config.images && config.images.length > 0 ? { images: config.images } : {}) }];
    for (let turn = 0; turn < config.maxTurns; turn++) {
      stage = 'Ollama chat';
      hooks.onChatRequest?.(turn);
      const decoding = config.options ? { options: config.options } : {};
      const message = config.stream
        ? await streamChat(config.endpoint, { model: config.model, stream: true, messages, tools, ...decoding }, turn, hooks)
        : chatMessage(await api(config.endpoint, '/api/chat', { model: config.model, stream: false, messages, tools, ...decoding }));
      if (!message.tool_calls?.length) {
        finalText = message.content;
        break;
      }
      messages.push(message);
      for (const call of message.tool_calls) {
        const { name, arguments: raw } = call.function;
        const args = argumentsOf(raw);
        const argumentsSha256 = sha256(JSON.stringify(args ?? raw ?? null));
        // A name the server did not list is model text: keep only its digest.
        const record: CallRecord = known.has(name) ? { name, argumentsSha256, ok: false } :
          { name: 'unlisted', nameSha256: `sha256:${sha256(name)}`, argumentsSha256, ok: false };
        toolCalls.push(record);
        // Ollama expects an object when the assistant turn is replayed, even for a rejected call.
        call.function.arguments = args ?? {};
        let content: string;
        if (!allowed.has(name)) {
          content = 'Tool not allowed.';
        } else if (!args) {
          content = 'Tool arguments must be a JSON object.';
        } else {
          stage = 'MCP tools/call';
          const response = await server.request('tools/call', { name, arguments: args });
          const result = response.result as McpToolResult | undefined;
          if (response.error) content = response.error.message;
          else if (result && Array.isArray(result.content)) {
            record.ok = !result.isError;
            content = JSON.stringify(result);
          } else throw new Error('Invalid MCP tool result');
        }
        messages.push({ role: 'tool', tool_name: name, content });
      }
      if (turn + 1 === config.maxTurns) console.error('Ollama chat stopped at --max-turns.');
    }
    receipt.finalTextSha256 = sha256(finalText);
    receipt.exitCode = (config.selfTest && !toolCalls.length) || toolCalls.some(call => !call.ok) ? 1 : 0;
  } catch (error) {
    // Network errors and server diagnostics can include local paths or endpoint credentials.
    let message: string;
    if (error instanceof OllamaAnswered) {
      receipt.exitCode = 1;
      message = `Ollama answered with ${error.message}.`;
    } else if (error instanceof BodyUnread) message = 'body could not be read or decoded.';
    else message = 'unavailable service or invalid response.';
    failure = { stage, message };
  } finally {
    server.close();
  }
  return { receipt, finalText, toolsOffered, failure };
}

async function run(config: BridgeConfig) {
  const { receipt, finalText, failure } = await runBridge(config);
  if (failure) console.error(`${failure.stage} failed: ${failure.message}`);
  if (config.selfTest || config.json) console.log(JSON.stringify(receipt));
  else if (finalText) console.log(finalText);
  return receipt.exitCode;
}

async function main() {
  let config: BridgeConfig;
  try { config = options(); } catch { console.error(usage); return 1; }
  return run(config);
}

if (require.main === module) void main().then(code => { process.exitCode = code; });
