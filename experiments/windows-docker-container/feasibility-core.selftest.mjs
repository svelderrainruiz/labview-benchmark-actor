import assert from 'node:assert/strict';
import { buildFeasibilityReceipt, deriveFeasibilityDecision, REQUIRED_VARIANTS } from './feasibility-core.mjs';

const source = [{
  url: 'https://learn.microsoft.com/windows-containers',
  claims: ['interactive-gui-unsupported'],
}, { url: 'https://learn.microsoft.com/devices', claims: ['device-list-limited'] }, {
  url: 'https://learn.microsoft.com/gpu',
  claims: ['directx-only'],
}];
const hash = 'a'.repeat(64);
const row = (variantId, overrides = {}) => ({
  variantId,
  evidenceId: `${variantId}-run`,
  imageReference: 'nationalinstruments/labview:2026q3-windows',
  imageId: `sha256:${'b'.repeat(64)}`,
  isolation: variantId.startsWith('hyperv') ? 'hyperv' : 'process',
  desktopTarget: variantId.includes('winsta0') ? 'WinSta0' : 'Inherited',
  deviceAssignment: variantId.includes('directx') ? 'directx-gpu-class' : 'none',
  session: { id: 2, windowStation: 'Service-dynamic$', desktop: 'Default' },
  display: { monitorRectangles: [], attachedDisplayDevices: [], activePathCount: 0, activeModeCount: 0, usableDisplay: false },
  processWindow: { created: true, visible: false },
  localComposition: { attempted: true, available: false, result: 'access-denied' },
  rfb: { attempted: false, transportProven: false, protocolProven: false, usableFramebuffer: false, result: 'not-attempted' },
  labviewVisualBenchmark: 'not-attempted-display-precondition',
  cleanup: { proven: true },
  status: 'tested',
  reason: 'no usable display path',
  evidence: { files: { manifest: { path: 'manifest.json', sha256: hash } } },
  ...overrides,
});
const rows = REQUIRED_VARIANTS.map((id) => row(id));
rows[0] = row(REQUIRED_VARIANTS[0], {
  rfb: {
    attempted: true,
    transportProven: true,
    protocolProven: true,
    usableFramebuffer: false,
    result: 'uniform-black',
  },
});
const receipt = buildFeasibilityReceipt({ rows, officialSources: source, generatedWallTime: '2026-08-07T00:00:00Z' });
assert.equal(receipt.aggregate.decision, 'unsupported-by-windows-container-platform');
assert.equal(receipt.aggregate.capabilities.networkRelay, 'supported-and-proven');
assert.equal(receipt.aggregate.capabilities.rfbProtocolAndAuthentication, 'supported-and-proven');
assert.equal(receipt.aggregate.capabilities.labviewVisualBenchmark, 'unsupported-display-precondition');
assert.match(receipt.stopCondition, /Do not retry/);

assert.equal(deriveFeasibilityDecision(
  rows.map((item, index) => (index === 3 ? { ...item, status: 'untested' } : item)),
  source,
).decision, 'untested');
assert.throws(() => deriveFeasibilityDecision(rows.slice(0, 3), source), /missing required/);
assert.throws(() => deriveFeasibilityDecision(
  rows.map((item, index) => (index === 1
    ? { ...item, display: { ...item.display, usableDisplay: true } }
    : item)),
  source,
), /contradictory usable-display/);
assert.throws(() => deriveFeasibilityDecision(
  rows.map((item, index) => (index === 1
    ? { ...item, evidence: { files: { manifest: { path: 'manifest.json', sha256: 'bad' } } } }
    : item)),
  source,
), /malformed immutable evidence/);
assert.throws(() => deriveFeasibilityDecision(rows, source.slice(1)), /authoritative platform sources/);
assert.throws(() => deriveFeasibilityDecision(
  rows.map((item, index) => (index === 3 ? { ...item, deviceAssignment: 'directx-gpu-class' } : item)),
  source,
), /Hyper-V container device assignment is unsupported/);

console.log('windows-container GUI feasibility core self-test: PASS');
