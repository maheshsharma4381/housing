import { createBrowserClient } from '@supabase/ssr';
import { SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = 
  process.env.NEXT_PUBLIC_SUPABASE_URL || 
  process.env.VITE_SUPABASE_URL || 
  '';

const supabaseAnonKey = 
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 
  process.env.VITE_SUPABASE_ANON_KEY || 
  '';

export const isSupabaseConfigured = Boolean(
  supabaseUrl && 
  supabaseAnonKey && 
  supabaseUrl !== 'https://your-project-id.supabase.co' &&
  !supabaseUrl.includes('your-project-id')
);

/**
 * Browser-side Supabase client using @supabase/ssr with cookie-aware persistence
 */
export function createBrowserSupabaseClient(): SupabaseClient {
  return createBrowserClient(supabaseUrl, supabaseAnonKey);
}

// Singleton browser client instance for components & hooks
export const supabase = isSupabaseConfigured ? createBrowserSupabaseClient() : null;

/**
 * Diagnostic ping test for Supabase connection & schema
 */
export async function testSupabaseConnection(): Promise<{
  connected: boolean;
  message: string;
  urlConfigured: boolean;
}> {
  if (!isSupabaseConfigured || !supabase) {
    return {
      connected: false,
      message: 'NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY is not configured.',
      urlConfigured: false,
    };
  }

  try {
    const { error } = await supabase.from('societies').select('id').limit(1);
    if (error) {
      if (error.code === 'PGRST205') {
        return {
          connected: true,
          message: 'Supabase project endpoint connected! Database tables await execution of ALL_MIGRATIONS_CONSOLIDATED.sql in Supabase SQL Editor.',
          urlConfigured: true,
        };
      }
      if (error.code !== 'PGRST116') {
        return {
          connected: false,
          message: `Supabase error: ${error.message} (${error.code || 'unknown'})`,
          urlConfigured: true,
        };
      }
    }
    return {
      connected: true,
      message: 'Supabase connection established and database tables responsive.',
      urlConfigured: true,
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      connected: false,
      message: `Failed to connect to Supabase: ${errorMsg}`,
      urlConfigured: true,
    };
  }
}
