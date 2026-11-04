import { NextResponse } from 'next/server';
import { parsePincodeReply } from '../../../../lib/pincode';

// City and state for a pincode during setup. A slow or missing answer just means manual entry.
export const runtime = 'nodejs';

export async function GET(_request: Request, { params }: { params: Promise<{ pin: string }> }) {
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
