#!/usr/bin/env node
// Generate (or drift-check) the MCP tool reference from the AUTHORITATIVE compiled tool registry
// (out/mcp/benchmarkActorMcpServer.js), so the doc can never drift from what `tools/list` actually
// publishes. ci-docs-style: `--write <path>` regenerates; `--check <path>` fails (exit 3) on drift.
//
// Needs `npm run compile` first (loads the compiled core). Wired into `npm test`, which compiles.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const root = join(here, '..');

const corePath = join(root, 'out', 'mcp', 'benchmarkActorMcpServer.js');
if (!existsSync(corePath)) {
  console.error('out/mcp/benchmarkActorMcpServer.js not found -- run `npm run compile` first.');
  process.exit(1);
}
const { BENCHMARK_ACTOR_MCP_TOOLS, BENCHMARK_ACTOR_MCP_PROTOCOL_VERSION, BENCHMARK_ACTOR_MCP_SERVER_NAME } =
  require(corePath);
const { OLLAMA_DEFAULT_TOOLS } = require(corePath);

// Fold in the ACG corroboration-grid tools staged into the bundle (out/acg-mcp-bundle/), so the generated
// reference matches what the SINGLE server's tools/list actually publishes (LBA-REQ-029).
const gridBundle = join(root, 'out', 'acg-mcp-bundle', 'acg-mcp', 'grid-tools.mjs');
let ACG_GRID_TOOLS = [];
if (existsSync(gridBundle)) {
  ({ ACG_GRID_TOOLS } = await import(pathToFileURL(gridBundle).href));
}

function renderArgs(inputSchema) {
  const props = inputSchema.properties ?? {};
  const names = Object.keys(props);
  if (names.length === 0) {
    return '_(no arguments)_';
  }
  const required = new Set(inputSchema.required ?? []);
  return names
    .map((n) => {
      const p = props[n];
      const parts = [p.type ?? 'any', required.has(n) ? 'required' : 'optional'];
      if (typeof p.minimum === 'number' || typeof p.maximum === 'number') {
        parts.push(`range ${p.minimum ?? ''}..${p.maximum ?? ''}`);
      }
      return `- \`${n}\` (${parts.join(', ')}) — ${p.description ?? ''}`.trimEnd();
    })
    .join('\n');
}

