-- ============================================================================
-- SAHVAAS HOUSING SOCIETY MANAGEMENT PLATFORM
-- Migration 009: Professional (CA / Auditor / GST) Portal
--   * Invite → verified-email claim → time-boxed grant with explicit permissions
--   * Revocation stamping, permission catalog enforced by CHECK constraints
--   * audit_remarks: professional observations + committee responses
--   * import_gstr2b(): GSTR-2B upload matched against expense books
--   * gst_reconciliation_detail(): portal vs books line items
-- Safe to re-run.
-- ============================================================================

-- ============================================================================
-- 1. PERMISSION CATALOG (must match keys used by RLS in 002/004/007/008)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.valid_professional_permissions(p JSONB)
RETURNS BOOLEAN AS $$
    SELECT jsonb_typeof(p) = 'array'
       AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(p) AS x(perm)
           WHERE perm NOT IN (
               'view_reports', 'view_ledger', 'view_bills', 'view_payments', 'view_expenses',
               'view_bank_reconciliation', 'view_documents', 'view_units', 'audit_gst', 'view_audit_logs'
           )
       )
$$ LANGUAGE sql IMMUTABLE;

ALTER TABLE society_professional_access DROP CONSTRAINT IF EXISTS chk_spa_permissions;
ALTER TABLE society_professional_access ADD CONSTRAINT chk_spa_permissions CHECK (valid_professional_permissions(permissions));

ALTER TABLE professional_invites ADD COLUMN IF NOT EXISTS access_until TIMESTAMPTZ;
ALTER TABLE professional_invites ALTER COLUMN invitation_token SET DEFAULT gen_random_uuid()::text;
ALTER TABLE professional_invites DROP CONSTRAINT IF EXISTS chk_invite_permissions;
ALTER TABLE professional_invites ADD CONSTRAINT chk_invite_permissions CHECK (valid_professional_permissions(permissions));
ALTER TABLE professional_invites DROP CONSTRAINT IF EXISTS chk_invite_role;
ALTER TABLE professional_invites ADD CONSTRAINT chk_invite_role CHECK (role IN (
    'ca', 'auditor', 'accountant', 'tax_consultant', 'gst_consultant', 'financial_consultant'
));

CREATE UNIQUE INDEX IF NOT EXISTS uq_professional_invite_pending
    ON professional_invites (society_id, lower(invited_email)) WHERE status = 'pending';

-- Stamp inviter; stamp revocation
CREATE OR REPLACE FUNCTION public.professional_invites_stamp()
RETURNS TRIGGER AS $$
BEGIN
    IF auth.uid() IS NOT NULL THEN
        NEW.invited_by := auth.uid();
    END IF;
    NEW.invited_email := lower(trim(NEW.invited_email));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_professional_invites_stamp ON professional_invites;
CREATE TRIGGER trg_professional_invites_stamp
    BEFORE INSERT ON professional_invites
    FOR EACH ROW EXECUTE FUNCTION public.professional_invites_stamp();

CREATE OR REPLACE FUNCTION public.spa_track_revocation()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'revoked' AND OLD.status <> 'revoked' THEN
        NEW.revoked_at := timezone('utc'::text, now());
    ELSIF NEW.status = 'active' THEN
        NEW.revoked_at := NULL;
        NEW.revocation_reason := NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_spa_track_revocation ON society_professional_access;
CREATE TRIGGER trg_spa_track_revocation
    BEFORE UPDATE ON society_professional_access
    FOR EACH ROW EXECUTE FUNCTION public.spa_track_revocation();

-- Professionals may read the profiles of committee members of societies they serve
-- (to see who responded to remarks); committee can read professionals they granted.
CREATE OR REPLACE FUNCTION public.profile_visible_via_professional_link(p_profile_id UUID)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM society_professional_access spa
        WHERE spa.professional_user_id = p_profile_id AND is_society_admin(spa.society_id)
    ) OR EXISTS (
        SELECT 1 FROM society_memberships m
        WHERE m.user_id = p_profile_id AND m.is_active = true
          AND m.role IN ('society_admin', 'secretary', 'chairman', 'treasurer')
          AND has_active_professional_grant(m.society_id)
    )
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

DROP POLICY IF EXISTS profiles_professional_context ON profiles;
CREATE POLICY profiles_professional_context ON profiles
    FOR SELECT USING (profile_visible_via_professional_link(id));

-- ============================================================================
-- 2. CLAIM PROFESSIONAL INVITES (verified email only)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.claim_professional_invites()
RETURNS INT AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_email TEXT;
    v_confirmed TIMESTAMPTZ;
    v_invite professional_invites%ROWTYPE;
    v_count INT := 0;
