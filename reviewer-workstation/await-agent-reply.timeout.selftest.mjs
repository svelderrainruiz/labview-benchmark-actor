#!/usr/bin/env node

import assert from 'node:assert/strict';
import { installListenerDeadline, listenerDeadlineMs } from './await-agent-reply.mjs';

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

{
  let kills = 0;
  let timedOut = false;
  const timer = installListenerDeadline({
    child: { kill: () => { kills += 1; } },
    timeoutSec: 0.01,
    isMatched: () => false,
    onTimeout: () => { timedOut = true; },
  });
  await wait(30);
  clearTimeout(timer);
  assert.equal(kills, 1, 'the wrapper deadline terminates a blocked listener');
  assert.equal(timedOut, true, 'the caller can record a deadline failure');
}

{
  let kills = 0;
  const timer = installListenerDeadline({
    child: { kill: () => { kills += 1; } },
    timeoutSec: 0.01,
    isMatched: () => true,
  });
  await wait(30);
  clearTimeout(timer);
  assert.equal(kills, 0, 'a correlated reply prevents the deadline from killing the listener');
}

assert.throws(() => listenerDeadlineMs(0), /positive/);
console.log('await-agent-reply timeout selftest: 3/3 passed');