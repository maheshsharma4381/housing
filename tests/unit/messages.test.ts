import { test } from 'node:test';
import assert from 'node:assert/strict';
import { billEmail, billText, inviteText, receiptEmail, whatsappLink } from '../../src/lib/messages.ts';

test('bill text has amount in Indian format and a readable due date', () => {
  const t = billText({ societyName: 'Palm Heights', ownerName: 'Vikram Joshi', flat: 'A-101', billNumber: 'B2610-0001', amount: 3172.2, dueDate: '2026-10-10', appUrl: 'https://app.sahvaas.in' });
  assert.equal(t, 'Hello Vikram,\nPalm Heights: maintenance bill B2610-0001 for flat A-101 is ₹3,172.20, due 10 Oct 2026.\nPay by UPI and submit the UTR at https://app.sahvaas.in/resident');
});

test('invite text mentions the exact email to sign up with', () => {
  const t = inviteText({ societyName: 'Palm Heights', role: 'Resident (Owner)', email: 'r@x.in', appUrl: 'https://app.sahvaas.in', flat: 'B-2' });
  assert.match(t, /^Hello,\nPalm Heights has invited you to Sahvaas as Resident \(Owner\) for flat B-2\./);
  assert.match(t, /Sign up with r@x\.in at https:\/\/app\.sahvaas\.in\/signup/);
});

test('an invite by mobile says to log in with that mobile', () => {
  const t = inviteText({ societyName: 'Palm Heights', role: 'Committee Member', mobile: '919811122222', appUrl: 'https://app.sahvaas.in', phoneLogin: true });
  assert.match(t, /Log in with your mobile \+91 98111 22222 at https:\/\/app\.sahvaas\.in\/login and accept the invitation\./);
});

test('while mobile login is off, an invite with a mobile and an email says to sign up with the email', () => {
  const t = inviteText({ societyName: 'Palm Heights', role: 'Treasurer', mobile: '919811122222', email: 't@x.in', appUrl: 'https://app.sahvaas.in', phoneLogin: false });
  assert.match(t, /Sign up with t@x\.in at https:\/\/app\.sahvaas\.in\/signup/);
  assert.doesNotMatch(t, /mobile/i);
});

test('while mobile login is off, an invite with only a mobile asks for an email instead of a mobile login', () => {
  const t = inviteText({ societyName: 'Palm Heights', role: 'Resident (Owner)', mobile: '919811122222', appUrl: 'https://app.sahvaas.in', flat: 'A-1', phoneLogin: false });
  assert.doesNotMatch(t, /Log in with your mobile/);
  assert.match(t, /Sign up at https:\/\/app\.sahvaas\.in\/signup/);
  assert.match(t, /send the email you used to your society office/);
});

test('mobile login is off unless NEXT_PUBLIC_PHONE_LOGIN is 1, so the default invite says to sign up with the email', () => {
  const t = inviteText({ societyName: 'Palm Heights', role: 'Treasurer', mobile: '919811122222', email: 't@x.in', appUrl: 'https://app.sahvaas.in' });
  assert.match(t, /Sign up with t@x\.in/);
});

test('whatsapp links normalise Indian numbers and fall back to the contact picker', () => {
  assert.equal(whatsappLink('hi', '98200 00000'), 'https://wa.me/919820000000?text=hi');
  assert.equal(whatsappLink('hi', '+91-98200-00000'), 'https://wa.me/919820000000?text=hi');
  assert.equal(whatsappLink('hi', '098200 00000'), 'https://wa.me/919820000000?text=hi');
  assert.equal(whatsappLink('a b&c', null), 'https://wa.me/?text=a%20b%26c');
  assert.equal(whatsappLink('x', '123'), 'https://wa.me/?text=x');
});

test('emails escape HTML from user-controlled names and link URLs', () => {
  const e = billEmail({ societyName: '<script>alert(1)</script> CHS', flat: '1', billNumber: 'B1', amount: 100, dueDate: '2026-10-10', appUrl: 'https://app.sahvaas.in' });
  assert.ok(!e.html.includes('<script>'));
  assert.ok(e.html.includes('&lt;script&gt;'));
  assert.ok(e.html.includes('<a href="https://app.sahvaas.in/resident">'));
  assert.match(e.subject, /bill B1 — ₹100 due 10 Oct 2026/);

  const r = receiptEmail({ societyName: 'S', flat: '1', receiptNumber: 'RCPT-2026-00001', amount: 500, utr: '123456789012', receiptUrl: 'https://app.sahvaas.in/receipt/abc' });
  assert.match(r.text, /Receipt RCPT-2026-00001: https:\/\/app\.sahvaas\.in\/receipt\/abc/);
});
