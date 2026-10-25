-- ============================================================================
-- SAHVAAS HOUSING SOCIETY MANAGEMENT PLATFORM
-- Migration 008: Daily Operations
--   * Notices      - audience + expiry enforced by RLS, publisher stamped
--   * Complaints   - auto ticket numbers, resolved_at, comment thread
--   * Documents    - private Storage bucket "society-files" + policies
--   * Expenses     - auto numbers, net = subtotal + GST - TDS, maker-checker
--                    approval (decide_expense), mark_expense_paid -> ledger
-- Safe to re-run.
-- ============================================================================

-- Helper: does the current user hold one of these roles in the society?
CREATE OR REPLACE FUNCTION public.has_society_role(target_society_id UUID, roles TEXT[])
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM society_memberships
        WHERE society_id = target_society_id AND user_id = auth.uid()
          AND is_active = true AND role = ANY (roles)
    )
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- Serialized per-society sequence: next number after the highest "<PREFIX>NNNN" in p_table.p_column
CREATE OR REPLACE FUNCTION public.next_society_number(p_society_id UUID, p_table TEXT, p_column TEXT, p_prefix TEXT)
RETURNS INT AS $$
DECLARE
    v_n INT;
BEGIN
    IF p_prefix !~ '^[A-Z]+-$' THEN
        RAISE EXCEPTION 'Invalid number prefix %', p_prefix;
    END IF;
    PERFORM 1 FROM societies WHERE id = p_society_id FOR UPDATE;
    EXECUTE format(
        'SELECT coalesce(max(substring(%I FROM %L)::int), 0) + 1 FROM %I WHERE society_id = $1',
        p_column, '^' || p_prefix || '([0-9]+)$', p_table
    ) INTO v_n USING p_society_id;
    RETURN v_n;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.next_society_number(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 1. NOTICES
-- ============================================================================
DROP POLICY IF EXISTS notices_select ON notices;
CREATE POLICY notices_select ON notices
    FOR SELECT USING (
        is_platform_admin()
        OR is_society_admin(society_id)
        OR (
            has_society_membership(society_id)
            AND (expires_at IS NULL OR expires_at > now())
            AND (
                target_audience = 'all'
                OR (target_audience = 'owners_only'    AND has_society_role(society_id, ARRAY['resident_owner', 'committee_member']))
                OR (target_audience = 'tenants_only'   AND has_society_role(society_id, ARRAY['resident_tenant', 'committee_member']))
                OR (target_audience = 'committee_only' AND has_society_role(society_id, ARRAY['committee_member']))
            )
        )
    );

CREATE OR REPLACE FUNCTION public.notices_stamp_publisher()
RETURNS TRIGGER AS $$
BEGIN
    IF auth.uid() IS NOT NULL THEN
        NEW.published_by := auth.uid();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_notices_stamp_publisher ON notices;
CREATE TRIGGER trg_notices_stamp_publisher
    BEFORE INSERT ON notices
    FOR EACH ROW EXECUTE FUNCTION public.notices_stamp_publisher();

-- ============================================================================
-- 2. COMPLAINTS
-- ============================================================================
CREATE OR REPLACE FUNCTION public.complaints_assign_ticket_number()
RETURNS TRIGGER AS $$
BEGIN
    NEW.ticket_number := 'TKT-' || lpad(next_society_number(NEW.society_id, 'complaints', 'ticket_number', 'TKT-')::text, 4, '0');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_complaints_assign_ticket_number ON complaints;
CREATE TRIGGER trg_complaints_assign_ticket_number
    BEFORE INSERT ON complaints
    FOR EACH ROW EXECUTE FUNCTION public.complaints_assign_ticket_number();

-- Runs after the resident guard (trigger names fire alphabetically)
CREATE OR REPLACE FUNCTION public.complaints_track_resolution()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status IN ('resolved', 'closed') AND OLD.status NOT IN ('resolved', 'closed') THEN
        NEW.resolved_at := coalesce(NEW.resolved_at, timezone('utc'::text, now()));
    ELSIF NEW.status IN ('open', 'in_progress') THEN
        NEW.resolved_at := NULL;
    END IF;
    NEW.updated_at := timezone('utc'::text, now());
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_complaints_track_resolution ON complaints;
CREATE TRIGGER trg_complaints_track_resolution
    BEFORE UPDATE ON complaints
    FOR EACH ROW EXECUTE FUNCTION public.complaints_track_resolution();

CREATE TABLE IF NOT EXISTS complaint_updates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    complaint_id UUID NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
    author_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    message TEXT NOT NULL CHECK (length(trim(message)) BETWEEN 1 AND 2000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
CREATE INDEX IF NOT EXISTS idx_complaint_updates_complaint ON complaint_updates(complaint_id, created_at);

ALTER TABLE complaint_updates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS complaint_updates_select ON complaint_updates;
DROP POLICY IF EXISTS complaint_updates_insert ON complaint_updates;
CREATE POLICY complaint_updates_select ON complaint_updates
    FOR SELECT USING (
        is_platform_admin()
        OR is_society_admin(society_id)
        OR EXISTS (SELECT 1 FROM complaints c WHERE c.id = complaint_updates.complaint_id AND c.user_id = auth.uid())
    );
CREATE POLICY complaint_updates_insert ON complaint_updates
    FOR INSERT WITH CHECK (
        author_id = auth.uid()
        AND EXISTS (
            SELECT 1 FROM complaints c
            WHERE c.id = complaint_updates.complaint_id
              AND c.society_id = complaint_updates.society_id
              AND (c.user_id = auth.uid() OR is_society_admin(c.society_id))
        )
    );

-- ============================================================================
-- 3. DOCUMENTS & STORAGE
--    Files live at  society-files/<society_id>/<folder>/<uuid>-<name>
--    Read access mirrors the documents / expenses table RLS of the caller.
-- ============================================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('society-files', 'society-files', false, 10485760)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.documents_stamp_uploader()
RETURNS TRIGGER AS $$
BEGIN
    IF auth.uid() IS NOT NULL THEN
        NEW.uploaded_by := auth.uid();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_documents_stamp_uploader ON documents;
CREATE TRIGGER trg_documents_stamp_uploader
    BEFORE INSERT ON documents
    FOR EACH ROW EXECUTE FUNCTION public.documents_stamp_uploader();

-- File path must sit inside the document's own society folder
ALTER TABLE documents DROP CONSTRAINT IF EXISTS chk_documents_path_in_society;
ALTER TABLE documents ADD CONSTRAINT chk_documents_path_in_society
    CHECK (file_url LIKE society_id::text || '/%');

DROP POLICY IF EXISTS "society files: read" ON storage.objects;
DROP POLICY IF EXISTS "society files: committee upload" ON storage.objects;
DROP POLICY IF EXISTS "society files: committee delete" ON storage.objects;

CREATE POLICY "society files: read" ON storage.objects
    FOR SELECT TO authenticated USING (
        bucket_id = 'society-files'
        AND (
            EXISTS (SELECT 1 FROM public.documents d WHERE d.file_url = storage.objects.name)
            OR EXISTS (SELECT 1 FROM public.expenses e WHERE e.document_url = storage.objects.name)
            OR public.is_society_admin(((storage.foldername(name))[1])::uuid)
        )
    );

CREATE POLICY "society files: committee upload" ON storage.objects
    FOR INSERT TO authenticated WITH CHECK (
        bucket_id = 'society-files'
        AND (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
        AND (public.is_platform_admin() OR public.is_society_admin(((storage.foldername(name))[1])::uuid))
    );

CREATE POLICY "society files: committee delete" ON storage.objects
    FOR DELETE TO authenticated USING (
        bucket_id = 'society-files'
        AND (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
        AND (public.is_platform_admin() OR public.is_society_admin(((storage.foldername(name))[1])::uuid))
    );

-- ============================================================================
-- 4. EXPENSES: numbering, amounts, maker-checker approval
-- ============================================================================
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES profiles(id);

CREATE TABLE IF NOT EXISTS expense_approvals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    expense_id UUID NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
    approver_id UUID NOT NULL REFERENCES profiles(id),
    decision VARCHAR(16) NOT NULL CHECK (decision IN ('approved', 'rejected')),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT uq_expense_approver UNIQUE (expense_id, approver_id)
);

ALTER TABLE expense_approvals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS expense_approvals_select ON expense_approvals;
CREATE POLICY expense_approvals_select ON expense_approvals
    FOR SELECT USING (
        is_platform_admin() OR is_society_admin(society_id)
        OR has_professional_permission(society_id, 'view_expenses')
    );

-- Direct client edits cannot approve, pay or alter approved amounts;
-- decide_expense / mark_expense_paid set sahvaas.expense_workflow = 'on'.
CREATE OR REPLACE FUNCTION public.expenses_guard_and_compute()
RETURNS TRIGGER AS $$
DECLARE
    v_workflow BOOLEAN := coalesce(current_setting('sahvaas.expense_workflow', true), '') = 'on';
BEGIN
    NEW.net_payable := round(NEW.subtotal + NEW.gst_amount - NEW.tds_amount, 2);
    IF NEW.subtotal < 0 OR NEW.gst_amount < 0 OR NEW.tds_amount < 0 OR NEW.net_payable < 0 THEN
        RAISE EXCEPTION 'Expense amounts cannot be negative';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF coalesce(NEW.expense_number, '') = '' THEN
            NEW.expense_number := 'EXP-' || lpad(next_society_number(NEW.society_id, 'expenses', 'expense_number', 'EXP-')::text, 4, '0');
        END IF;
        IF auth.uid() IS NOT NULL THEN
            NEW.created_by := auth.uid();
            IF NOT v_workflow THEN
                IF NEW.status NOT IN ('draft', 'pending_approval') THEN
                    NEW.status := 'pending_approval';
                END IF;
                NEW.payment_status := 'unpaid';
                NEW.approved_by := NULL;
                NEW.approved_at := NULL;
                NEW.paid_date := NULL;
            END IF;
        END IF;
        RETURN NEW;
    END IF;

    -- UPDATE
    IF v_workflow OR auth.uid() IS NULL THEN
        RETURN NEW;
    END IF;
    IF OLD.status = 'paid' THEN
        RAISE EXCEPTION 'Paid expenses are locked';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status NOT IN ('draft', 'pending_approval', 'voided') THEN
        RAISE EXCEPTION 'Use the approval workflow to approve, reject or pay an expense';
    END IF;
    IF NEW.payment_status IS DISTINCT FROM OLD.payment_status
       OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
       OR NEW.paid_date IS DISTINCT FROM OLD.paid_date
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.expense_number IS DISTINCT FROM OLD.expense_number THEN
        RAISE EXCEPTION 'Use the approval workflow to approve, reject or pay an expense';
    END IF;
    IF OLD.status = 'approved' AND (
        NEW.subtotal <> OLD.subtotal OR NEW.gst_amount <> OLD.gst_amount OR NEW.tds_amount <> OLD.tds_amount
        OR NEW.vendor_id IS DISTINCT FROM OLD.vendor_id
    ) THEN
        RAISE EXCEPTION 'Approved expenses cannot be edited; void it and create a new one';
    END IF;
    -- Sending a changed expense back for approval clears earlier approvals
    IF NEW.status = 'pending_approval' AND OLD.status <> 'pending_approval' THEN
        DELETE FROM expense_approvals WHERE expense_id = OLD.id;
    END IF;
    NEW.updated_at := timezone('utc'::text, now());
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_expenses_guard_and_compute ON expenses;
CREATE TRIGGER trg_expenses_guard_and_compute
    BEFORE INSERT OR UPDATE ON expenses
    FOR EACH ROW EXECUTE FUNCTION public.expenses_guard_and_compute();

CREATE OR REPLACE FUNCTION public.decide_expense(p_expense_id UUID, p_approve BOOLEAN, p_notes TEXT DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE
    v_exp expenses%ROWTYPE;
    v_required INT;
    v_approvals INT;
BEGIN
    SELECT * INTO v_exp FROM expenses WHERE id = p_expense_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Expense not found';
    END IF;
    IF NOT (is_platform_admin() OR is_society_admin(v_exp.society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can approve expenses';
    END IF;
    IF v_exp.status <> 'pending_approval' THEN
        RAISE EXCEPTION 'Expense is %, not pending approval', v_exp.status;
    END IF;
    IF v_exp.created_by = auth.uid() THEN
        RAISE EXCEPTION 'You created this expense; another committee member must approve it';
    END IF;
    IF EXISTS (SELECT 1 FROM expense_approvals WHERE expense_id = p_expense_id AND approver_id = auth.uid()) THEN
        RAISE EXCEPTION 'You have already recorded your decision on this expense';
    END IF;
    IF NOT p_approve AND length(trim(coalesce(p_notes, ''))) = 0 THEN
        RAISE EXCEPTION 'A reason is required to reject an expense';
    END IF;

    INSERT INTO expense_approvals (society_id, expense_id, approver_id, decision, notes)
    VALUES (v_exp.society_id, p_expense_id, auth.uid(), CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END, nullif(trim(coalesce(p_notes, '')), ''));

    SELECT CASE WHEN require_two_step_expense_approval THEN 2 ELSE 1 END INTO v_required
    FROM society_settings WHERE society_id = v_exp.society_id;
    v_required := coalesce(v_required, 1);

    SELECT count(*) INTO v_approvals FROM expense_approvals WHERE expense_id = p_expense_id AND decision = 'approved';

    PERFORM set_config('sahvaas.expense_workflow', 'on', true);
    IF NOT p_approve THEN
        UPDATE expenses SET status = 'rejected', updated_at = timezone('utc'::text, now()) WHERE id = p_expense_id;
    ELSIF v_approvals >= v_required THEN
        UPDATE expenses SET status = 'approved', approved_by = auth.uid(), approved_at = timezone('utc'::text, now()),
                            updated_at = timezone('utc'::text, now())
        WHERE id = p_expense_id;
    END IF;
    PERFORM set_config('sahvaas.expense_workflow', 'off', true);

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (v_exp.society_id, auth.uid(), CASE WHEN p_approve THEN 'expense.approved' ELSE 'expense.rejected' END,
            'expense', p_expense_id::text, jsonb_build_object('approvals', v_approvals, 'required', v_required, 'notes', p_notes));

    RETURN jsonb_build_object(
        'status', CASE WHEN NOT p_approve THEN 'rejected' WHEN v_approvals >= v_required THEN 'approved' ELSE 'pending_approval' END,
        'approvals', v_approvals,
        'required', v_required
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.mark_expense_paid(p_expense_id UUID, p_paid_date DATE DEFAULT current_date, p_reference TEXT DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE
    v_exp expenses%ROWTYPE;
BEGIN
    SELECT * INTO v_exp FROM expenses WHERE id = p_expense_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Expense not found';
    END IF;
    IF NOT (is_platform_admin() OR is_society_admin(v_exp.society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can record expense payments';
    END IF;
    IF v_exp.status <> 'approved' THEN
        RAISE EXCEPTION 'Only approved expenses can be paid (this one is %)', v_exp.status;
    END IF;

    PERFORM set_config('sahvaas.expense_workflow', 'on', true);
    UPDATE expenses
    SET status = 'paid', payment_status = 'paid', paid_date = coalesce(p_paid_date, current_date),
        payment_reference = nullif(trim(coalesce(p_reference, '')), ''), updated_at = timezone('utc'::text, now())
    WHERE id = p_expense_id;
    PERFORM set_config('sahvaas.expense_workflow', 'off', true);

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (v_exp.society_id, auth.uid(), 'expense.paid', 'expense', p_expense_id::text,
            jsonb_build_object('net_payable', v_exp.net_payable, 'reference', p_reference));

    RETURN jsonb_build_object('status', 'paid', 'net_payable', v_exp.net_payable);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.decide_expense(UUID, BOOLEAN, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mark_expense_paid(UUID, DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_expense(UUID, BOOLEAN, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_expense_paid(UUID, DATE, TEXT) TO authenticated;
