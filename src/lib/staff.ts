// Staff register (Phase 10)
export type StaffKind = 'maid' | 'driver' | 'cook' | 'cleaner' | 'nanny' | 'other';

export const STAFF_KINDS: { id: StaffKind; label: string }[] = [
  { id: 'maid', label: 'Maid' },
  { id: 'driver', label: 'Driver' },
  { id: 'cook', label: 'Cook' },
  { id: 'cleaner', label: 'Cleaner' },
  { id: 'nanny', label: 'Nanny' },
  { id: 'other', label: 'Other' },
];

export const staffKindLabel = (k: string) => STAFF_KINDS.find(s => s.id === k)?.label ?? 'Other';

export interface StaffFlat { unit_id: string; wing: string | null; unit_number: string }
/** A row of staff_list(): residents get mobile only for their own staff, never notes or the ID proof */
export interface StaffRow {
  id: string; name: string; kind: StaffKind; photo_path: string | null; police_verified: boolean;
  police_verified_on: string | null; active: boolean; mine: boolean; mobile: string | null;
  notes: string | null; id_proof: string | null; flats: StaffFlat[];
}
