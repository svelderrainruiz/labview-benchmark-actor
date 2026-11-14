// The mprr shared capture contract, vendored from a tagged mprr release and pinned by SHA-256 (ADR-0086).
// The implementation in experiments/mprr-ring and experiments/mprr-capture-ring stays self-owned (ADR-0009);
// this module only checks that implementation against the published contract.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const MPRR_CONTRACT_PATH = join(here, 'contract', 'mprr-shared-contract.v1.json');
export const MPRR_CONTRACT_PIN_PATH = join(here, 'contract', 'pin.json');
export const MPRR_CONTRACT_SCHEMA_VERSION = 'mprr-shared-contract-v1';

/** Load the vendored contract; fails closed when its bytes do not match the pinned SHA-256. */
export function loadMprrContract(contractPath = MPRR_CONTRACT_PATH, pinPath = MPRR_CONTRACT_PIN_PATH) {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'));
  const bytes = readFileSync(contractPath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== pin.sha256) {
    throw new Error(`mprr contract: ${contractPath} has sha256 ${sha256}, pin ${pin.tag} expects ${pin.sha256}`);
  }
  const contract = JSON.parse(bytes.toString('utf8'));
  if (contract.schemaVersion !== MPRR_CONTRACT_SCHEMA_VERSION) {
    throw new Error(`mprr contract: schemaVersion ${contract.schemaVersion} is not ${MPRR_CONTRACT_SCHEMA_VERSION}`);
  }
  return { pin, contract, sha256 };
}

export function contractEntry(contract, canonicalId) {
  const entry = contract.contracts.find((candidate) => candidate.id === canonicalId);
  if (!entry) throw new Error(`mprr contract: no contract ${canonicalId}`);
  return entry;
}

/** True when a record's schema value names the contract, by its canonical identifier or an accepted alias. */
export function isContractSchema(contract, canonicalId, schemaValue) {
  const entry = contractEntry(contract, canonicalId);
  return schemaValue === entry.id || entry.aliases.includes(schemaValue);
}

/** Mismatches between the ring constants and the contract constants (empty when they agree). */
export function compareRingConstants(contract, impl) {
  const c = contract.constants;
  const mismatches = [];
  const expect = (label, actual, expected) => {
    if (actual !== expected) mismatches.push(`${label}: implementation ${actual}, contract ${expected}`);
  };
  expect('timingTicksPerMillisecond', impl.TICKS_PER_MS, BigInt(c.timingTicksPerMillisecond.value));
  expect('defaultBlockDurationMilliseconds', impl.DEFAULT_BLOCK_DURATION_MS, c.defaultBlockDurationMilliseconds.value);
  expect('defaultBlockDurationTicks', impl.DEFAULT_BLOCK_DURATION_TICKS,
    BigInt(c.defaultBlockDurationMilliseconds.value) * BigInt(c.timingTicksPerMillisecond.value));
  expect('normalLoadBoundaryVariationPercent', impl.NORMAL_LOAD_BOUNDARY_VARIATION_PCT, c.normalLoadBoundaryVariationPercent.value);
  expect('nonAuthoritativeBoundaryVariationPercent', impl.AUTHORITATIVE_BOUNDARY_VARIATION_PCT, c.nonAuthoritativeBoundaryVariationPercent.value);
  expect('admissionCapacitySafetyFactor', impl.ADMISSION_CAPACITY_HEADROOM, c.admissionCapacitySafetyFactor.value);
  expect('defaultRingCapacityBytes', impl.CLI_DEFAULT_CAPACITY_BYTES, c.defaultRingCapacityBytes.value);
  expect('minimumRingCapacityBytes', impl.MIN_CAPACITY_BYTES, c.minimumRingCapacityBytes.value);
  // The horizon is checked through behaviour: equal blocks above the minimum capacity need
  // ceil(safetyFactor * blocksPerHorizon * blockBytes).
  const blockBytes = 100_000;
  const blocks = Array.from({ length: c.blocksPerHorizon.value + 2 }, () => blockBytes);
  expect('blocksPerHorizon', impl.requiredThreeBlockCapacityBytes(blocks),
    Math.ceil(c.admissionCapacitySafetyFactor.value * (c.blocksPerHorizon.value * blockBytes)));
  return mismatches;
}

