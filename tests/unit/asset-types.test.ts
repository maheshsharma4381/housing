import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetTypeOptions } from '../../src/lib/asset-types.ts';

test("the society's own asset types are offered with their rates", () => {
  const options = assetTypeOptions([
    { code: '1500', name: 'Plant & Machinery', dep_rate: '18.00' },
    { code: '1C001', name: 'Solar Panels', dep_rate: 25 },
  ]);
  assert.deepEqual(options, [
    { code: '1500', label: 'Plant & Machinery', rate: 18 },
    { code: '1C001', label: 'Solar Panels', rate: 25 },
  ]);
});

test('until the list loads, the six standard asset types are offered', () => {
  const options = assetTypeOptions([]);
  assert.equal(options.length, 6);
  assert.deepEqual(options[0], { code: '1500', label: 'Plant & machinery (pump, generator, lift)', rate: 15 });
  assert.equal(assetTypeOptions(null).length, 6);
});
