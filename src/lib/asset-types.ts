// Asset types (Phase 2E): the society's fixed-asset ledgers, each with its own depreciation rate.
import { ASSET_TYPES } from './tds.ts';

/** A row of the asset_ledgers RPC */
export interface AssetTypeRow { code: string; name: string; dep_rate: number | string }
export interface AssetTypeOption { code: string; label: string; rate: number }

/** The society's asset types; the six standard ones until the list loads (or when it cannot be read) */
export function assetTypeOptions(rows: AssetTypeRow[] | null | undefined): AssetTypeOption[] {
  if (!rows || rows.length === 0) return ASSET_TYPES.map(a => ({ code: a.code, label: a.label, rate: a.rate }));
  return rows.map(r => ({ code: r.code, label: r.name, rate: Number(r.dep_rate) }));
}
