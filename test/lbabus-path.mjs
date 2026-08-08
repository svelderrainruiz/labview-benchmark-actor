#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveLbabusExecutable } = require('../out/lbabusPath.js');

assert.equal(resolveLbabusExecutable('linux', {}, () => false), 'lbabus');
assert.equal(resolveLbabusExecutable(
  'win32',
  {},
  (candidate) => candidate === 'C:\\lba-tools\\lbabus\\lbabus.exe',
), 'C:\\lba-tools\\lbabus\\lbabus.exe');
assert.equal(resolveLbabusExecutable(
  'win32',
  { LBA_LBABUS_PATH: 'C:\\custom\\lbabus.exe' },
  (candidate) => candidate === 'C:\\custom\\lbabus.exe',
), 'C:\\custom\\lbabus.exe');
assert.match(resolveLbabusExecutable(
  'win32',
  {
    LBA_LBABUS_PATH: 'C:\\missing\\lbabus.exe',
    LOCALAPPDATA: 'C:\\Users\\reviewer\\AppData\\Local',
  },
  (candidate) => candidate.endsWith('\\lba\\lbabus.exe'),
), /AppData\\Local\\lba\\lbabus\.exe$/);

console.log('lbabus-path: PASS');
