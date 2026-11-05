// Android fires beforeinstallprompt once per page load — often on /login, before any dashboard mounts.
// The store catches it at app start so the in-app "Install app" button can use it later.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInstallStore } from '../../src/lib/install-prompt.ts';

test('the prompt is kept for later, listeners hear about it, and installing clears it', () => {
  const target = new EventTarget();
  const store = createInstallStore(target);
  let calls = 0;
  const off = store.subscribe(() => { calls += 1; });
  assert.equal(store.get().prompt, null);
  const ev = new Event('beforeinstallprompt', { cancelable: true });
  target.dispatchEvent(ev);
  assert.ok(store.get().prompt, 'kept');
  assert.equal(ev.defaultPrevented, true, 'the browser mini-bar is held back for our own button');
  assert.equal(calls, 1);
  target.dispatchEvent(new Event('appinstalled'));
  assert.deepEqual([store.get().prompt, store.get().installed], [null, true]);
  off();
  target.dispatchEvent(new Event('beforeinstallprompt', { cancelable: true }));
  assert.equal(calls, 2, 'no calls after unsubscribing');
});
