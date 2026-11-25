/**
 * Model Context Protocol (MCP) surface for labview-benchmark-actor.
 *
 * A dependency-free JSON-RPC 2.0 handler (no MCP SDK) exposing THIS extension's own tools to an agent:
 * host capabilities, the deterministic benchmark series, and the cross-plane coordination bus. It follows
 * a standard JSON-RPC MCP server pattern and carries no VI-semantic domain — it wraps the
 * same surfaces the extension's commands do (`lbabus capabilities|poll|post` + the bundled mprr series).
 *
 * This module is PURE and unit-testable: the side-effecting tool implementations (shelling `lbabus`,
 * reading the bundled series) are INJECTED via {@link BenchmarkActorMcpToolDeps}. Only the stdio
 * entrypoint (`src/mcp/runBenchmarkActorMcpServer.ts`) touches process streams and the real CLI/filesystem.
 */

export const BENCHMARK_ACTOR_MCP_PROTOCOL_VERSION = '2025-06-18';
export const BENCHMARK_ACTOR_MCP_SERVER_NAME = 'labview-benchmark-actor';

/** JSON-RPC 2.0 error codes used by the handler. */
export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface McpToolTextContent {
  type: 'text';
  text: string;
}

export interface McpToolResult {
  content: McpToolTextContent[];
  isError?: boolean;
}

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

export interface BenchmarkActorMcpResources {
  listResources(): McpResourceDescriptor[] | Promise<McpResourceDescriptor[]>;
  readResource(uri: string): McpResourceContents[] | Promise<McpResourceContents[]>;
}

export interface BenchmarkActorMcpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

/** Thrown by argument parsing so the dispatcher can map it to JSON-RPC -32602 (invalid params). */
export class McpArgumentError extends Error {}

/**
 * The authoritative tool registry. `tools/list` publishes exactly this set, and `tools/call` rejects any
 * name not in it before a handler runs.
 */
const coreRegistry: readonly (BenchmarkActorMcpTool & { ollamaDefault?: true })[] = [
  {
    name: 'get_host_capabilities',
    ollamaDefault: true,
    description:
      "Report what the current host can actually run for LabVIEW benchmarking (LabVIEW runtime + bitness, " +
      "Docker engine, etc.) via the lbabus capabilities probe. Run this before proposing benchmark work.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_benchmark_series',
    ollamaDefault: true,
    description:
      "Return the deterministic mprr ring-buffer benchmark metric series the extension's viewer renders, as " +
      "ordered {t,v} points plus a stable content hash (seriesHash). Reproduce this series; do not re-derive it. " +
      "Pass runId to also get that local capture's GPU series (nvidia-smi utilization/memory/power, or the reason it is unavailable).",
    inputSchema: {
      type: 'object',
      properties: {
        runId: {
          type: 'string',
          maxLength: 64,
          description: 'Optional capture run id (uuid) or "latest": adds that capture\'s GPU series (metadata only).'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'poll_coordination_bus',
    ollamaDefault: true,
    description:
      'Read the latest cross-plane (WIN <-> LINUX) coordination-bus messages from the live-only lbabus net bus ' +
      '(net poll of the local receive-log). The bus is the authoritative "what is next" channel.',
    inputSchema: {
      type: 'object',
      properties: {
        tail: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'How many of the most recent messages to read (default 10).'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'post_coordination_note',
    description: 'Post a NOTE to the cross-plane coordination bus over the live-only lbabus net bus (net send).',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'ASCII coordination note body.' }
      },
      required: ['message'],
      additionalProperties: false
    }
  },
  {
    name: 'export_capture_clip',
    description:
      'Encode the frames of one local capture between two markers (default: the latest two) or two frame indices ' +
      'into an H.264 MP4 inside that capture\'s clips/ directory, held at real time. Returns the receipt only ' +
      '(marker instants, deltaMs/admitted, frame range, fps, SHA-256, size, duration); the clip never leaves the machine.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', maxLength: 64, description: 'Capture run id (uuid) or "latest" (default).' },
        fromMarker: { type: 'integer', minimum: 0, description: 'Start marker: index into the capture markers[].' },
        toMarker: { type: 'integer', minimum: 0, description: 'End marker: index into the capture markers[].' },
        fromFrame: { type: 'integer', minimum: 0, description: 'Start frame index (instead of markers).' },
        toFrame: { type: 'integer', minimum: 0, description: 'End frame index, inclusive (instead of markers).' },
        monitor: { type: 'integer', minimum: 0, description: 'Crop to this monitor of the recorded screen layout.' },
        crop: {
          type: 'object',
          description: 'Crop rectangle in frame pixels (must lie inside the frame).',
          properties: {
            x: { type: 'integer', minimum: 0 },
            y: { type: 'integer', minimum: 0 },
            w: { type: 'integer', minimum: 1 },
            h: { type: 'integer', minimum: 1 }
          },
          required: ['x', 'y', 'w', 'h'],
          additionalProperties: false
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'add_capture_marker',
    description:
      'Add an agent-cue marker to one local capture at an instant (ms since frame 0) or a frame index. It uses the ' +
      'same nearest-frame grab as a user click (imageGrab: nearestFrameIndex, deltaMs, admitted within toleranceMs).',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', maxLength: 64, description: 'Capture run id (uuid) or "latest" (default).' },
        instantMs: { type: 'number', description: 'Instant on the capture time axis (ms since frame 0).' },
        frameIndex: { type: 'integer', minimum: 0, description: 'Or a frame index (its tMs is the instant).' },
        label: { type: 'string', minLength: 1, maxLength: 80, description: 'What the agent observed (<= 80 characters).' }
      },
      required: ['label'],
      additionalProperties: false
    }
  }
] as const;

