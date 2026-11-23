// Polls (Phase 10): the form checks the same rules as create_poll, and the result downloads for the AGM file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pollDraftError, pollResultCsv, POLL_FOOTNOTE } from '../../src/lib/polls.ts';

const now = new Date('2026-11-24T10:00:00Z');
const ok = { question: 'Repair the lift?', details: '', options: ['Yes', 'No'], closesAt: new Date('2026-11-26T10:00:00Z') };

test('the poll form checks what the database checks', () => {
  assert.equal(pollDraftError(ok, now), null);
  assert.equal(pollDraftError({ ...ok, question: 'Lift' }, now), 'Write the question (5 to 200 characters)');
  assert.equal(pollDraftError({ ...ok, question: 'x'.repeat(201) }, now), 'Write the question (5 to 200 characters)');
  assert.equal(pollDraftError({ ...ok, details: 'x'.repeat(1001) }, now), 'Details can be up to 1000 characters');
  assert.equal(pollDraftError({ ...ok, options: ['Yes', '  '] }, now), 'Give 2 to 6 options, each up to 80 characters');
  assert.equal(pollDraftError({ ...ok, options: ['1', '2', '3', '4', '5', '6', '7'] }, now), 'Give 2 to 6 options, each up to 80 characters');
  assert.equal(pollDraftError({ ...ok, options: ['Yes', 'n'.repeat(81)] }, now), 'Give 2 to 6 options, each up to 80 characters');
  assert.equal(pollDraftError({ ...ok, options: ['Yes', '', 'No'] }, now), null, 'blank options are dropped');
  assert.equal(pollDraftError({ ...ok, closesAt: new Date('2026-11-24T10:30:00Z') }, now), 'Close the poll between 1 hour and 60 days from now');
  assert.equal(pollDraftError({ ...ok, closesAt: new Date('2027-01-24T10:00:00Z') }, now), 'Close the poll between 1 hour and 60 days from now');
  assert.equal(pollDraftError({ ...ok, closesAt: new Date('invalid') }, now), 'Close the poll between 1 hour and 60 days from now');
});

test('the result downloads with counts and the flats that voted', () => {
  const csv = pollResultCsv({ question: 'Repair the lift, for "Rs 4 lakh"?', options: ['Yes', 'No'] }, [3, 1],
    [{ label: 'A-101', voted: true }, { label: 'A-102', voted: false }]);
  assert.equal(csv, [
    'Question,"Repair the lift, for ""Rs 4 lakh""?"',
    'Option,Votes',
    'Yes,3',
    'No,1',
    'Flat,Voted',
    'A-101,Yes',
    'A-102,No',
  ].join('\r\n') + '\r\n');
});

test('the footnote', () => {
  assert.equal(POLL_FOOTNOTE, "This poll shows members' views. Decisions are taken in the general body meeting.");
});