BEGIN
    IF v_uid IS NULL THEN
        RETURN 0;
    END IF;
    SELECT email, email_confirmed_at INTO v_email, v_confirmed FROM auth.users WHERE id = v_uid;
    IF v_email IS NULL OR v_confirmed IS NULL THEN
        RETURN 0;
    END IF;

    -- Expire stale invites for this email first
    UPDATE professional_invites SET status = 'expired'
    WHERE status = 'pending' AND lower(invited_email) = lower(v_email) AND expires_at <= now();

    FOR v_invite IN
        SELECT pi.* FROM professional_invites pi
        JOIN societies s ON s.id = pi.society_id AND s.is_active = true
        WHERE pi.status = 'pending' AND lower(pi.invited_email) = lower(v_email)
        FOR UPDATE OF pi
    LOOP
        INSERT INTO society_professional_access (
            society_id, professional_user_id, role, status, permissions, granted_by, granted_at, expires_at
        ) VALUES (
            v_invite.society_id, v_uid, v_invite.role, 'active', v_invite.permissions,
            v_invite.invited_by, timezone('utc'::text, now()), v_invite.access_until
        )
        ON CONFLICT (society_id, professional_user_id) DO UPDATE SET
            role = EXCLUDED.role,
            status = 'active',
            permissions = EXCLUDED.permissions,
            granted_by = EXCLUDED.granted_by,
            granted_at = EXCLUDED.granted_at,
            expires_at = EXCLUDED.expires_at;

        UPDATE professional_invites SET status = 'accepted' WHERE id = v_invite.id;

        INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
        VALUES (v_invite.society_id, v_uid, 'professional.access_granted', 'professional_invite', v_invite.id::text,
                jsonb_build_object('role', v_invite.role, 'permissions', v_invite.permissions, 'until', v_invite.access_until));
        v_count := v_count + 1;
    END LOOP;

    RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 3. AUDIT REMARKS
-- ============================================================================
CREATE TABLE IF NOT EXISTS audit_remarks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    author_id UUID NOT NULL REFERENCES profiles(id),
    module VARCHAR(32) NOT NULL DEFAULT 'general' CHECK (module IN ('general', 'billing', 'payments', 'expenses', 'gst', 'ledger', 'documents')),
    reference TEXT,
    remark TEXT NOT NULL CHECK (length(trim(remark)) BETWEEN 3 AND 4000),
    severity VARCHAR(16) NOT NULL DEFAULT 'minor' CHECK (severity IN ('info', 'minor', 'major')),
    status VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'responded', 'closed')),
    response TEXT,
    responded_by UUID REFERENCES profiles(id),
    responded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
CREATE INDEX IF NOT EXISTS idx_audit_remarks_society ON audit_remarks(society_id, status, created_at DESC);

ALTER TABLE audit_remarks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_remarks_select ON audit_remarks;
DROP POLICY IF EXISTS audit_remarks_insert ON audit_remarks;
DROP POLICY IF EXISTS audit_remarks_update ON audit_remarks;
CREATE POLICY audit_remarks_select ON audit_remarks
    FOR SELECT USING (is_platform_admin() OR is_society_admin(society_id) OR author_id = auth.uid());
CREATE POLICY audit_remarks_insert ON audit_remarks
    FOR INSERT WITH CHECK (author_id = auth.uid() AND has_active_professional_grant(society_id));
CREATE POLICY audit_remarks_update ON audit_remarks
    FOR UPDATE USING (is_society_admin(society_id) OR author_id = auth.uid())
    WITH CHECK (is_society_admin(society_id) OR author_id = auth.uid());

