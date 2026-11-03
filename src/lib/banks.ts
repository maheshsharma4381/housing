// Banks are the active ledgers in the Bank Accounts group (022). The CA sets a default bank for
// receipts and one for payments; the secretary only sees a bank choice when there is more than one.
import type { SupabaseClient } from '@supabase/supabase-js';

export interface BankLedger {
  id: string;
  code: string;
  name: string;
  is_default_receipt: boolean;
  is_default_payment: boolean;
}

export async function fetchBankLedgers(client: SupabaseClient, societyId: string): Promise<BankLedger[]> {
  const { data, error } = await client.rpc('bank_ledgers', { p_society_id: societyId });
  if (error) throw new Error(error.message);
  return (data as BankLedger[] | null) ?? [];
}

/** The default bank for money coming in ('receipt') or going out ('payment'), else the first bank. */
export function defaultBankId(banks: BankLedger[], kind: 'receipt' | 'payment'): string | null {
  const flag = kind === 'receipt' ? 'is_default_receipt' : 'is_default_payment';
  return banks.find(b => b[flag])?.id ?? banks[0]?.id ?? null;
}
