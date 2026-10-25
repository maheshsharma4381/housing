import type { UnitImportRow, UnitOccupancyStatus } from '../types/database';

export const UNIT_CSV_TEMPLATE =
  'building,wing,floor,unit_number,unit_type,carpet_area_sqft,occupancy_status\n' +
  'Tower A,A,1,A-101,2BHK,650,owner_occupied\n' +
  'Tower A,A,1,A-102,3BHK,920,tenant_occupied\n' +
  'Tower A,B,2,B-201,1BHK,450,vacant\n';

const HEADER_ALIASES: Record<string, keyof UnitImportRow> = {
  building: 'building',
  tower: 'building',
  block: 'building',
  wing: 'wing',
  floor: 'floor',
  floor_number: 'floor',
  unit_number: 'unit_number',
  unit: 'unit_number',
  unit_no: 'unit_number',
  flat: 'unit_number',
  flat_no: 'unit_number',
  flat_number: 'unit_number',
  unit_type: 'unit_type',
  type: 'unit_type',
  bhk: 'unit_type',
  carpet_area_sqft: 'carpet_area_sqft',
  carpet_area: 'carpet_area_sqft',
  area: 'carpet_area_sqft',
  area_sqft: 'carpet_area_sqft',
  occupancy_status: 'occupancy_status',
  occupancy: 'occupancy_status',
  status: 'occupancy_status',
};

const OCCUPANCY_ALIASES: Record<string, UnitOccupancyStatus> = {
  owner_occupied: 'owner_occupied',
  owner: 'owner_occupied',
  tenant_occupied: 'tenant_occupied',
  tenant: 'tenant_occupied',
  rented: 'tenant_occupied',
  vacant: 'vacant',
  empty: 'vacant',
  under_renovation: 'under_renovation',
  renovation: 'under_renovation',
};

/** Split CSV text into rows of cells, honouring double quotes and CRLF line endings. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

const normalizeKey = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export interface UnitCsvResult {
  rows: UnitImportRow[];
  errors: string[];
}

/** Parse a flats CSV (with header row) into rows for the bulk_upsert_units RPC. */
export function parseUnitCsv(text: string): UnitCsvResult {
  const table = parseCsv(text.replace(/^﻿/, ''));
  if (table.length === 0) {
    return { rows: [], errors: ['The file is empty.'] };
  }

  const columns = table[0].map(h => HEADER_ALIASES[normalizeKey(h)]);
  if (!columns.includes('unit_number')) {
    return { rows: [], errors: ['Header must include a unit_number (or flat / flat_no) column.'] };
  }

  const rows: UnitImportRow[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  table.slice(1).forEach((cells, i) => {
    const line = i + 2; // 1-based, header is line 1
    const raw: Partial<Record<keyof UnitImportRow, string>> = {};
    columns.forEach((key, c) => {
      if (key) raw[key] = (cells[c] ?? '').trim();
    });

    if (!raw.unit_number) {
      errors.push(`Line ${line}: unit_number is empty.`);
      return;
    }

    const row: UnitImportRow = { unit_number: raw.unit_number };
    if (raw.building) row.building = raw.building;
    if (raw.wing) row.wing = raw.wing;
    if (raw.unit_type) row.unit_type = raw.unit_type;

    if (raw.floor) {
      const floor = Number(raw.floor);
      if (!Number.isInteger(floor)) {
        errors.push(`Line ${line}: floor "${raw.floor}" is not a whole number.`);
        return;
      }
      row.floor = floor;
    }

    if (raw.carpet_area_sqft) {
      const area = Number(raw.carpet_area_sqft.replace(/,/g, ''));
      if (!Number.isFinite(area) || area < 0) {
        errors.push(`Line ${line}: carpet area "${raw.carpet_area_sqft}" is not a valid number.`);
        return;
      }
      row.carpet_area_sqft = area;
    }

    if (raw.occupancy_status) {
      const occ = OCCUPANCY_ALIASES[normalizeKey(raw.occupancy_status)];
      if (!occ) {
        errors.push(`Line ${line}: occupancy "${raw.occupancy_status}" must be owner, tenant, vacant or renovation.`);
        return;
      }
      row.occupancy_status = occ;
    }

    const key = `${(row.building ?? 'Main').toLowerCase()}|${(row.wing ?? 'A').toLowerCase()}|${row.unit_number.toLowerCase()}`;
    if (seen.has(key)) {
      errors.push(`Line ${line}: duplicate flat ${row.unit_number} in the same wing.`);
      return;
    }
    seen.add(key);
    rows.push(row);
  });

  return { rows, errors };
}
