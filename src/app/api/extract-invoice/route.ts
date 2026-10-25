import { NextResponse, type NextRequest } from 'next/server';
import { createServerSupabaseClient } from '../../../lib/supabase/server';
import { INVOICE_PROMPT, invoiceTool, normaliseExtraction, openAiInvoiceTool } from '../../../lib/invoice-extract';

/**
 * POST /api/extract-invoice  { societyId, path, pageImages? }
 * Reads an uploaded vendor invoice with an AI model and returns the fields for the bill form.
 * Provider: Groq (GROQ_API_KEY, images only) or Anthropic (ANTHROPIC_API_KEY, PDF + images);
 * INVOICE_PROVIDER picks one when both are set. For a PDF with Groq the route answers
 * { needsImages: true } and the browser re-sends the first pages as JPEGs in `pageImages`.
 * The file is downloaded with the caller's own session, so storage RLS decides access.
 * Nothing is written to the database here — the committee member reviews and saves.
 */

const UUID_RE = /^[0-9a-f-]{36}$/i;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_PAGE_CHARS = 2_000_000; // ~1.5 MB per rendered page; Vercel caps request bodies at 4.5 MB
const MAX_PAGES = 2;
const MEDIA_TYPES: Record<string, string> = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

type Provider = { name: 'groq' | 'anthropic'; key: string; model: string };
type Input = { mediaType: string; data: string }[];

function pickProvider(): Provider | null {
  const pref = process.env.INVOICE_PROVIDER?.toLowerCase();
  const groq = process.env.GROQ_API_KEY;
  const anthropic = process.env.ANTHROPIC_API_KEY;
  if (groq && pref !== 'anthropic') return { name: 'groq', key: groq, model: process.env.INVOICE_MODEL || 'qwen/qwen3.8-27b' };
  if (anthropic && pref !== 'groq') return { name: 'anthropic', key: anthropic, model: process.env.INVOICE_MODEL || 'claude-opus-5-5' };
  return null;
}

async function readWithGroq(p: Provider, input: Input, categoryKeys: string[], signal: AbortSignal): Promise<unknown> {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: { authorization: `Bearer ${p.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: p.model,
      temperature: 0,
      max_completion_tokens: 1024,
      tools: [openAiInvoiceTool(categoryKeys)],
      tool_choice: { type: 'function', function: { name: 'record_invoice' } },
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: INVOICE_PROMPT },
          ...input.map(i => ({ type: 'image_url', image_url: { url: `data:${i.mediaType};base64,${i.data}` } })),
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`groq ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json() as { choices?: { message?: { content?: string | null; tool_calls?: { function?: { arguments?: string } }[] } }[] };
  const message = json.choices?.[0]?.message;
  const raw = message?.tool_calls?.[0]?.function?.arguments ?? message?.content ?? '';
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/); // some models wrap JSON in prose
    return match ? JSON.parse(match[0]) : null;
  }
}

async function readWithAnthropic(p: Provider, input: Input, categoryKeys: string[], signal: AbortSignal): Promise<unknown> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: { 'x-api-key': p.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: p.model,
      max_tokens: 1024,
      tools: [invoiceTool(categoryKeys)],
      tool_choice: { type: 'tool', name: 'record_invoice' },
      messages: [{
        role: 'user',
        content: [
          ...input.map(i => i.mediaType === 'application/pdf'
            ? { type: 'document', source: { type: 'base64', media_type: i.mediaType, data: i.data } }
            : { type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } }),
          { type: 'text', text: INVOICE_PROMPT },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json() as { content?: { type: string; input?: unknown }[] };
  return json.content?.find(c => c.type === 'tool_use')?.input ?? null;
}

export async function POST(request: NextRequest) {
  let body: { societyId?: string; path?: string; pageImages?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const { societyId, path, pageImages } = body;
  if (!societyId || !UUID_RE.test(societyId) || !path || !path.startsWith(`${societyId}/expenses/`) || path.includes('..')) {
    return NextResponse.json({ error: 'societyId and an expenses file path are required' }, { status: 400 });
  }

  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const { data: isAdmin } = await supabase.rpc('is_society_admin', { target_society_id: societyId });
  if (!isAdmin) return NextResponse.json({ error: 'Only the society committee can read invoices' }, { status: 403 });

  // Without a key the bill form simply stays manual
  const provider = pickProvider();
  if (!provider) return NextResponse.json({ configured: false });

  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const mediaType = MEDIA_TYPES[ext];
  if (!mediaType) return NextResponse.json({ error: 'Only PDF, JPG, PNG or WEBP invoices can be read' }, { status: 400 });

  // The uploaded file must exist and be readable by this user, even when pages come rendered
  const { data: file, error: dlErr } = await supabase.storage.from('society-files').download(path);
  if (dlErr || !file) return NextResponse.json({ error: 'Invoice file not found' }, { status: 404 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: 'Invoice is larger than 10 MB' }, { status: 413 });

  let input: Input;
  if (mediaType === 'application/pdf' && provider.name === 'groq') {
    if (!Array.isArray(pageImages) || pageImages.length === 0) {
      return NextResponse.json({ configured: true, needsImages: true, maxPages: MAX_PAGES });
    }
    const pages = pageImages.slice(0, MAX_PAGES);
    if (!pages.every(p => typeof p === 'string' && p.length <= MAX_PAGE_CHARS && BASE64_RE.test(p))) {
      return NextResponse.json({ error: 'Rendered pages are invalid or too large' }, { status: 400 });
    }
    input = (pages as string[]).map(data => ({ mediaType: 'image/jpeg', data }));
  } else {
    input = [{ mediaType, data: Buffer.from(await file.arrayBuffer()).toString('base64') }];
  }

  const { data: cats } = await supabase.from('expense_categories').select('key').eq('is_active', true);
  const categoryKeys = [...new Set((cats ?? []).map(c => c.key as string))];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const raw = provider.name === 'groq'
      ? await readWithGroq(provider, input, categoryKeys, controller.signal)
      : await readWithAnthropic(provider, input, categoryKeys, controller.signal);
    return NextResponse.json({ configured: true, provider: provider.name, invoice: normaliseExtraction(raw, categoryKeys) });
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    if (!aborted) console.warn('Invoice reader failed:', err instanceof Error ? err.message : err);
    const rateLimited = err instanceof Error && / 429:/.test(err.message);
    return NextResponse.json({
      configured: true,
      error: aborted ? 'Reading the invoice took too long — please type the details'
        : rateLimited ? 'The invoice reader is busy right now — please type the details or try again in a minute'
        : 'Could not read the invoice — please type the details',
    }, { status: aborted ? 504 : 502 });
  } finally {
    clearTimeout(timer);
  }
}
