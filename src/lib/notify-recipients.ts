// Who should not get a bill or receipt email (Phase 2F): while a flat's new owner has not joined yet,
// its bills and receipts still carry the previous owner, who has sold the flat.

/** Drops items for flats whose owner change is waiting for the new owner to join */
export function withoutWaitingFlats<T extends { unit_id: string }>(items: T[], waitingUnitIds: string[]): T[] {
  if (waitingUnitIds.length === 0) return items;
  const waiting = new Set(waitingUnitIds);
  return items.filter(item => !waiting.has(item.unit_id));
}