function render() {
  const lines = [];
  lines.push('# labview-benchmark-actor — MCP tools');
  lines.push('');
  lines.push(
    '> GENERATED from the MCP tool registry (`src/mcp/benchmarkActorMcpServer.ts`). Do not hand-edit;'
  );
  lines.push(
    '> regenerate with `node scripts/mcpToolDoc.mjs --write docs/mcp-tools.md`. Drift is gated by `npm test`.'
  );
  lines.push('');
  lines.push(
    `The extension contributes a Model Context Protocol server (provider \`labviewBenchmarkActor\`, ` +
      `server \`${BENCHMARK_ACTOR_MCP_SERVER_NAME}\`, protocol \`${BENCHMARK_ACTOR_MCP_PROTOCOL_VERSION}\`) ` +
      `exposing the following tools to Copilot agent mode. The server is a dependency-free stdio JSON-RPC ` +
      `process launched by the extension; the tools that shell \`lbabus\` degrade gracefully when the CLI is absent.`
  );
  lines.push('');
  lines.push('## Using the tools from a local Ollama model');
  lines.push('');
  lines.push('With Ollama running and a tool-capable model installed, use plain Node from the project root.');
  lines.push('For the capability probe, put `lbabus` on PATH or set `LBA_LBABUS_PATH` to its executable.');
  lines.push('These commands work in Windows PowerShell 5.1 and PowerShell 7:');
  lines.push('');
  lines.push('```powershell', 'npm.cmd ci', 'npm.cmd run compile',
    'node out/mcp/ollamaMcpBridge.js --model qwen3 --self-test', '$LASTEXITCODE', '```');
  lines.push('');
  lines.push('Use `--prompt "Show the benchmark series"` for a normal chat; `--json` prints a receipt instead of the final text.');
  lines.push('The bridge connects to `http://127.0.0.1:11434` by default (`--ollama` overrides `OLLAMA_HOST`).');
  lines.push('Tool results go to that endpoint, so use a model service you trust. No listener or editor is needed.');
  lines.push('');
  lines.push(`Enabled by default: ${[...OLLAMA_DEFAULT_TOOLS].map(name => `\`${name}\``).join(', ')}.`);
  lines.push('Use repeated `--allow-tool <name>` options to enable other listed tools, including the bus write.');
  lines.push('The server inherits the usual bus configuration. A denied call returns an error to the model.');
  lines.push('');
  lines.push('`--self-test` asks for a capability probe. Its JSON receipt lists all discovered tool names, the model and');
  lines.push('Ollama version, each call name, SHA-256 of its JSON arguments and success flag, the SHA-256 of the final');
  lines.push('text, and the exit code. A name the server did not list is recorded as `unlisted` with `nameSha256`, never');
  lines.push('as text. It contains no raw arguments, results or environment. Exit 0 means at least one call and all');
  lines.push('succeeded; 1 means no call, a failed call, or an Ollama HTTP error or invalid reply (for example a missing');
  lines.push('model); 2 means the MCP server failed or Ollama could not be connected to (refused, DNS, timeout).');
  lines.push('`--max-turns` bounds chat requests (default 8). At the limit the last calls are');
  lines.push('still counted; if there was no final reply, the final text hash is that of the empty string.');
  lines.push('');
  lines.push('## Active capture resources');
  lines.push('');
  lines.push(
    'The same server lists bounded, pathless `lba-capture://session/{runId}` metadata resources and supports ' +
      '`resources/read` for session state, ordered frame/sample batches, and explicitly requested PNG frames. ' +
      'Batch and frame URI templates are listed by `resources/templates/list`; frame reads require the SHA-256 ' +
      'returned by a batch. The extension passes its Global Storage root only through the stdio process environment. ' +
      'Reads never control capture. See ADR-0084 / LBA-REQ-101.'
  );
  lines.push('');
  for (const tool of BENCHMARK_ACTOR_MCP_TOOLS) {
    lines.push(`## \`${tool.name}\``);
    lines.push('');
    lines.push(tool.description);
    lines.push('');
    lines.push('**Arguments:**');
    lines.push('');
    lines.push(renderArgs(tool.inputSchema));
    lines.push('');
  }
  if (ACG_GRID_TOOLS.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## Corroboration grid tools (folded)');
    lines.push('');
    lines.push(
      'The same single server also folds in the Actor Corroboration Grid tools (ADR-0020 / LBA-REQ-029), so an ' +
        'agent can orchestrate release corroboration directly. Signing and recording stay operator/CI steps.'
    );
    lines.push('');
    for (const tool of ACG_GRID_TOOLS) {
      lines.push(`### \`${tool.name}\``);
      lines.push('');
      lines.push(tool.description);
      lines.push('');
      lines.push('**Arguments:**');
      lines.push('');
      lines.push(renderArgs(tool.inputSchema));
      lines.push('');
    }
  }
  // Canonical: LF, single trailing newline, no trailing whitespace.
  return lines.join('\n').replace(/[ \t]+$/gm, '').replace(/\n*$/, '\n');
}

const mode = process.argv[2];
const target = process.argv[3] ?? join(root, 'docs', 'mcp-tools.md');
const generated = render();

if (mode === '--check') {
  // Normalize CRLF->LF on the committed side so a Windows/git autocrlf checkout never false-drifts against
  // the LF-canonical generated output (LINUX runs this too).
  const current = existsSync(target) ? readFileSync(target, 'utf8').replace(/\r\n/g, '\n') : '';
  if (current !== generated) {
    console.error(`mcp-tool-doc: DRIFT -- ${target} does not match the tool registry. Regenerate with --write.`);
    process.exit(3);
  }
  console.log(`mcp-tool-doc: PASS -- ${target} matches the ${BENCHMARK_ACTOR_MCP_TOOLS.length + ACG_GRID_TOOLS.length}-tool registry.`);
} else if (mode === '--write') {
  writeFileSync(target, generated);
  console.log(`mcp-tool-doc: wrote ${target} (${BENCHMARK_ACTOR_MCP_TOOLS.length + ACG_GRID_TOOLS.length} tools).`);
} else {
  process.stdout.write(generated);
}
