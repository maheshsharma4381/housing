// Setup step 2: city and state from a pincode (api.postalpincode.in), with manual entry as the fallback.

export interface PincodePlace { city: string; state: string }

export function parsePincodeReply(reply: unknown): PincodePlace | null {
  if (!Array.isArray(reply)) return null;
  const first = reply[0] as { Status?: string; PostOffice?: { District?: string; State?: string }[] | null } | undefined;
  const office = first?.Status === 'Success' ? first.PostOffice?.[0] : undefined;
  if (!office?.District || !office.State) return null;
  return { city: office.District, state: office.State };
}
