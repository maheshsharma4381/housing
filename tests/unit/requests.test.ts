// Flat requests and NOC letters (Phase 11A): status words, the pending clock, missing documents, files, the printable letter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REQUEST_STATUS_LABELS, pendingDays, pendingTone, PENDING_NOTE, missingRequired, requestFileError, nocLetterHtml,
} from '../../src/lib/requests.ts';

test('status words', () => {
  assert.deepEqual(REQUEST_STATUS_LABELS, {
    submitted: 'Waiting for the committee', changes_asked: 'Changes needed', approved: 'Approved',
    rejected: 'Declined', withdrawn: 'Withdrawn', done: 'Done',
  });
});

test('the pending clock turns amber at 25 days for NOC and transfer requests', () => {
  const now = new Date('2026-12-20T10:00:00Z');
  assert.equal(pendingDays('2026-11-25T09:00:00Z', now), 25);
  assert.equal(pendingDays('2026-12-20T09:00:00Z', now), 0);
  assert.equal(pendingTone('noc', 25), 'amber');
  assert.equal(pendingTone('noc', 24), 'normal');
  assert.equal(pendingTone('transfer', 30), 'amber');
  assert.equal(pendingTone('tenancy', 40), 'normal');
  assert.equal(PENDING_NOTE, 'A NOC must be decided within one month of the application.');
});

test('missing required documents are named', () => {
  const checklist = [{ key: 'a', label: 'Agreement', required: true }, { key: 'b', label: 'Photo', required: false }, { key: 'c', label: 'ID', required: true }];
  assert.deepEqual(missingRequired(checklist, [{ item_key: 'a' }]), ['ID']);
  assert.deepEqual(missingRequired(checklist, [{ item_key: 'a' }, { item_key: 'c' }]), []);
});

test('request files: PDFs and images up to 10 MB', () => {
  assert.equal(requestFileError({ size: 1000, type: 'application/pdf' }), null);
  assert.equal(requestFileError({ size: 11 * 1024 * 1024, type: 'image/jpeg' }), 'File is larger than 10 MB.');
  assert.equal(requestFileError({ size: 1000, type: 'image/gif' }), 'Use a PDF, JPG, PNG or WEBP file.');
});

test('the printable NOC letter', () => {
  const html = nocLetterHtml(
    { number: 'NOC/2026-27/001', issued_on: '2026-11-24', title: 'No Objection Certificate — Sale of flat',
      body: 'To whomsoever it may concern\n\nThis is <script>alert(1)</script> fine.', signatory: 'secretary' },
    { name: 'Green Park CHS', registration_number: 'PNA/HSG/123/2001', address: '12 MG Road, Pune, Maharashtra 411001' });
  assert.ok(html.includes('NOC/2026-27/001'));
  assert.ok(html.includes('24 Nov 2026'));
  assert.ok(html.includes('For Green Park CHS'));
  assert.ok(html.includes('Secretary'));
  assert.ok(html.includes('Registration No. PNA/HSG/123/2001'));
  assert.ok(!html.includes('<script>alert'), 'the body is escaped');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('<p>To whomsoever it may concern</p>'), 'paragraphs from blank lines');
  assert.ok(html.trim().endsWith('</html>'));
  assert.ok(html.includes('window.print()'));
});
