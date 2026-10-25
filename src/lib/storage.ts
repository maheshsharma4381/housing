import { supabase } from './supabase/client';

export const SOCIETY_FILES_BUCKET = 'society-files';
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // matches the bucket's file_size_limit (008)

const ALLOWED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

/** Validate before upload; returns an error message or null. */
export function validateUpload(file: File): string | null {
  if (file.size > MAX_UPLOAD_BYTES) return 'File is larger than 10 MB.';
  if (!ALLOWED_TYPES.includes(file.type)) return 'Only PDF, JPG, PNG or WEBP files are allowed.';
  return null;
}

/**
 * Upload into `<societyId>/<folder>/<uuid>-<safe-name>` (the layout storage policies expect).
 * Returns the object path stored in documents.file_url / expenses.document_url.
 */
export async function uploadSocietyFile(societyId: string, folder: 'documents' | 'expenses', file: File): Promise<string> {
  if (!supabase) throw new Error('Supabase is not configured');
  const problem = validateUpload(file);
  if (problem) throw new Error(problem);

  const safeName = file.name.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '').slice(-80) || 'file';
  const path = `${societyId}/${folder}/${crypto.randomUUID()}-${safeName}`;
  const { error } = await supabase.storage.from(SOCIETY_FILES_BUCKET).upload(path, file, {
    contentType: file.type,
    upsert: false,
  });
  if (error) throw new Error(error.message);
  return path;
}

/** Open a private file in a new tab via a short-lived signed URL. */
export async function openSocietyFile(path: string): Promise<void> {
  if (!supabase) throw new Error('Supabase is not configured');
  // Open the tab synchronously so pop-up blockers allow it, then point it at the signed URL
  const tab = window.open('', '_blank');
  const { data, error } = await supabase.storage.from(SOCIETY_FILES_BUCKET).createSignedUrl(path, 120);
  if (error || !data) {
    tab?.close();
    throw new Error(error?.message ?? 'Could not open file');
  }
  if (tab) tab.location.href = data.signedUrl;
  else window.location.href = data.signedUrl;
}

export async function deleteSocietyFile(path: string): Promise<void> {
  if (!supabase) return;
  await supabase.storage.from(SOCIETY_FILES_BUCKET).remove([path]);
}
