# ADR-0085: Standalone Windows desktop capture

- Status: Proposed
- Date: 2026-11-11
- Traces to: LBA-REQ-102

## Context

ProjectBuddy's synthetic decision task is independent of LabVIEW and VIPM. The existing capture command locates and launches LabVIEW, and its fixed 12-fps image stream exceeds a bounded local-model queue before a typical request completes. NI activation and silent evidence dropping are not acceptable workarounds.

## Decision

Add a separate, explicitly invoked Windows Capture Desktop command using the existing recorder, resource sampler, lifecycle writer, finalization, and read-only MCP resources. Label its workload `desktop-capture`. Validate an operator-selected integer frame interval of 1 through 120 seconds before starting capture, defaulting to 60 seconds, and retain cadence metadata. Preserve the existing LabVIEW launch guards and 12-fps defaults. Capture control remains a VS Code command, never an MCP resource side effect.

## Consequences

The standalone Windows task can be recorded without NI activation. Cadence becomes an explicit calibration input rather than a hidden queue-overflow workaround. Host-free fixtures do not establish Windows/live/model qualification; that remains a separate proof with private raw evidence and independent outcome scoring.