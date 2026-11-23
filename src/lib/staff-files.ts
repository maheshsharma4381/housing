// Phase 10: staff photos and ID proofs in the private staff-files bucket.
// Layout the storage policies expect: <society_id>/<staff_id>/photo-<uuid>.<ext> and /id-<uuid>.<ext>
import { supabase } from './supabase/client';

export const STAFF_FILES_BUCKET = 'staff-files';
const MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

export function staffFileError(kind: 'photo' | 'id', file: File): string | null {
  if (file.size > MAX_BYTES) return 'File is larger than 5 MB.';
  const allowed = kind === 'photo' ? IMAGE_TYPES : [...IMAGE_TYPES, 'application/pdf'];
  if (!allowed.includes(file.type)) return kind === 'photo' ? 'Use a JPG, PNG or WEBP photo.' : 'Use a PDF, JPG, PNG or WEBP file.';
  return null;
}

/** Upload, then attach it to the person (set_staff_file checks who may) */
export async function uploadStaffFile(societyId: string, staffId: string, kind: 'photo' | 'id', file: File): Promise<string> {
  if (!supabase) throw new Error('Supabase is not configured');
  const problem = staffFileError(kind, file);
  if (problem) throw new Error(problem);
  const path = `${societyId}/${staffId}/${kind}-${crypto.randomUUID()}.${EXT[file.type]}`;
  const { error } = await supabase.storage.from(STAFF_FILES_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw new Error(error.message);
  const { error: setErr } = await supabase.rpc('set_staff_file', { p_staff_id: staffId, p_kind: kind, p_path: path });
  if (setErr) throw new Error(setErr.message);
  return path;
}

export async function staffFileUrl(path: string, seconds = 300): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.storage.from(STAFF_FILES_BUCKET).createSignedUrl(path, seconds);
  return data?.signedUrl ?? null;
}
