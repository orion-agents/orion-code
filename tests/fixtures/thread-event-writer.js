'use strict';

require('ts-node/register/transpile-only');

const { randomUUID } = require('crypto');
const {
  canonicalRuntimeJson,
  digestRuntimeValue,
} = require('../../src/runtime/protocol/canonical');
const { ThreadEventStore } = require('../../src/runtime/thread-event-store');

const [rootDir, threadId, writerId, countText] = process.argv.slice(2);
const count = Number(countText);
const store = new ThreadEventStore(rootDir, threadId, { lockWaitMs: 30_000 });

for (let index = 0; index < count; index += 1) {
  const receiptId = randomUUID();
  const turnId = randomUUID();
  const stepId = randomUUID();
  const receiptContent = {
    version: 1,
    requestId: receiptId,
    threadId,
    turnId,
    stepId,
    writerId,
    index,
  };
  const receipt = {
    ...receiptContent,
    digest: digestRuntimeValue(receiptContent),
  };
  store.appendDurable({
    turnId,
    stepId,
    payload: {
      type: 'capability.receipt',
      data: {
        receiptId,
        digest: receipt.digest,
        receipt: canonicalRuntimeJson(receipt),
      },
    },
  });
}
