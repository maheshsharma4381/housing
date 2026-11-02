// Chart of accounts as returned by chart_of_accounts() (020/021): Tally-style groups and ledgers.

export type Nature = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

export interface ChartGroup {
  id: string;
  parent_id: string | null;
  name: string;
  nature: Nature;
  system_key: string | null;
  sort_order: number;
  allows_ledgers: boolean;
}

export interface ChartLedger {
  code: string;
  name: string;
  nature: Nature;
  group_id: string;
  is_system: boolean;
  is_active: boolean;
  balance: number;
  adjustable: boolean;
}

export interface Chart { groups: ChartGroup[]; ledgers: ChartLedger[] }

export interface GroupNode<T> { group: ChartGroup; rows: T[]; children: GroupNode<T>[]; total: number }

export const EMPTY_CHART: Chart = { groups: [], ledgers: [] };

const UNCLASSIFIED: ChartGroup = {
  id: 'unclassified', parent_id: null, name: 'Unclassified', nature: 'asset',
  system_key: null, sort_order: Number.MAX_SAFE_INTEGER, allows_ledgers: false,
};

const bySortThenName = (a: ChartGroup, b: ChartGroup) => a.sort_order - b.sort_order || a.name.localeCompare(b.name);

/**
 * Primary groups in sort_order with nested sub-groups; empty branches pruned; rows whose code is not
 * in the chart go under a synthetic primary group named "Unclassified" (id 'unclassified', last).
 * Every row lands in exactly one node, so the node totals always add up to the sum of all rows.
 */
export function groupTree<T extends { code: string }>(chart: Chart, rows: T[], amount: (row: T) => number): GroupNode<T>[] {
  const groupById = new Map(chart.groups.map(g => [g.id, g]));
  const groupOfCode = new Map(chart.ledgers.map(l => [l.code, l.group_id]));

  const rowsByGroup = new Map<string, T[]>();
  for (const row of rows) {
    const gid = groupOfCode.get(row.code);
    const key = gid && groupById.has(gid) ? gid : UNCLASSIFIED.id;
    rowsByGroup.set(key, [...(rowsByGroup.get(key) ?? []), row]);
  }

  const childrenOf = new Map<string, ChartGroup[]>();
  const roots: ChartGroup[] = [];
  for (const g of chart.groups) {
    if (g.parent_id && groupById.has(g.parent_id)) childrenOf.set(g.parent_id, [...(childrenOf.get(g.parent_id) ?? []), g]);
    else roots.push(g);
  }

  const visited = new Set<string>();
  const build = (g: ChartGroup): GroupNode<T> | null => {
    if (visited.has(g.id)) return null;
    visited.add(g.id);
    const own = rowsByGroup.get(g.id) ?? [];
    const children = (childrenOf.get(g.id) ?? []).slice().sort(bySortThenName)
      .map(build).filter((n): n is GroupNode<T> => n !== null);
    if (own.length === 0 && children.length === 0) return null;
    const total = own.reduce((s, r) => s + amount(r), 0) + children.reduce((s, c) => s + c.total, 0);
    return { group: g, rows: own, children, total };
  };

  const tree = roots.slice().sort(bySortThenName).map(build).filter((n): n is GroupNode<T> => n !== null);

  // Rows in groups that no root reaches (a parent cycle) are still counted
  const lost = [...(rowsByGroup.get(UNCLASSIFIED.id) ?? [])];
  for (const g of chart.groups) if (!visited.has(g.id)) lost.push(...(rowsByGroup.get(g.id) ?? []));
  if (lost.length) tree.push({ group: UNCLASSIFIED, rows: lost, children: [], total: lost.reduce((s, r) => s + amount(r), 0) });
  return tree;
}

/** Sum of `value` over a node's rows and all its sub-groups' rows. */
export function nodeSum<T>(node: GroupNode<T>, value: (row: T) => number): number {
  return node.rows.reduce((s, r) => s + value(r), 0) + node.children.reduce((s, c) => s + nodeSum(c, value), 0);
}

/** A node's rows followed by every sub-group's rows, depth first. */
export function nodeRows<T>(node: GroupNode<T>): T[] {
  return [...node.rows, ...node.children.flatMap(nodeRows)];
}
