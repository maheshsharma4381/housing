// What public/sw.js may answer (keep the two in step): a page load of this site that fails offline gets the
// offline page. API calls, Supabase and other sites always go to the network and are never cached.
export function swShouldHandle(req: { url: string; mode: string; method: string }, origin: string): boolean {
  if (req.method !== 'GET' || req.mode !== 'navigate') return false;
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return false;
  }
  return url.origin === origin && !url.pathname.startsWith('/api/');
}
