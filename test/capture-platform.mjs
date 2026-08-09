#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  captureMetadataForPlatform,
  ffmpegCaptureArgsForPlatform,
  labviewCandidatesForPlatform,
  linuxSamplerScript,
  parseX11DisplaySize,
} from '../src/capturePlatform.ts';

assert.equal(
  labviewCandidatesForPlatform('linux')[0],
  '/usr/local/natinst/LabVIEW-2026-64/labview',
);
assert.deepEqual(
  ffmpegCaptureArgsForPlatform('linux', '/tmp/frame-%05d.png', { DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' }, '1920x1080'),
  ['-y', '-f', 'x11grab', '-framerate', '12', '-video_size', '1920x1080', '-draw_mouse', '0', '-i', ':0', '/tmp/frame-%05d.png'],
);
assert.throws(
  () => ffmpegCaptureArgsForPlatform('linux', '/tmp/frame.png', { XDG_SESSION_TYPE: 'x11' }),
  /requires DISPLAY/,
);
assert.throws(
  () => ffmpegCaptureArgsForPlatform('linux', '/tmp/frame.png', { DISPLAY: ':0', XDG_SESSION_TYPE: 'wayland' }),
  /requires an Xorg session/,
);
assert.throws(
  () => ffmpegCaptureArgsForPlatform('linux', '/tmp/frame.png', { DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' }),
  /desktop dimensions/,
);
assert.equal(parseX11DisplaySize('screen #0:\n  dimensions:    1920x1080 pixels (508x285 millimeters)'), '1920x1080');
assert.throws(() => parseX11DisplaySize('dimensions unavailable'), /did not report/);
assert.deepEqual(
  captureMetadataForPlatform('linux'),
  { workload: 'labview-launch', plane: 'LINUX', source: 'ffmpeg-x11grab' },
);
const sampler = linuxSamplerScript('/tmp/resources.jsonl');
assert.match(sampler, /\/proc\/stat/);
assert.match(sampler, /MemAvailable/);
assert.match(sampler, /"cpuPct"/);
assert.match(sampler, /"ramMb"/);
assert.match(sampler, /\/proc\/diskstats/);
assert.match(sampler, /writeMBs/);
assert.doesNotMatch(sampler, /"diskPct":0/);

console.log('capture-platform: PASS');
