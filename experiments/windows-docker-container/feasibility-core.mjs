const SCHEMA = 'labview-benchmark-actor/windows-container-gui-feasibility@1';

export const REQUIRED_VARIANTS = Object.freeze([
  'process-winsta0-standard-gdi',
  'process-inherited-no-device',
  'process-inherited-directx-gpu',
  'hyperv-inherited-no-device',
]);

const REQUIRED_ROW_FIELDS = [
  'variantId',
  'evidenceId',
  'imageReference',
  'imageId',
  'isolation',
  'desktopTarget',
  'deviceAssignment',
  'session',
  'display',
  'localComposition',
  'rfb',
  'cleanup',
  'status',
  'reason',
  'evidence',
];

function assertEvidenceFiles(row) {
  const entries = Object.entries(row.evidence.files ?? {});
  if (entries.length === 0) throw new Error(`${row.variantId}: immutable evidence files are required`);
  for (const [name, value] of entries) {
    if (!name || !value?.path || !/^[a-f0-9]{64}$/.test(value.sha256 ?? '')) {
      throw new Error(`${row.variantId}: malformed immutable evidence entry '${name}'`);
    }
  }
}

function assertRow(row) {
  for (const field of REQUIRED_ROW_FIELDS) {
    if (row[field] === undefined || row[field] === null) throw new Error(`${row.variantId ?? 'row'}: missing ${field}`);
  }
  if (!['process', 'hyperv'].includes(row.isolation)) throw new Error(`${row.variantId}: invalid isolation`);
  if (!['WinSta0', 'Inherited'].includes(row.desktopTarget)) throw new Error(`${row.variantId}: invalid desktop target`);
  if (!['tested', 'untested'].includes(row.status)) throw new Error(`${row.variantId}: invalid row status`);
  if (row.status === 'tested' && row.cleanup.proven !== true) throw new Error(`${row.variantId}: tested row lacks cleanup proof`);
  if (row.display.usableDisplay === true && row.display.monitorRectangles.length === 0) {
    throw new Error(`${row.variantId}: contradictory usable-display evidence`);
  }
  if (row.localComposition.available === true && row.localComposition.result !== 'non-black') {
    throw new Error(`${row.variantId}: contradictory composition evidence`);
  }
  if (row.rfb.usableFramebuffer === true && row.rfb.result !== 'non-black-probe-matched') {
    throw new Error(`${row.variantId}: contradictory framebuffer evidence`);
  }
  if (row.rfb.attempted !== true && row.rfb.result !== 'not-attempted') {
    throw new Error(`${row.variantId}: unattempted RFB has a result`);
  }
  if (row.isolation === 'hyperv' && row.deviceAssignment !== 'none') {
    throw new Error(`${row.variantId}: Hyper-V container device assignment is unsupported`);
  }
  assertEvidenceFiles(row);
}

export function deriveFeasibilityDecision(rows, officialSources) {
  if (!Array.isArray(rows)) throw new Error('feasibility rows are required');
  if (!Array.isArray(officialSources) || officialSources.length < 3) {
    throw new Error('authoritative platform sources are required');
  }
  const byId = new Map();
  for (const row of rows) {
    assertRow(row);
    if (byId.has(row.variantId)) throw new Error(`duplicate feasibility row '${row.variantId}'`);
    byId.set(row.variantId, row);
  }
  for (const variant of REQUIRED_VARIANTS) {
    if (!byId.has(variant)) throw new Error(`missing required feasibility variant '${variant}'`);
  }
  const requiredRows = REQUIRED_VARIANTS.map((id) => byId.get(id));
  if (requiredRows.some((row) => row.status !== 'tested')) {
    return {
      decision: 'untested',
      complete: false,
      reason: 'one or more required Windows-container variants lack preserved evidence',
    };
  }
  const transport = rows.some((row) => row.rfb.transportProven === true);
  const rfbProtocol = rows.some((row) => row.rfb.protocolProven === true);
  const usableDisplay = rows.some((row) => row.display.usableDisplay === true);
  const composition = rows.some((row) => row.localComposition.available === true);
  const usableFramebuffer = rows.some((row) => row.rfb.usableFramebuffer === true);
  const labviewVisual = rows.some((row) => row.labviewVisualBenchmark === 'passed');
  if (labviewVisual && (!usableDisplay || !composition || !usableFramebuffer)) {
    throw new Error('contradictory LabVIEW visual-benchmark evidence');
  }
  const unsupportedSource = officialSources.some((source) => source.claims?.includes('interactive-gui-unsupported'));
  if (!unsupportedSource) throw new Error('Microsoft GUI-support constraint is missing');
  return {
    decision: labviewVisual ? 'supported' : 'unsupported-by-windows-container-platform',
    complete: true,
    reason: labviewVisual
      ? 'A tested Windows-container variant produced verified LabVIEW pixels.'
      : 'All required variants lack a usable display/composition surface and Microsoft excludes interactive GUI workloads from Windows containers.',
    capabilities: {
      networkRelay: transport ? 'supported-and-proven' : 'not-proven',
      rfbProtocolAndAuthentication: rfbProtocol ? 'supported-and-proven' : 'not-proven',
      processAndWindowCreation: 'window-objects-created-without-supported-interactive-display',
      monitorAndDisplayPath: usableDisplay ? 'available' : 'unavailable-in-tested-substrates',
      desktopComposition: composition ? 'available' : 'unavailable-in-tested-substrates',
      tightVncFramebuffer: usableFramebuffer ? 'usable' : rfbProtocol ? 'protocol-proven-but-no-usable-framebuffer' : 'not-proven',
      labviewVisualBenchmark: labviewVisual ? 'passed' : 'unsupported-display-precondition',
      platformSupport: 'interactive-gui-unsupported',
    },
  };
}
export function buildFeasibilityReceipt({ rows, officialSources, generatedWallTime }) {
  const aggregate = deriveFeasibilityDecision(rows, officialSources);
  return {
    schema: SCHEMA,
    generatedWallTime,
    rows,
    aggregate,
    officialSources,
    stopCondition: aggregate.decision === 'unsupported-by-windows-container-platform'
      ? 'Do not retry Windows-container GUI/display variants without new authoritative vendor support for an interactive container display path.'
      : null,
    reusableSuccesses: [
      'loopback-only host TCP relay',
      'authenticated RFB 3.8 client and TightVNC transport',
      'MPRR framebuffer, fingerprint, settle, resource, evidence, and cleanup components',
    ],
    supportedPivot: {
      substrate: 'full-windows-vm-with-interactive-session',
      capturePaths: ['virtualbox-vrde-vnc', 'vmware-remote-display-vnc', 'guest-tightvnc-over-loopback-only-host-transport'],
    },
  };
}
