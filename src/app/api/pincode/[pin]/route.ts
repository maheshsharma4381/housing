import { NextResponse } from 'next/server';
import { parsePincodeReply } from '../../../../lib/pincode';
import { createRateLimiter } from '../../../../lib/rate-limit';
import { createServerSupabaseClient } from '../../../../lib/supabase/server';

// City and state for a pincode during setup. A slow or missing answer just means manual entry.
export const runtime = 'nodejs';

// Setup needs a handful of lookups; this only stops a script from using the route as a free pincode API
const allowed = createRateLimiter(20, 10 * 60_000);

export async function GET(_request: Request, { params }: { params: Promise<{ pin: string }> }) {
  let userId: string | undefined;
  try {
    const supabase = await createServerSupabaseClient();
    userId = (await supabase.auth.getUser()).data.user?.id;
  } catch {
    userId = undefined;
  }
  if (!userId) return NextResponse.json({ error: 'Log in first' }, { status: 401 });
  if (!allowed(userId)) return NextResponse.json({ error: 'Too many lookups — type the city and state' }, { status: 429 });

  const { pin } = await params;
  if (!/^[1-9][0-9]{5}$/.test(pin)) return NextResponse.json({ error: 'Pincode must be 6 digits' }, { status: 400 });
  try {
    const res = await fetch(`https://api.postalpincode.in/pincode/${pin}`, { signal: AbortSignal.timeout(3000), next: { revalidate: 86400 } });
    const place = res.ok ? parsePincodeReply(await res.json()) : null;
    return place ? NextResponse.json(place) : NextResponse.json({ error: 'Not found' }, { status: 404 });
  } catch {
    return NextResponse.json({ error: 'Lookup unavailable' }, { status: 504 });
  }
}
