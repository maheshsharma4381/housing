import { NextResponse, type NextRequest } from 'next/server';
import { createServerSupabaseClient } from '../../../lib/supabase/server';
import { sendEmails, type OutgoingEmail } from '../../../lib/email-sender';
import { billEmail, inviteEmail, receiptEmail } from '../../../lib/messages';
import { roleLabel } from '../../../lib/professional-permissions';

/**
 * POST /api/notify  { type, id }
 * Sends transactional email for an event the signed-in committee member just performed.
 * All reads go through the caller's own Supabase session, so RLS decides what can be sent.
 */

type NotifyType = 'member_invite' | 'professional_invite' | 'bills_issued' | 'receipt';
const MAX_RECIPIENTS = 500;

const MEMBER_ROLE_LABELS: Record<string, string> = {
  resident_owner: 'Resident (Owner)',
  resident_tenant: 'Resident (Tenant)',
  committee_member: 'Committee Member',
  treasurer: 'Treasurer',
  secretary: 'Secretary',
  chairman: 'Chairman',
  society_admin: 'Society Admin',
};

type One<T> = T | T[] | null;
const one = <T,>(v: One<T>): T | null => (Array.isArray(v) ? v[0] ?? null : v);

export async function POST(request: NextRequest) {
  let body: { type?: NotifyType; id?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const { type, id } = body;
  if (!type || !id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: 'type and a valid id are required' }, { status: 400 });
  }

  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || request.nextUrl.origin).replace(/\/$/, '');
  const emails: OutgoingEmail[] = [];
  let societyId: string | null = null;

  if (type === 'member_invite') {
    const { data } = await supabase
      .from('member_invites')
      .select('email, full_name, role, society_id, societies:society_id (name), units:unit_id (unit_number)')
      .eq('id', id).eq('status', 'pending').maybeSingle();
    if (data) {
      societyId = data.society_id;
      emails.push({
        to: data.email,
        ...inviteEmail({
          societyName: one(data.societies as One<{ name: string }>)?.name ?? 'Your society',
          inviteeName: data.full_name,
          role: MEMBER_ROLE_LABELS[data.role] ?? data.role,
          email: data.email,
          flat: one(data.units as One<{ unit_number: string }>)?.unit_number,
          appUrl,
        }),
      });
    }
  } else if (type === 'professional_invite') {
    const { data } = await supabase
      .from('professional_invites')
      .select('invited_email, role, society_id, societies:society_id (name)')
      .eq('id', id).eq('status', 'pending').maybeSingle();
    if (data) {
      societyId = data.society_id;
      emails.push({
        to: data.invited_email,
        ...inviteEmail({
          societyName: one(data.societies as One<{ name: string }>)?.name ?? 'A housing society',
          role: roleLabel(data.role),
          email: data.invited_email,
          appUrl,
        }),
      });
    }
  } else if (type === 'bills_issued') {
    const { data } = await supabase
      .from('bills')
      .select('bill_number, total_amount, due_date, society_id, profiles:user_id (full_name, email), units:unit_id (unit_number), societies:society_id (name)')
      .eq('cycle_id', id)
      .limit(MAX_RECIPIENTS);
    for (const b of data ?? []) {
      societyId = b.society_id;
      const owner = one(b.profiles as One<{ full_name: string; email: string }>);
      if (!owner?.email) continue;
      emails.push({
        to: owner.email,
        ...billEmail({
          societyName: one(b.societies as One<{ name: string }>)?.name ?? 'Your society',
          ownerName: owner.full_name,
          flat: one(b.units as One<{ unit_number: string }>)?.unit_number ?? '',
          billNumber: b.bill_number,
          amount: Number(b.total_amount),
          dueDate: b.due_date,
          appUrl,
        }),
      });
    }
  } else if (type === 'receipt') {
    const { data } = await supabase
      .from('payments')
      .select('id, amount, receipt_number, transaction_reference_utr, status, society_id, profiles:user_id (full_name, email), units:unit_id (unit_number), societies:society_id (name)')
      .eq('id', id).eq('status', 'verified').maybeSingle();
    const owner = data ? one(data.profiles as One<{ full_name: string; email: string }>) : null;
    if (data && owner?.email && data.receipt_number) {
      societyId = data.society_id;
      emails.push({
        to: owner.email,
        ...receiptEmail({
          societyName: one(data.societies as One<{ name: string }>)?.name ?? 'Your society',
          ownerName: owner.full_name,
          flat: one(data.units as One<{ unit_number: string }>)?.unit_number ?? '',
          receiptNumber: data.receipt_number,
          amount: Number(data.amount),
          utr: data.transaction_reference_utr,
          receiptUrl: `${appUrl}/receipt/${data.id}`,
        }),
      });
    }
  } else {
    return NextResponse.json({ error: 'Unknown notification type' }, { status: 400 });
  }

  if (!societyId || emails.length === 0) {
    return NextResponse.json({ configured: true, sent: 0, failed: 0, note: 'Nothing to send (no recipients or no access)' });
  }

  // Only the society committee may trigger outbound messages to members
  const { data: isAdmin } = await supabase.rpc('is_society_admin', { target_society_id: societyId });
  if (!isAdmin) return NextResponse.json({ error: 'Only the society committee can send notifications' }, { status: 403 });

  // Without an email provider nothing is sent, so don't use up the daily quota
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
    return NextResponse.json({ configured: false, sent: 0, failed: 0 });
  }

  // Dedupe (same event once per 24 h) + per-society daily cap, recorded in notification_log
  const { data: reservation, error: reserveErr } = await supabase.rpc('reserve_notification', {
    p_society_id: societyId,
    p_type: type,
    p_ref_id: id,
    p_recipients: emails.length,
  });
  const reserved = reservation as { allowed: boolean; reason?: string } | null;
  if (reserveErr || !reserved?.allowed) {
    return NextResponse.json({ configured: true, sent: 0, failed: 0, skipped: reserved?.reason ?? reserveErr?.message ?? 'Not allowed' });
  }

  const result = await sendEmails(emails);
  return NextResponse.json(result, { status: result.failed > 0 && result.sent === 0 && result.configured ? 502 : 200 });
}
