import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushSyncAction } from '../../src/lib/push-sync.ts';

test('a phone that already allowed notifications re-saves its subscription quietly', () => {
  assert.equal(pushSyncAction(true, 'granted'), 'resubscribe');
  assert.equal(pushSyncAction(true, 'default'), 'offer');
  assert.equal(pushSyncAction(true, 'denied'), 'blocked');
  assert.equal(pushSyncAction(false, 'default'), 'unsupported');
});