// Permission is local to the bridge, not a change to the server's tools/list protocol.
export const BENCHMARK_ACTOR_MCP_TOOLS: readonly BenchmarkActorMcpTool[] =
  coreRegistry.map(({ ollamaDefault, ...tool }) => tool);
export const OLLAMA_DEFAULT_TOOLS: ReadonlySet<string> =
  new Set(coreRegistry.filter(tool => tool.ollamaDefault).map(tool => tool.name));

const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set(BENCHMARK_ACTOR_MCP_TOOLS.map((t) => t.name));

/** Side-effecting tool implementations, injected by the stdio entrypoint (or a test double). */
export interface BenchmarkActorMcpToolDeps {
  /** Version reported in `initialize` → `serverInfo.version` (the extension/package version). */
  readonly serverVersion: string;
  getHostCapabilities(): Promise<McpToolResult>;
  getBenchmarkSeries(args?: { runId?: string }): Promise<McpToolResult>;
  pollCoordinationBus(args: { tail: number }): Promise<McpToolResult>;
  postCoordinationNote(args: { message: string }): Promise<McpToolResult>;
  /** Encode a clip between two markers of a local capture; returns the receipt (never pixels). */
  exportCaptureClip?(args: ExportCaptureClipArgs): Promise<McpToolResult>;
  /** Append an agent-cue marker to a local capture. */
  addCaptureMarker?(args: AddCaptureMarkerArgs): Promise<McpToolResult>;
  /**
   * Optional EXTRA tools folded into this single server at runtime (the ACG corroboration-grid surface).
   * Their schemas are published in `tools/list` alongside the core tools; a `tools/call` for one routes to
   * {@link dispatchExtraTool}. Kept injected (not static) so the pure handler stays domain-free.
   */
  readonly extraTools?: readonly BenchmarkActorMcpTool[];
  /** Execute a folded extra tool by name. Throw {@link McpArgumentError} for a bad argument shape (-32602). */
  dispatchExtraTool?(name: string, args: unknown): Promise<unknown> | unknown;
  /** Read-only active-capture MCP resources; independent of the core tool registry. */
  readonly captureResources?: BenchmarkActorMcpResources;
}

export interface ExportCaptureClipArgs {
  runId?: string;
  fromMarker?: number;
  toMarker?: number;
  fromFrame?: number;
  toFrame?: number;
  monitor?: number;
  crop?: { x: number; y: number; w: number; h: number };
}
export interface AddCaptureMarkerArgs {
  runId?: string;
  instantMs?: number;
  frameIndex?: number;
  label: string;
}