CREATE OR REPLACE FUNCTION public.audit_remarks_guard()
RETURNS TRIGGER AS $$
DECLARE
    v_admin BOOLEAN := is_platform_admin() OR is_society_admin(OLD.society_id);
    v_author BOOLEAN := OLD.author_id = auth.uid();
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN NEW;
    END IF;
    IF NEW.society_id IS DISTINCT FROM OLD.society_id OR NEW.author_id IS DISTINCT FROM OLD.author_id THEN
        RAISE EXCEPTION 'Remark ownership cannot change';
    END IF;
    -- Committee responds; only the author edits the observation itself
    IF NOT v_author AND (NEW.remark IS DISTINCT FROM OLD.remark OR NEW.reference IS DISTINCT FROM OLD.reference
                         OR NEW.module IS DISTINCT FROM OLD.module OR NEW.severity IS DISTINCT FROM OLD.severity) THEN
        RAISE EXCEPTION 'Only the professional who wrote the remark can edit it';
    END IF;
    IF NOT v_admin AND (NEW.response IS DISTINCT FROM OLD.response) THEN
        RAISE EXCEPTION 'Only the society committee can respond to a remark';
    END IF;
    IF NOT v_admin AND NEW.status = 'responded' AND OLD.status <> 'responded' THEN
        RAISE EXCEPTION 'Only the society committee can respond to a remark';
    END IF;
    IF NEW.response IS DISTINCT FROM OLD.response AND NEW.response IS NOT NULL THEN
        NEW.responded_by := auth.uid();
        NEW.responded_at := timezone('utc'::text, now());
        IF NEW.status = 'open' THEN
            NEW.status := 'responded';
        END IF;
    ELSE
        NEW.responded_by := OLD.responded_by;
        NEW.responded_at := OLD.responded_at;
    END IF;
    NEW.updated_at := timezone('utc'::text, now());
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_audit_remarks_guard ON audit_remarks;
CREATE TRIGGER trg_audit_remarks_guard
    BEFORE UPDATE ON audit_remarks
    FOR EACH ROW EXECUTE FUNCTION public.audit_remarks_guard();

