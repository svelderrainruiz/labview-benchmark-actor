# ADR-0084: Pathless MCP resources for active capture evidence

- Status: Proposed
- Date: 2026-11-11
- Deciders: Actor maintainer
- Relates to: LBA-REQ-101, ADR-0012, ADR-0035, Actor issue #45, ProjectBuddy #250/#255

## Context

The extension records active launch frames and resource samples under its VS Code Global Storage directory. It writes a `capture-status.json` beacon when capture starts and finalizes `capture.json` only after the user stops capture. The MCP server is a separate stdio process, so it cannot read the extension process's in-memory `activeCapture`; the current four tools do not expose live frames or samples. Returning `runDir` would leak a host path, and embedding images in a default tool result would be unbounded and expensive.

## Decision

- Preserve the existing four core tools. Add a separate, read-only MCP resources capability; do not put run/frame data on the `lbabus` bus.
- At capture start, generate a random opaque run UUID and write `active-capture-session@1` in the run directory. Update its lifecycle to `finalizing` before recorder stop/finalization, then `stopped` or `failed`.
- The extension MCP provider passes the Global Storage `captures` root to the separate stdio server as a process environment value. It is never an MCP argument or returned to the agent.
- `resources/list` returns a bounded set of pathless session metadata resources. Session/batch resource reads expose ordered frame and resource-sample metadata, cursors/watermarks, lifecycle state, and explicit gap/incomplete markers.
- Frame bytes are available only from an explicit `lba-capture://session/<runId>/frame/<sequence>?sha256=<digest>` resource read. The reader validates the run identity, frame sequence, file size, PNG structure/chunk CRCs, and the requested SHA-256 before returning bytes. Reads are capped at the admitted size plus one detection byte and require unchanged file identity, timestamps, and size across stat/open/read. Partial, corrupt, replaced, or growing PNGs and partial JSONL lines are not complete evidence.
- Reads are side-effect-free and cannot start, pause, stop, or finalize the capture. They do not convert `capturing`, `finalizing`, `failed`, or uncertain state into a final assessment.

## Consequences

The stdio server gains a stable, testable read boundary without exposing extension-local paths or changing finalized `launch-capture@1` records. ProjectBuddy can pin the Actor contract and poll bounded batches for on-demand, periodic, and continuous modes. A lost sequence or malformed/partial file remains detectable as incomplete rather than being silently normalized.

## Alternatives considered

- **Have ProjectBuddy crawl Global Storage.** Rejected: the path is host/editor-specific and would bypass the Actor's ownership boundary.
- **Embed frame bytes in the default tool result.** Rejected: it defeats bounded batch/backpressure and makes metadata-only reads expensive.
- **Send frames over `lbabus`.** Rejected: the coordination bus carries inter-actor messages only, never run/frame evidence (ADR-0003 / LBA-REQ-007).
- **Treat `capture-status.json` as finalized evidence.** Rejected: its active beacon is a lifecycle signal; only stopped, integrity-checked evidence is final.