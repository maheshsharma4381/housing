// Which sender the hook uses, and the exact requests it makes to WhatsApp and MSG91.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { otpConfig, whatsappRequest, msg91Request, isIndianMobile, maskMobile } from '../../src/lib/otp/senders.ts';

const wa = { WHATSAPP_TOKEN: 'tok', WHATSAPP_PHONE_NUMBER_ID: '555', WHATSAPP_TEMPLATE_NAME: 'login_code' };

test('the provider follows the env, and codes are never printed in production', () => {
  assert.equal(otpConfig({ ...wa }).provider, 'whatsapp');
  assert.equal(otpConfig({ NODE_ENV: 'development' }).provider, 'console');
  assert.equal(otpConfig({ NODE_ENV: 'production' }).provider, 'none');
  assert.equal(otpConfig({ NODE_ENV: 'production', OTP_PROVIDER: 'console' }).provider, 'none');
  assert.equal(otpConfig({ OTP_PROVIDER: 'whatsapp', NODE_ENV: 'production' }).provider, 'none', 'whatsapp without its keys');
  assert.equal(otpConfig({ ...wa }).whatsapp?.lang, 'en');
  assert.equal(otpConfig({ ...wa, MSG91_AUTH_KEY: 'k', MSG91_TEMPLATE_ID: 't' }).msg91?.templateId, 't');
  assert.equal(otpConfig({ ...wa }).msg91, null);
});

test('the WhatsApp authentication template carries the code twice', () => {
  const r = whatsappRequest({ token: 'tok', phoneNumberId: '555', template: 'login_code', lang: 'en' }, '919876543210', '123456');
  assert.equal(r.url, 'https://graph.facebook.com/v21.0/555/messages');
  assert.equal((r.init.headers as Record<string, string>).Authorization, 'Bearer tok');
  const b = JSON.parse(r.init.body as string);
  assert.equal(b.to, '919876543210');
  assert.equal(b.template.name, 'login_code');
  assert.deepEqual(b.template.components[0], { type: 'body', parameters: [{ type: 'text', text: '123456' }] });
  assert.deepEqual(b.template.components[1], { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '123456' }] });
});

test('MSG91 sends the same code by SMS', () => {
  const r = msg91Request({ authKey: 'k', templateId: 't1' }, '919876543210', '123456');
  assert.equal(r.url, 'https://control.msg91.com/api/v5/otp?template_id=t1&mobile=919876543210&otp=123456');
  assert.equal((r.init.headers as Record<string, string>).authkey, 'k');
});

test('Indian numbers and masking', () => {
  assert.equal(isIndianMobile('919876543210'), true);
  assert.equal(isIndianMobile('447700900123'), false);
  assert.equal(maskMobile('919876543210'), '91******3210');
});
