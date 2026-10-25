/**
 * Returns `path` only if it is a same-origin relative path (e.g. "/society").
 * Rejects absolute URLs, protocol-relative URLs ("//evil.com") and backslash tricks
 * so a crafted ?returnUrl= cannot send users to an external site.
 */
export function safeInternalPath(path: string | null | undefined): string | null {
  if (!path) return null;
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return null;
  return path;
}