-- ============================================================================
-- 4. GSTR-2B IMPORT & MATCHING
-- ============================================================================
ALTER TABLE gst_2b_uploads DROP CONSTRAINT IF EXISTS gst_2b_uploads_file_format_check;
ALTER TABLE gst_2b_uploads ADD CONSTRAINT gst_2b_uploads_file_format_check CHECK (file_format IN ('json', 'excel', 'csv'));
ALTER TABLE gst_2b_invoices ADD COLUMN IF NOT EXISTS matched_expense_id UUID REFERENCES expenses(id) ON DELETE SET NULL;
ALTER TABLE gst_reconciliations ADD COLUMN IF NOT EXISTS upload_id UUID REFERENCES gst_2b_uploads(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_gst_2b_invoices_upload ON gst_2b_invoices(upload_id);

-- Invoice numbers are compared ignoring case, separators and leading zeros
CREATE OR REPLACE FUNCTION public.normalize_invoice_number(p TEXT)
RETURNS TEXT AS $$
    SELECT nullif(ltrim(upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g')), '0'), '')
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.import_gstr2b(
    p_society_id UUID,
    p_return_period TEXT,
    p_file_name TEXT,
    p_format TEXT,
    p_invoices JSONB
)
RETURNS JSONB AS $$
DECLARE
    v_upload_id UUID;
    v_period_start DATE;
    v_period_end DATE;
    v_inv JSONB;
    v_idx INT := 0;
    v_gstin TEXT;
    v_taxable NUMERIC;
    v_tax NUMERIC;
    v_exp RECORD;
    v_status TEXT;
    v_exact INT := 0;
    v_partial INT := 0;
    v_missing_books INT := 0;
    v_missing_2b INT := 0;
    v_tot_taxable NUMERIC := 0;
    v_tot_igst NUMERIC := 0;
    v_tot_cgst NUMERIC := 0;
    v_tot_sgst NUMERIC := 0;
    v_itc_at_risk NUMERIC := 0;
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id) OR has_professional_permission(p_society_id, 'audit_gst')) THEN
        RAISE EXCEPTION 'You need GST audit permission for this society';
    END IF;
    IF coalesce(p_return_period, '') !~ '^(0[1-9]|1[0-2])[0-9]{4}$' THEN
        RAISE EXCEPTION 'Return period must be MMYYYY, e.g. 102026';
    END IF;
    IF p_format NOT IN ('json', 'excel', 'csv') THEN
        RAISE EXCEPTION 'Unsupported file format %', p_format;
    END IF;
    IF jsonb_typeof(p_invoices) <> 'array' OR jsonb_array_length(p_invoices) = 0 THEN
        RAISE EXCEPTION 'No invoices found in the file';
    END IF;
    IF jsonb_array_length(p_invoices) > 5000 THEN
        RAISE EXCEPTION 'At most 5000 invoices per upload';
    END IF;

    v_period_start := to_date('01' || p_return_period, 'DDMMYYYY');
    v_period_end := (v_period_start + interval '1 month - 1 day')::date;

    -- Re-uploading a period replaces the previous upload
    DELETE FROM gst_2b_uploads WHERE society_id = p_society_id AND return_period = p_return_period;

    INSERT INTO gst_2b_uploads (society_id, return_period, file_name, file_format, uploaded_by, reconciliation_status)
    VALUES (p_society_id, p_return_period, left(coalesce(nullif(trim(p_file_name), ''), 'gstr2b'), 255), p_format, auth.uid(), 'in_progress')
    RETURNING id INTO v_upload_id;

    FOR v_inv IN SELECT * FROM jsonb_array_elements(p_invoices) LOOP
        v_idx := v_idx + 1;
        v_gstin := upper(trim(coalesce(v_inv ->> 'supplier_gstin', '')));
        IF v_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' THEN
            RAISE EXCEPTION 'Invoice %: supplier GSTIN "%" is invalid', v_idx, v_gstin;
        END IF;
        IF normalize_invoice_number(v_inv ->> 'invoice_number') IS NULL THEN
            RAISE EXCEPTION 'Invoice %: invoice number is missing', v_idx;
        END IF;
        IF coalesce(v_inv ->> 'invoice_date', '') !~ '^\d{4}-\d{2}-\d{2}$' THEN
            RAISE EXCEPTION 'Invoice %: invoice date must be YYYY-MM-DD', v_idx;
        END IF;

        v_taxable := round(coalesce((v_inv ->> 'taxable_value')::NUMERIC, 0), 2);
        v_tax := round(coalesce((v_inv ->> 'igst')::NUMERIC, 0) + coalesce((v_inv ->> 'cgst')::NUMERIC, 0) + coalesce((v_inv ->> 'sgst')::NUMERIC, 0), 2);

        SELECT e.id, e.subtotal, e.gst_amount INTO v_exp
        FROM expenses e JOIN vendors v ON v.id = e.vendor_id
        WHERE e.society_id = p_society_id
          AND e.status NOT IN ('rejected', 'voided')
          AND upper(v.gstin) = v_gstin
          AND normalize_invoice_number(e.invoice_number) = normalize_invoice_number(v_inv ->> 'invoice_number')
        ORDER BY e.created_at
        LIMIT 1;

        IF v_exp.id IS NULL THEN
            v_status := 'missing_in_books';
            v_missing_books := v_missing_books + 1;
        ELSIF abs(v_exp.subtotal - v_taxable) <= 1 AND abs(v_exp.gst_amount - v_tax) <= 1 THEN
            v_status := 'exact_match';
            v_exact := v_exact + 1;
        ELSE
            v_status := 'partial_match';
            v_partial := v_partial + 1;
        END IF;

        INSERT INTO gst_2b_invoices (
            upload_id, society_id, supplier_gstin, supplier_trade_name, invoice_number, invoice_type, invoice_date,
            invoice_value, taxable_value, igst, cgst, sgst, itc_availability, reconciliation_match_status, matched_expense_id
        ) VALUES (
            v_upload_id, p_society_id, v_gstin,
            left(coalesce(nullif(trim(v_inv ->> 'supplier_name'), ''), v_gstin), 191),
            left(trim(v_inv ->> 'invoice_number'), 96),
            left(coalesce(nullif(v_inv ->> 'invoice_type', ''), 'B2B'), 32),
            (v_inv ->> 'invoice_date')::DATE,
            round(coalesce((v_inv ->> 'invoice_value')::NUMERIC, v_taxable + v_tax), 2),
            v_taxable,
            round(coalesce((v_inv ->> 'igst')::NUMERIC, 0), 2),
            round(coalesce((v_inv ->> 'cgst')::NUMERIC, 0), 2),
            round(coalesce((v_inv ->> 'sgst')::NUMERIC, 0), 2),
            CASE WHEN upper(coalesce(v_inv ->> 'itc_available', 'Y')) IN ('N', 'NO') THEN 'N' ELSE 'Y' END,
            v_status, v_exp.id
        );

        v_tot_taxable := v_tot_taxable + v_taxable;
        v_tot_igst := v_tot_igst + round(coalesce((v_inv ->> 'igst')::NUMERIC, 0), 2);
        v_tot_cgst := v_tot_cgst + round(coalesce((v_inv ->> 'cgst')::NUMERIC, 0), 2);
        v_tot_sgst := v_tot_sgst + round(coalesce((v_inv ->> 'sgst')::NUMERIC, 0), 2);
    END LOOP;

    -- Books invoices for the month that the supplier has not reported in 2B (ITC at risk)
    SELECT count(*), coalesce(sum(e.gst_amount), 0) INTO v_missing_2b, v_itc_at_risk
    FROM expenses e JOIN vendors v ON v.id = e.vendor_id
    WHERE e.society_id = p_society_id
      AND e.status NOT IN ('rejected', 'voided')
      AND v.gstin IS NOT NULL AND e.gst_amount > 0
      AND e.invoice_date BETWEEN v_period_start AND v_period_end
      AND NOT EXISTS (SELECT 1 FROM gst_2b_invoices g WHERE g.upload_id = v_upload_id AND g.matched_expense_id = e.id);

    UPDATE gst_2b_uploads
    SET total_invoices_found = v_idx, total_taxable_value = v_tot_taxable,
        total_igst = v_tot_igst, total_cgst = v_tot_cgst, total_sgst = v_tot_sgst,
        reconciliation_status = 'completed'
    WHERE id = v_upload_id;

    INSERT INTO gst_reconciliations (society_id, upload_id, period, total_books_invoices, total_portal_invoices, matched_count, mismatched_count)
    VALUES (p_society_id, v_upload_id, p_return_period, v_exact + v_partial + v_missing_2b, v_idx, v_exact, v_partial + v_missing_books + v_missing_2b);

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'gst.gstr2b_imported', 'gst_2b_upload', v_upload_id::text,
            jsonb_build_object('period', p_return_period, 'invoices', v_idx, 'exact', v_exact));

    RETURN jsonb_build_object(
        'upload_id', v_upload_id,
        'invoices', v_idx,
        'exact_match', v_exact,
        'partial_match', v_partial,
        'missing_in_books', v_missing_books,
        'missing_in_2b', v_missing_2b,
        'total_taxable', v_tot_taxable,
        'total_tax', v_tot_igst + v_tot_cgst + v_tot_sgst,
        'itc_at_risk', v_itc_at_risk
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.gst_reconciliation_detail(p_upload_id UUID)
RETURNS TABLE (
    side TEXT, status TEXT, supplier_gstin TEXT, supplier_name TEXT, invoice_number TEXT, invoice_date DATE,
    portal_taxable NUMERIC, portal_tax NUMERIC, books_taxable NUMERIC, books_tax NUMERIC, expense_number TEXT
) AS $$
DECLARE
    v_upload gst_2b_uploads%ROWTYPE;
    v_start DATE;
BEGIN
    SELECT * INTO v_upload FROM gst_2b_uploads WHERE id = p_upload_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Upload not found';
    END IF;
    IF NOT (is_platform_admin() OR is_society_admin(v_upload.society_id) OR has_professional_permission(v_upload.society_id, 'audit_gst')) THEN
        RAISE EXCEPTION 'You need GST audit permission for this society';
    END IF;
    v_start := to_date('01' || v_upload.return_period, 'DDMMYYYY');

    RETURN QUERY
    SELECT 'portal'::TEXT, g.reconciliation_match_status::TEXT, g.supplier_gstin::TEXT, g.supplier_trade_name::TEXT,
           g.invoice_number::TEXT, g.invoice_date, g.taxable_value, (g.igst + g.cgst + g.sgst),
           e.subtotal, e.gst_amount, e.expense_number::TEXT
    FROM gst_2b_invoices g LEFT JOIN expenses e ON e.id = g.matched_expense_id
    WHERE g.upload_id = p_upload_id
    UNION ALL
    SELECT 'books'::TEXT, 'missing_in_2b'::TEXT, upper(v.gstin)::TEXT, v.name::TEXT,
           e.invoice_number::TEXT, e.invoice_date, NULL::NUMERIC, NULL::NUMERIC,
           e.subtotal, e.gst_amount, e.expense_number::TEXT
    FROM expenses e JOIN vendors v ON v.id = e.vendor_id
    WHERE e.society_id = v_upload.society_id
      AND e.status NOT IN ('rejected', 'voided')
      AND v.gstin IS NOT NULL AND e.gst_amount > 0
      AND e.invoice_date BETWEEN v_start AND (v_start + interval '1 month - 1 day')::date
      AND NOT EXISTS (SELECT 1 FROM gst_2b_invoices g2 WHERE g2.upload_id = p_upload_id AND g2.matched_expense_id = e.id)
    ORDER BY 2, 3, 5;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 5. PRIVILEGES
-- ============================================================================
REVOKE ALL ON FUNCTION public.claim_professional_invites() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.import_gstr2b(UUID, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.gst_reconciliation_detail(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_professional_invites() TO authenticated;
GRANT EXECUTE ON FUNCTION public.import_gstr2b(UUID, TEXT, TEXT, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gst_reconciliation_detail(UUID) TO authenticated;