function success(id: number | string | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function failure(id: number | string | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Normalize a folded extra-tool return value into an MCP tool result (wrap a plain value as pretty JSON). */
function toMcpResult(value: unknown): McpToolResult {
  if (value && typeof value === 'object' && Array.isArray((value as McpToolResult).content)) {
    return value as McpToolResult;
  }
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function parseTail(rawArguments: unknown): number {
  if (rawArguments === undefined || rawArguments === null) {
    return 10;
  }
  if (typeof rawArguments !== 'object') {
    throw new McpArgumentError('arguments must be an object');
  }
  const tail = (rawArguments as { tail?: unknown }).tail;
  if (tail === undefined) {
    return 10;
  }
  if (typeof tail !== 'number' || !Number.isInteger(tail) || tail < 1 || tail > 100) {
    throw new McpArgumentError('"tail" must be an integer between 1 and 100');
  }
  return tail;
}

function parseMessage(rawArguments: unknown): string {
  if (typeof rawArguments !== 'object' || rawArguments === null) {
    throw new McpArgumentError('arguments must be an object with a "message" string');
  }
  const message = (rawArguments as { message?: unknown }).message;
  if (typeof message !== 'string' || message.trim().length === 0) {
    throw new McpArgumentError('"message" must be a non-empty string');
  }
  return message;
}

function argumentObject(rawArguments: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (rawArguments === undefined || rawArguments === null) return {};
  if (typeof rawArguments !== 'object' || Array.isArray(rawArguments)) {
    throw new McpArgumentError('arguments must be an object');
  }
  const args = rawArguments as Record<string, unknown>;
  const unknown = Object.keys(args).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new McpArgumentError(`unknown argument "${unknown}"`);
  return args;
}

function optionalRunId(args: Record<string, unknown>): string | undefined {
  const runId = args.runId;
  if (runId === undefined) return undefined;
  if (typeof runId !== 'string' || !/^(latest|[0-9a-f-]{36})$/i.test(runId)) {
    throw new McpArgumentError('"runId" must be a capture run id (uuid) or "latest"');
  }
  return runId;
}

function optionalIndex(args: Record<string, unknown>, name: string, minimum = 0): number | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new McpArgumentError(`"${name}" must be an integer >= ${minimum}`);
  }
  return value;
}

function parseSeriesArgs(rawArguments: unknown): { runId?: string } | undefined {
  const runId = optionalRunId(argumentObject(rawArguments, ['runId']));
  return runId === undefined ? undefined : { runId };
}

export function parseExportClipArgs(rawArguments: unknown): ExportCaptureClipArgs {
  const args = argumentObject(rawArguments, ['runId', 'fromMarker', 'toMarker', 'fromFrame', 'toFrame', 'monitor', 'crop']);
  const parsed: ExportCaptureClipArgs = {};
  const runId = optionalRunId(args);
  if (runId !== undefined) parsed.runId = runId;
  for (const name of ['fromMarker', 'toMarker', 'fromFrame', 'toFrame', 'monitor'] as const) {
    const value = optionalIndex(args, name);
    if (value !== undefined) parsed[name] = value;
  }
  if (args.crop !== undefined) {
    const crop = argumentObject(args.crop, ['x', 'y', 'w', 'h']);
    const [x, y, w, h] = [optionalIndex(crop, 'x'), optionalIndex(crop, 'y'), optionalIndex(crop, 'w', 1), optionalIndex(crop, 'h', 1)];
    if (x === undefined || y === undefined || w === undefined || h === undefined) {
      throw new McpArgumentError('"crop" needs integer x, y, w and h');
    }
    parsed.crop = { x, y, w, h };
  }
  return parsed;
}

export function parseAddMarkerArgs(rawArguments: unknown): AddCaptureMarkerArgs {
  const args = argumentObject(rawArguments, ['runId', 'instantMs', 'frameIndex', 'label']);
  const label = args.label;
  if (typeof label !== 'string' || label.trim().length === 0 || label.trim().length > 80) {
    throw new McpArgumentError('"label" must be a non-empty string of at most 80 characters');
  }
  const parsed: AddCaptureMarkerArgs = { label: label.trim() };
  const runId = optionalRunId(args);
  if (runId !== undefined) parsed.runId = runId;
  const frameIndex = optionalIndex(args, 'frameIndex');
  const instantMs = args.instantMs;
  if (instantMs !== undefined && (typeof instantMs !== 'number' || !Number.isFinite(instantMs))) {
    throw new McpArgumentError('"instantMs" must be a finite number');
  }
  if ((instantMs === undefined) === (frameIndex === undefined)) {
    throw new McpArgumentError('give exactly one of "instantMs" or "frameIndex"');
  }
  if (frameIndex !== undefined) parsed.frameIndex = frameIndex;
  else parsed.instantMs = instantMs as number;
  return parsed;
}

const CAPTURE_TOOLS_UNAVAILABLE: McpToolResult = {
  content: [{ type: 'text', text: 'Tool error: capture tools are not available in this server.' }],
  isError: true
};

async function callTool(
  name: string,
  rawArguments: unknown,
  deps: BenchmarkActorMcpToolDeps
): Promise<McpToolResult> {
  switch (name) {
    case 'get_host_capabilities':
      return deps.getHostCapabilities();
    case 'get_benchmark_series': {
      const seriesArgs = parseSeriesArgs(rawArguments);
      return seriesArgs ? deps.getBenchmarkSeries(seriesArgs) : deps.getBenchmarkSeries();
    }
    case 'poll_coordination_bus':
      return deps.pollCoordinationBus({ tail: parseTail(rawArguments) });
    case 'post_coordination_note':
      return deps.postCoordinationNote({ message: parseMessage(rawArguments) });
    case 'export_capture_clip': {
      const clipArgs = parseExportClipArgs(rawArguments);
      return deps.exportCaptureClip ? deps.exportCaptureClip(clipArgs) : CAPTURE_TOOLS_UNAVAILABLE;
    }
    case 'add_capture_marker': {
      const markerArgs = parseAddMarkerArgs(rawArguments);
      return deps.addCaptureMarker ? deps.addCaptureMarker(markerArgs) : CAPTURE_TOOLS_UNAVAILABLE;
    }
    default:
      // Unreachable: tools/call already rejected unknown names against KNOWN_TOOL_NAMES.
      throw new McpArgumentError(`unknown tool: ${name}`);
  }
}

/**
 * Dependency-free JSON-RPC 2.0 dispatcher for the labview-benchmark-actor MCP surface. Returns a response
 * for requests, or `null` for notifications (which take no reply). Argument-shape failures become a
 * structured -32602; genuine tool-execution failures stay inside the result envelope (`isError`) per MCP,
 * so the agent can read the message rather than seeing a transport error.
 */
export async function handleBenchmarkActorMcpMessage(
  message: JsonRpcRequest,
  deps: BenchmarkActorMcpToolDeps
): Promise<JsonRpcResponse | null> {
  const id = message.id ?? null;

  switch (message.method) {
    case 'initialize':
      return success(id, {
        protocolVersion: BENCHMARK_ACTOR_MCP_PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: BENCHMARK_ACTOR_MCP_SERVER_NAME, version: deps.serverVersion }
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'ping':
      return success(id, {});

    case 'tools/list':
      return success(id, { tools: [...BENCHMARK_ACTOR_MCP_TOOLS, ...(deps.extraTools ?? [])] });

    case 'resources/list':
      return success(id, { resources: await deps.captureResources?.listResources() ?? [] });

    case 'resources/templates/list':
      return success(id, {
        resourceTemplates: [
          {
            uriTemplate: 'lba-capture://session/{runId}/batch?afterFrame={afterFrame}&afterSample={afterSample}&limit={limit}',
            name: 'Active capture evidence batch',
            description: 'Read an ordered, bounded batch of frame and resource-sample metadata.',
            mimeType: 'application/json'
          },
          {
            uriTemplate: 'lba-capture://session/{runId}/frame/{sequence}?sha256={sha256}',
            name: 'Explicit captured frame',
            description: 'Read one complete PNG frame after matching the SHA-256 from its evidence batch.',
            mimeType: 'image/png'
          }
        ]
      });

    case 'resources/read': {
      const params = (message.params ?? {}) as { uri?: unknown };
      if (typeof params.uri !== 'string' || params.uri.length > 2048) {
        return failure(id, JSON_RPC_INVALID_PARAMS, 'resources/read requires a bounded string "uri"');
      }
      try {
        const contents = await deps.captureResources?.readResource(params.uri);
        if (!contents) return failure(id, -32002, 'resource unavailable');
        return success(id, { contents });
      } catch {
        return failure(id, -32002, 'resource unavailable');
      }
    }

    case 'tools/call': {
      const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
      if (typeof params.name !== 'string') {
        return failure(id, JSON_RPC_INVALID_PARAMS, 'tools/call requires a string "name"');
      }
      const isCore = KNOWN_TOOL_NAMES.has(params.name);
      const isExtra = !isCore && (deps.extraTools ?? []).some((t) => t.name === params.name);
      if (!isCore && !isExtra) {
        return failure(id, JSON_RPC_INVALID_PARAMS, `unknown tool: ${params.name}`);
      }
      try {
        if (isCore) {
          return success(id, await callTool(params.name, params.arguments, deps));
        }
        const result = await deps.dispatchExtraTool!(params.name, params.arguments);
        return success(id, toMcpResult(result));
      } catch (error) {
        if (error instanceof McpArgumentError) {
          return failure(id, JSON_RPC_INVALID_PARAMS, error.message);
        }
        // A folded (extra) tool's genuine execution failure rides inside the result envelope per MCP so the
        // agent can read it; a CORE tool's non-argument failure propagates (as before) for the transport to log.
        if (isExtra) {
          return success(id, { content: [{ type: 'text', text: errorText(error) }], isError: true });
        }
        throw error;
      }
    }

    default:
      return failure(id, JSON_RPC_METHOD_NOT_FOUND, `unknown method: ${message.method}`);
  }
}
