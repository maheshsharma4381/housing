// Setup step 3 (spec 9.1): flats from wings, floors and flats per floor.
// Numbering is floor + two-digit position (A-101 … A-712); flats can be edited one by one later.

export interface FlatPlan {
  wings: string[];
  floors: number;
  perFloor: number;
  /** sq.ft by position on the floor (1 = every "…01" flat), for "Per sq.ft" maintenance */
  areaByPosition?: Record<number, number>;
}
export interface FlatRow { wing: string; floor: number; unit_number: string; carpet_area_sqft?: number }

const MAX_FLOORS = 60;
const MAX_PER_FLOOR = 99;

export function generateFlats(plan: FlatPlan): { rows: FlatRow[]; preview: string; error: string | null } {
  const wings = plan.wings.map((w) => w.trim());
  const fail = (error: string) => ({ rows: [], preview: '', error });
  if (wings.length === 0) return fail('Add at least one wing');
  if (wings.some((w) => /\s/.test(w) || w.length > 8)) return fail('Wing names must be short, without spaces (A, B, Tower1)');
  if (new Set(wings.map((w) => w.toUpperCase())).size !== wings.length) return fail('A wing is listed twice');
  if (!Number.isInteger(plan.floors) || plan.floors < 1 || plan.floors > MAX_FLOORS) return fail(`Number of floors must be 1 to ${MAX_FLOORS}`);
  if (!Number.isInteger(plan.perFloor) || plan.perFloor < 1 || plan.perFloor > MAX_PER_FLOOR) return fail(`Number of flats per floor must be 1 to ${MAX_PER_FLOOR}`);

  const rows: FlatRow[] = [];
  const ranges: string[] = [];
  for (const wing of wings) {
    const start = rows.length;
    for (let floor = 1; floor <= plan.floors; floor += 1) {
      for (let pos = 1; pos <= plan.perFloor; pos += 1) {
        const num = `${floor}${String(pos).padStart(2, '0')}`;
        const row: FlatRow = { wing: wing || 'A', floor, unit_number: wing ? `${wing}-${num}` : num };
        const area = plan.areaByPosition?.[pos];
        if (area && area > 0) row.carpet_area_sqft = area;
        rows.push(row);
      }
    }
    const first = rows[start].unit_number;
    const last = rows[rows.length - 1].unit_number;
    ranges.push(first === last ? first : `${first} … ${last}`);
  }
  return { rows, preview: `${rows.length} flats will be created: ${ranges.join(', ')}`, error: null };
}
