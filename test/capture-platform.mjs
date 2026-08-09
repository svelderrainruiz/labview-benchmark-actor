#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  captureMetadataForPlatform,
  ffmpegCaptureArgsForPlatform,
  labviewCandidatesForPlatform,
  linuxSamplerScript,
} from '../out/capturePlatform.js';

assert.equal(
  labviewCandidatesForPlatform('linux')[0],
  '/usr/local/natinst/LabVIEW-2026-64/labview',
);
assert.deepEqual(
  ffmpegCaptureArgsForPlatform('linux', '/tmp/frame-%05d.png', { DISPLAY: ':0' }),
  ['-y', '-f', 'x11grab', '-framerate', '12', '-draw_mouse', '0', '-i', ':0', '/tmp/frame-%05d.png'],
);
assert.throws(
  () => ffmpegCaptureArgsForPlatform('linux', '/tmp/frame.png', {}),
  /requires DISPLAY/,
);
assert.deepEqual(
  captureMetadataForPlatform('linux'),
  { workload: 'labview-launch', plane: 'LINUX', source: 'ffmpeg-x11grab' },
);
const sampler = linuxSamplerScript('/tmp/resources.jsonl');
assert.match(sampler, /\/proc\/stat/);
assert.match(sampler, /MemAvailable/);
assert.match(sampler, /"cpuPct"/);
assert.match(sampler, /"ramMb"/);

console.log('capture-platform: PASS');
