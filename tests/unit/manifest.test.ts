// The installable app (spec 2 non-goals: no native app — the PWA is the mobile app).
// Android needs 192 and 512 PNG icons (and a maskable one); the iPhone uses apple-touch-icon.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import manifest from '../../src/app/manifest.ts';

test('the manifest makes the app installable on Android', () => {
  const m = manifest();
  assert.equal(m.display, 'standalone');
  // the installed app opens where the person works, not on the marketing page (login sends a signed-in user on)
  assert.equal(m.start_url, '/login');
  assert.equal(m.orientation, undefined, 'wide ledgers can be read sideways');
  assert.equal(m.id, '/');
  assert.equal(m.scope, '/');
  const png = (m.icons ?? []).filter((i) => i.type === 'image/png');
  assert.ok(png.some((i) => i.sizes === '192x192' && i.src === '/icons/icon-192.png'));
  assert.ok(png.some((i) => i.sizes === '512x512' && i.src === '/icons/icon-512.png'));
  assert.ok(png.some((i) => i.purpose === 'maskable' && i.sizes === '512x512'));
  for (const i of png) assert.ok(existsSync(`public${i.src}`), `${i.src} exists`);
});

test('the iPhone Home Screen icon is a PNG', () => {
  assert.ok(existsSync('public/icons/apple-touch-icon.png'));
});
