// A society_memberships row (with its society joined) as the app keeps it.
import type { Society, SocietyMembership } from '../types/database';

export type MembershipRow = SocietyMembership & { societies: Society | null };

/** Every field the app reads, including the Accountant switch (Phase 2D) */
export function toMembership(m: MembershipRow): SocietyMembership & { society: Society } {
  return {
    id: m.id,
    society_id: m.society_id,
    user_id: m.user_id,
    role: m.role,
    unit_id: m.unit_id,
    is_primary_contact: m.is_primary_contact,
    is_accountant: Boolean(m.is_accountant),
    is_active: m.is_active,
    joined_date: m.joined_date,
    created_at: m.created_at,
    updated_at: m.updated_at,
    society: m.societies as Society,
  };
}
