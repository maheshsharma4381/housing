const BASE = 'https://sahvaas.invalid';

/**
 * Returns `path` only if it is a same-origin relative path (e.g. "/society").
 * Rejects absolute URLs, protocol-relative URLs ("//evil.com"), backslashes and control characters
 * (a browser drops a tab or newline, so "/\t/evil.com" would become "//evil.com"),
 * and anything that still resolves to another site.
 */
export function safeInternalPath(path: string | null | undefined): string | null {
  if (!path) return null;
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return null;
  if (/[\u0000-\u001f\u007f]/.test(path)) return null;
  try {
    if (new URL(path, BASE).origin !== BASE) return null;
  } catch {
    return null;
  }
  return path;
}
