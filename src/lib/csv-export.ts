export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | null | undefined;
}

function escapeCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  // Quote when needed; prefix formula-looking text so spreadsheets don't execute it
  const safe = /^[=+\-@]/.test(s) && Number.isNaN(Number(s)) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const lines = [columns.map(c => escapeCell(c.header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map(c => escapeCell(c.value(row))).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

/** Trigger a browser download of CSV text (UTF-8 BOM so Excel shows ₹ correctly). */
export function downloadCsv(filename: string, csv: string) {
  downloadFile(filename, '﻿' + csv, 'text/csv;charset=utf-8');
}

export function downloadFile(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
