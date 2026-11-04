// returnUrl may only ever lead to a page of this app (login, signup and the verification email carry it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeInternalPath } from '../../src/lib/safe-redirect.ts';

test('internal paths pass, with their query', () => {
  assert.equal(safeInternalPath('/society'), '/society');
  assert.equal(safeInternalPath('/join/abc123?x=1'), '/join/abc123?x=1');
});

test('anything that leaves the site is refused', () => {
  for (const bad of ['https://evil.com', '//evil.com', '/\\evil.com', '/\t/evil.com', '/\n/evil.com', '/%09/x\u0000', ' /x', 'evil.com', '', null, undefined]) {
    assert.equal(safeInternalPath(bad as string | null | undefined), null, JSON.stringify(bad));
  }
});
