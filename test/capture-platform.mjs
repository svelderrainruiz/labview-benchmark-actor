#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  captureMetadataForPlatform,
  ffmpegCaptureArgsForPlatform,
  labviewCandidatesForPlatform,
  linuxSamplerScript,
  parseX11DisplaySize,
  x11DisplayForCapture,
} from '../src/capturePlatform.ts';

assert.equal(
  labviewCandidatesForPlatform('linux')[0],
  '/usr/local/natinst/LabVIEW-2026-64/labview',
);
assert.match(labviewCandidatesForPlatform('win32')[0], /Program Files/);
assert.equal(x11DisplayForCapture({ DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' }), ':0');
assert.throws(() => x11DisplayForCapture({ XDG_SESSION_TYPE: 'x11' }), /requires DISPLAY/);
assert.throws(() => x11DisplayForCapture({ DISPLAY: ':0', XDG_SESSION_TYPE: 'wayland' }), /requires an Xorg session/);
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
  () => ffmpegCaptureArgsForPlatform('linux', '/tmp/frame.png', { DISPLAY: ':0' }),
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
assert.match(sampler, /\/1000000/);
assert.doesNotMatch(sampler, /\/1048576/);
assert.doesNotMatch(sampler, /"diskPct":0/);

console.log('capture-platform: PASS');