/** Mismatches between the capture-ring packet implementation and mprr/capture-ring-packet@1. */
export function compareCaptureRingPacket(contract, impl) {
  const entry = contractEntry(contract, 'mprr/capture-ring-packet@1');
  const mismatches = [];
  if (!entry.aliases.includes(impl.CAPTURE_RING_SCHEMA)) mismatches.push(`schema ${impl.CAPTURE_RING_SCHEMA} is not an accepted identifier`);
  if (impl.PACKET_BYTES !== entry.recordBytes) mismatches.push(`recordBytes: implementation ${impl.PACKET_BYTES}, contract ${entry.recordBytes}`);
  if (impl.PACKET_VERSION !== entry.versionField.value) mismatches.push(`packetVersion: implementation ${impl.PACKET_VERSION}, contract ${entry.versionField.value}`);
  const contractOffsets = Object.fromEntries(entry.fields.map((field) => [field.name, field.offset]));
  if (JSON.stringify(impl.OFFSETS) !== JSON.stringify(contractOffsets)) {
    mismatches.push(`field offsets: implementation ${JSON.stringify(impl.OFFSETS)}, contract ${JSON.stringify(contractOffsets)}`);
  }
  if (impl.FLAG_SETTLED !== entry.flags.settled) mismatches.push(`settled flag: implementation ${impl.FLAG_SETTLED}, contract ${entry.flags.settled}`);
  if (JSON.stringify(impl.MILESTONE_IDS) !== JSON.stringify(entry.milestoneIds)) {
    mismatches.push(`milestone IDs: implementation ${JSON.stringify(impl.MILESTONE_IDS)}, contract ${JSON.stringify(entry.milestoneIds)}`);
  }
  return mismatches;
}

/** Mismatches between one launch-capture record and mprr/launch-capture@1 field presence and nullability. */
export function compareLaunchCaptureRecord(contract, inMemoryRecord) {
  const entry = contractEntry(contract, 'mprr/launch-capture@1');
  // Check the record as it is written: JSON drops keys whose value is undefined.
  const record = JSON.parse(JSON.stringify(inMemoryRecord));
  const mismatches = [];
  const check = (object, required, nullable, optional, label) => {
    for (const field of required) {
      if (!(field in object)) mismatches.push(`${label}.${field} is required but absent`);
      else if (object[field] === null && !nullable.includes(field)) mismatches.push(`${label}.${field} is null but not nullable`);
    }
    for (const field of Object.keys(object)) {
      if (!required.includes(field) && !optional.includes(field)) mismatches.push(`${label}.${field} is not in the contract`);
    }
  };
  if (!isContractSchema(contract, entry.id, record.schema)) mismatches.push(`schema ${record.schema} is not an accepted identifier`);
  const dualFrames = Array.isArray(record.dualPacket?.frames) ? record.dualPacket.frames : [];
  if (dualFrames.length === 0) mismatches.push('dualPacket.frames is empty, so shortPacketBytes cannot be checked');
  for (const [index, dualFrame] of dualFrames.entries()) {
    if (dualFrame.shortBytes !== entry.shortPacketBytes) {
      mismatches.push(`dualPacket.frames[${index}].shortBytes: implementation ${dualFrame.shortBytes}, contract ${entry.shortPacketBytes}`);
    }
  }
  const ticksPerMs = BigInt(contract.constants.timingTicksPerMillisecond.value);
  for (const [index, frame] of (Array.isArray(record.frames) ? record.frames : []).entries()) {
    let ticks = null;
    try { ticks = BigInt(frame.timingTicks64); } catch { ticks = null; }
    if (ticks === null || !Number.isInteger(frame.tMs) || ticks !== BigInt(frame.tMs) * ticksPerMs) {
      mismatches.push(`frames[${index}].timingTicks64 ${frame.timingTicks64} is not tMs ${frame.tMs} x ${ticksPerMs} ticks/ms`);
    }
  }
  check(record, entry.requiredRecordFields, entry.nullableRecordFields ?? [], entry.optionalRecordFields ?? [], 'record');
  for (const [index, frame] of record.frames.entries()) {
    check(frame, entry.requiredFrameFields, entry.nullableFrameFields ?? [], entry.optionalFrameFields ?? [], `frames[${index}]`);
  }
  return mismatches;
}

/** Mismatches between the boot-benchmark JSON Schema and mprr/boot-benchmark@1. */
export function compareBootBenchmarkSchema(contract, jsonSchema) {
  const entry = contractEntry(contract, 'mprr/boot-benchmark@1');
  const mismatches = [];
  if (jsonSchema.$schema !== entry.jsonSchemaDialect) mismatches.push(`dialect: implementation ${jsonSchema.$schema}, contract ${entry.jsonSchemaDialect}`);
  const schemaConst = jsonSchema.properties?.schema?.const;
  if (!isContractSchema(contract, entry.id, schemaConst)) mismatches.push(`schema const ${schemaConst} is not an accepted identifier`);
  const implementation = [...(jsonSchema.required ?? [])].sort();
  const published = [...entry.requiredRecordFields].sort();
  if (JSON.stringify(implementation) !== JSON.stringify(published)) {
    mismatches.push(`required fields: implementation ${JSON.stringify(implementation)}, contract ${JSON.stringify(published)}`);
  }
  return mismatches;
}
