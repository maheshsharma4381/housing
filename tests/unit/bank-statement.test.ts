import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBankStatement, parseStatementAmount, parseStatementDate } from '../../src/lib/bank-statement.ts';

test('amounts: Indian grouping, Dr / Cr suffixes, brackets and blanks', () => {
  assert.equal(parseStatementAmount('1,00,000.50'), 100000.5);
  assert.equal(parseStatementAmount('5,000.00 Dr'), -5000);
  assert.equal(parseStatementAmount('53,852.30 Cr'), 53852.3);
  assert.equal(parseStatementAmount('(500.00)'), -500);
  assert.equal(parseStatementAmount(' - '), null);
  assert.equal(parseStatementAmount(''), null);
  assert.equal(parseStatementAmount('abc'), null);
});

test('dates with and without a time', () => {
  assert.equal(parseStatementDate('14/10/26'), '2026-10-14');
  assert.equal(parseStatementDate('14-Oct-2026'), '2026-10-14');
  assert.equal(parseStatementDate('14 Oct 2026 10:22:01'), '2026-10-14');
  assert.equal(parseStatementDate('2026-10-14 10:22:01'), '2026-10-14');
  assert.equal(parseStatementDate('Opening Balance'), null);
});

test('HDFC: account details above the headings, newest first, footer lines skipped', () => {
  const csv = [
    'HDFC BANK Ltd.,,,,,,',
    'Account No :,50100012345678,,,,,',
    '',
    'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
    '16/10/26,NEFT DR-UTRVEND12345-RAMESH PLUMBING,UTRVEND12345,16/10/26,"5,000.00",,"51,670.00"',
    '14/10/26,UPI-412345678901-FLAT 101,0000412345678901,14/10/26,,"4,170.00","56,670.00"',
    'STATEMENT SUMMARY :-,,,,,,',
  ].join('\n');
  const s = parseBankStatement(csv);
  assert.equal(s.format, 'hdfc');
  assert.equal(s.rows.length, 2);
  assert.equal(s.skipped, 1);
  assert.deepEqual(s.rows[0], {
    date: '2026-10-14', value_date: '2026-10-14', description: 'UPI-412345678901-FLAT 101', reference: '0000412345678901',
    debit: 0, credit: 4170, balance: 56670,
  }, 'reversed to oldest first');
  assert.equal(s.rows[1].debit, 5000);
});

test('SBI and ICICI headings', () => {
  const sbi = parseBankStatement('Txn Date,Value Date,Description,Ref No./Cheque No.,Debit,Credit,Balance\n'
    + '14 Oct 2026,14 Oct 2026,BY TRANSFER-UPI/CR/412345678901,TRANSFER FROM 1234,,4170.00,54170.00\n');
  assert.deepEqual([sbi.format, sbi.rows[0].credit, sbi.rows[0].balance], ['sbi', 4170, 54170]);

  const icici = parseBankStatement('S No.,Value Date,Transaction Date,Cheque Number,Transaction Remarks,Withdrawal Amount (INR ),Deposit Amount (INR ),Balance (INR )\n'
    + '1,17/10/2026,17/10/2026,-,ITNS 281 TDS,800.00,0.00,"50,870.00"\n');
  assert.deepEqual([icici.format, icici.rows[0].date, icici.rows[0].debit, icici.rows[0].reference], ['icici', '2026-10-17', 800, null]);
});

test('single Amount column with Dr / Cr, and tab-separated files', () => {
  const kotak = parseBankStatement('Sl. No.\tTransaction Date\tValue Date\tDescription\tChq / Ref No.\tAmount\tDr / Cr\tBalance\tDr / Cr\n'
    + '1\t18-10-2026\t18-10-2026\tIMPS 556677889900\t\t3,000.00\tCR\t53,870.00\tCR\n'
    + '2\t19-10-2026\t19-10-2026\tSMS CHARGES\t\t17.70\tDR\t53,852.30\tCR\n');
  assert.equal(kotak.format, 'kotak');
  assert.deepEqual(kotak.rows.map((r) => [r.debit, r.credit]), [[0, 3000], [17.7, 0]]);

  const generic = parseBankStatement('Date,Details,Amount,Balance\n2026-10-19,Bank interest,120.00,100\n2026-10-20,Cheque 0042,-450.00,-350\n');
  assert.deepEqual(generic.rows.map((r) => [r.debit, r.credit]), [[0, 120], [450, 0]], 'sign decides when there is no Dr / Cr column');
});

test('a file without recognisable headings is refused with a hint', () => {
  assert.throws(() => parseBankStatement('a,b,c\n1,2,3\n'), /Download the statement as CSV/);
});
