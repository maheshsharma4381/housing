// Setup step 2: the pincode fills city and state (api.postalpincode.in reply shape).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePincodeReply } from '../../src/lib/pincode.ts';

test('a found pincode gives the district as city and the state', () => {
  const reply = [{ Status: 'Success', PostOffice: [{ Name: 'Shivajinagar', District: 'Pune', State: 'Maharashtra' }] }];
  assert.deepEqual(parsePincodeReply(reply), { city: 'Pune', state: 'Maharashtra' });
});

test('an unknown pincode or an odd reply gives nothing', () => {
  assert.equal(parsePincodeReply([{ Status: 'Error', PostOffice: null }]), null);
  assert.equal(parsePincodeReply(null), null);
  assert.equal(parsePincodeReply({ nope: true }), null);
});
