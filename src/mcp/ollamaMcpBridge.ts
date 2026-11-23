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

function options() {
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
function openServer() {
  const child = spawn(process.execPath, [join(__dirname, 'runBenchmarkActorMcpServer.js')], {
    shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore']
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
class OllamaAnswered extends Error {}
// A transfer failure and a content-encoding failure look alike through fetch, so both are exit 2.
class BodyUnread extends Error {}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

async function api(endpoint: URL, path: string, body?: object): Promise<unknown> {
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

interface CallRecord { name: string; nameSha256?: string; argumentsSha256: string; ok: boolean }

function argumentsOf(raw: unknown): Json | undefined {
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { return undefined; }
  }
  return isObject(value) ? value : undefined;
}

async function run(config: ReturnType<typeof options>) {
  const toolCalls: CallRecord[] = [];
  const receipt = { ollamaVersion: '', model: config.model, toolsListed: [] as string[], toolCalls,
    finalTextSha256: sha256(''), exitCode: 2 };
  const server = openServer();
  let stage = 'MCP discovery';
  let finalText = '';
  try {
    const listed = await server.list();
    receipt.toolsListed = listed.map(tool => tool.name);
    const tools = listed.filter(tool => config.allow.has(tool.name)).map(({ name, description, inputSchema }) =>
      ({ type: 'function', function: { name, description, parameters: inputSchema } }));
    const allowed = new Set(tools.map(tool => tool.function.name));
    const known = new Set(receipt.toolsListed);
    stage = 'Ollama version';
    const about = await api(config.endpoint, '/api/version');
    if (!isObject(about) || typeof about.version !== 'string') throw new OllamaAnswered('missing version');
    receipt.ollamaVersion = about.version;
    const messages: object[] = [{ role: 'user', content: config.prompt }];
    for (let turn = 0; turn < config.maxTurns; turn++) {
      stage = 'Ollama chat';
      const message = chatMessage(await api(config.endpoint, '/api/chat',
        { model: config.model, stream: false, messages, tools }));
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
    if (error instanceof OllamaAnswered) {
      receipt.exitCode = 1;
      console.error(`${stage} failed: Ollama answered with ${error.message}.`);
    } else if (error instanceof BodyUnread) console.error(`${stage} failed: body could not be read or decoded.`);
    else console.error(`${stage} failed: unavailable service or invalid response.`);
  } finally {
    server.close();
  }
  if (config.selfTest || config.json) console.log(JSON.stringify(receipt));
  else if (finalText) console.log(finalText);
  return receipt.exitCode;
}

async function main() {
  let config: ReturnType<typeof options>;
  try { config = options(); } catch { console.error(usage); return 1; }
  return run(config);
}

void main().then(code => { process.exitCode = code; });
