// Phase 11A: request documents in the private request-files bucket, and opening a NOC letter to print.
// Layout the storage policies expect: <society_id>/<request_id>/<uuid>-<safe name>
import { supabase } from './supabase/client';
import { requestFileError, nocLetterHtml, type NocLetter } from './requests';

export const REQUEST_FILES_BUCKET = 'request-files';

export async function uploadRequestFile(societyId: string, requestId: string, itemKey: string, file: File): Promise<void> {
  if (!supabase) throw new Error('Supabase is not configured');
  const problem = requestFileError(file);
  if (problem) throw new Error(problem);
  const safe = file.name.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '').slice(-80) || 'file';
  const path = `${societyId}/${requestId}/${crypto.randomUUID()}-${safe}`;
  const { error } = await supabase.storage.from(REQUEST_FILES_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw new Error(error.message);
  const { error: addErr } = await supabase.rpc('add_request_document', { p_request_id: requestId, p_item_key: itemKey, p_path: path, p_file_name: file.name });
  if (addErr) throw new Error(addErr.message);
}

export async function openRequestFile(path: string): Promise<void> {
  if (!supabase) return;
  const tab = window.open('', '_blank');
  const { data } = await supabase.storage.from(REQUEST_FILES_BUCKET).createSignedUrl(path, 120);
  if (data?.signedUrl && tab) tab.location.href = data.signedUrl;
  else tab?.close();
}

/** Open the letter as a printable page (Save as PDF from the print dialog) */
export async function openNocLetter(letter: NocLetter, societyId: string): Promise<void> {
  if (!supabase) return;
  const w = window.open('', '_blank');
  if (!w) return;
  const { data: s } = await supabase.from('societies')
    .select('name, registration_number, address_line1, address_line2, city, state, pincode').eq('id', societyId).maybeSingle();
  const address = s ? [s.address_line1, s.address_line2, s.city, [s.state, s.pincode].filter(Boolean).join(' ')].filter(Boolean).join(', ') : '';
  w.document.write(nocLetterHtml(letter, { name: s?.name ?? '', registration_number: s?.registration_number ?? null, address }));
  w.document.close();
}
