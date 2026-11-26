// The offline banner: the server render must not print it. Node 21+ has a global `navigator` without `onLine`,
// so a page built on the server once said "You are offline" in its HTML, and the login page kept showing it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { useOnlineStatus } from '../../src/hooks/useOnlineStatus.ts';

function Probe() {
  return createElement('span', null, useOnlineStatus() ? 'online' : 'offline');
}

test('the server render counts as online, even where navigator.onLine is missing', () => {
  assert.equal(typeof navigator, 'object', 'Node gives a global navigator');
  assert.equal(renderToString(createElement(Probe)), '<span>online</span>');
});
