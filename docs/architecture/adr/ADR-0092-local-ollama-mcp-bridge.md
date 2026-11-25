# ADR-0092: Let a local Ollama model call the bundled MCP server

- Status: Accepted
- Date: 2026-11-23
- Owner: WIN
- Traces to: LBA-REQ-019

## Context

Ollama accepts function tools in its chat API but does not launch the actor's stdio server.
Using a tool-capable local model should not require an editor or a second tool implementation.

## Decision

The Node CLI starts the same server with the running Node executable, an absolute script path
and inherited bus configuration (ADR-0042). It initializes the session, discovers the registry,
and passes permitted schemas unchanged to Ollama. Calls and results stay in the chat history
for a bounded number of turns. Neither side needs a new listener.

Only the host probe, benchmark series and bus poll are enabled in the registry by default.
A write, folded tool or new tool needs explicit permission by name. The bridge checks this at
dispatch too: a model can request a tool that was never advertised to it.

Use built-in child processes, newline-delimited JSON-RPC and HTTP fetch, not an MCP SDK. This
client uses only three request methods against the bundled protocol version. An SDK would add
a runtime dependency to the extension without removing the need for tool policy or chat mapping.

## Consequences

The bridge shares the server's handlers and errors, not the editor's configuration store.
An operator must supply any non-default bus settings. The endpoint receives tool results;
the self-test receipt keeps only names, versions, hashes and outcome fields. Offline integration
tests cover the chat exchange; an actual model's tool use still needs a live self-test.
