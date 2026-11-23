// Polls (Phase 10): one vote per flat, counted from owners. The form checks the rules create_poll checks.
import { toCsv } from './csv-export.ts';

export const POLL_FOOTNOTE = "This poll shows members' views. Decisions are taken in the general body meeting.";

export interface PollDraft { question: string; details: string; options: string[]; closesAt: Date }

/** The options as the database keeps them: trimmed, blanks dropped */
export const cleanOptions = (options: string[]) => options.map(o => o.trim()).filter(Boolean);

export function pollDraftError(d: PollDraft, now: Date): string | null {
  const question = d.question.trim();
  if (question.length < 5 || question.length > 200) return 'Write the question (5 to 200 characters)';
  if (d.details.trim().length > 1000) return 'Details can be up to 1000 characters';
  const options = cleanOptions(d.options);
  if (options.length < 2 || options.length > 6 || options.some(o => o.length > 80)) return 'Give 2 to 6 options, each up to 80 characters';
  const t = d.closesAt.getTime();
  if (Number.isNaN(t) || t < now.getTime() + 3600_000 || t > now.getTime() + 60 * 86400_000) {
    return 'Close the poll between 1 hour and 60 days from now';
  }
  return null;
}

/** The result for the AGM file: the question, votes per option, then each flat and whether it voted (never how) */
export function pollResultCsv(poll: { question: string; options: string[] }, counts: number[], flats: { label: string; voted: boolean }[]): string {
  const rows: [string, string | number][] = [
    ['Option', 'Votes'],
    ...poll.options.map((o, i): [string, number] => [o, counts[i] ?? 0]),
    ['Flat', 'Voted'],
    ...flats.map((f): [string, string] => [f.label, f.voted ? 'Yes' : 'No']),
  ];
  return toCsv(rows, [
    { header: 'Question', value: r => r[0] },
    { header: poll.question, value: r => r[1] },
  ]);
}
