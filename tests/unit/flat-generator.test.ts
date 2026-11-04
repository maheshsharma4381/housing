// Setup step 3: wings × floors × flats per floor, with the preview the secretary checks before creating.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateFlats } from '../../src/lib/flat-generator.ts';

test('two wings, seven floors, four flats a floor', () => {
  const r = generateFlats({ wings: ['A', 'B'], floors: 7, perFloor: 4 });
  assert.equal(r.error, null);
  assert.equal(r.rows.length, 56);
  assert.equal(r.preview, '56 flats will be created: A-101 … A-704, B-101 … B-704');
  assert.deepEqual(r.rows[0], { wing: 'A', floor: 1, unit_number: 'A-101' });
});

test('more than nine flats a floor, and one unnamed wing', () => {
  assert.equal(generateFlats({ wings: ['A'], floors: 2, perFloor: 12 }).rows.at(-1)?.unit_number, 'A-212');
  const one = generateFlats({ wings: [''], floors: 3, perFloor: 2 });
  assert.deepEqual(one.rows.map((r) => r.unit_number), ['101', '102', '201', '202', '301', '302']);
  assert.equal(one.preview, '6 flats will be created: 101 … 302');
});

test('area by flat position applies to every floor', () => {
  const r = generateFlats({ wings: ['A'], floors: 2, perFloor: 2, areaByPosition: { 1: 650, 2: 900 } });
  assert.deepEqual(r.rows.map((x) => [x.unit_number, x.carpet_area_sqft]), [['A-101', 650], ['A-102', 900], ['A-201', 650], ['A-202', 900]]);
});

test('impossible plans are explained, not created', () => {
  assert.match(generateFlats({ wings: ['A B'], floors: 2, perFloor: 2 }).error ?? '', /without spaces/);
  assert.match(generateFlats({ wings: ['A', 'a'], floors: 2, perFloor: 2 }).error ?? '', /twice/);
  assert.match(generateFlats({ wings: ['A'], floors: 0, perFloor: 2 }).error ?? '', /floors/);
  assert.match(generateFlats({ wings: ['A'], floors: 2, perFloor: 100 }).error ?? '', /flats per floor/);
  assert.equal(generateFlats({ wings: ['A'], floors: 0, perFloor: 2 }).rows.length, 0);
});
