// Sale and transfer (Phase 11D)
import { formatINR } from './inr.ts';
import { normalizeMobile } from './mobile.ts';
import { PHONE_LOGIN_ON } from './phone-login.ts';

export const TRANSFER_WARNING = 'Charge only what your bye-laws allow. The transfer premium is capped at ₹25,000.';
export const PREMIUM_CAP = 25000;

export interface TransferDraft { buyer_name: string; buyer_mobile: string; buyer_email: string; deed_date: string; deed_number: string }

const squash = (s: string) => s.trim().replace(/\s+/g, ' ');

/** The checks create_transfer_request makes, with the same messages (`today` as YYYY-MM-DD).
 *  Until mobile login is on, the buyer can only join with an email, so the form asks for one. */
export function transferDraftError(d: TransferDraft, today: string, phoneLogin: boolean = PHONE_LOGIN_ON): string | null {
  const name = squash(d.buyer_name);
  if (name.length < 2 || name.length > 120) return "Enter the buyer's name";
  const mobile = d.buyer_mobile.trim();
  if (!mobile) return "Enter the buyer's mobile number";
  if (!normalizeMobile(mobile)) return `Mobile ${mobile} is not a valid number`;
  const email = d.buyer_email.trim();
  if (email && (email.indexOf('@') < 1 || email.length > 160)) return 'Enter a valid email for the buyer';
  if (!email && !phoneLogin) return "Enter the buyer's email: they join Sahvaas with it";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.deed_date)) return 'Enter the sale deed date';
  if (d.deed_date > today) return 'The sale deed date cannot be in the future';
  if (squash(d.deed_number).length > 40) return 'The registration number can be up to 40 characters';
  return null;
}

/** bill_transfer_fees / set_transfer_settings limits */
export function transferFeeError(fee: number, premium: number): string | null {
  if (!Number.isFinite(fee) || !Number.isFinite(premium) || fee < 0 || fee > 100000 || premium < 0) return 'Amounts must be between ₹0 and ₹1,00,000';
  if (premium > PREMIUM_CAP) return 'The transfer premium can be at most ₹25,000';
  return null;
}

/** The first step still missing before the committee can approve (the order decide_request checks) */
export function transferBlocker(s: { feesBilled: boolean; certificateReceived: boolean; dues: number }): string | null {
  if (!s.feesBilled) return 'Bill the transfer fees first (₹0 if none)';
  if (!s.certificateReceived) return 'Tick that the original share certificate is received';
  if (s.dues > 0) return `Clear dues of ${formatINR(s.dues)} before the transfer`;
  return null;
}
