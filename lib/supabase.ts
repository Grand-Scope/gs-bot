import { createClient, SupabaseClient } from '@supabase/supabase-js';

let _client: SupabaseClient | null = null;

/**
 * Returns a lazily-initialized Supabase client.
 * Using a getter prevents `createClient` from running at module-evaluation
 * time (i.e. during `next build`), where env vars don't exist.
 */
export function getSupabase(): SupabaseClient {
  if (!_client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY;
    if (!url || !key) {
      throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY env vars.');
    }
    _client = createClient(url, key);
  }
  return _client;
}

/** Convenience alias for callers that prefer a direct reference. */
export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    return (getSupabase() as any)[prop];
  },
});
