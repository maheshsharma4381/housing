// Indian financial year (1 April – 31 March) for statements.

export function fyRange(which: 'this' | 'last', today: Date = new Date()): { from: string; to: string } {
  const startYear = (today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1) - (which === 'last' ? 1 : 0);
  return { from: `${startYear}-04-01`, to: `${startYear + 1}-03-31` };
}
