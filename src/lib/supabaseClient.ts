import { createClient } from '@supabase/supabase-js';

// Runtime settings (container hosting) win over build-time ones (Netlify).
const runtime = (window as unknown as { __EMNS_CONFIG__?: { supabaseUrl?: string; supabaseKey?: string } }).__EMNS_CONFIG__ ?? {};
const supabaseUrl = (runtime.supabaseUrl || import.meta.env.VITE_SUPABASE_URL) as string;
const supabaseKey = (runtime.supabaseKey || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY) as string;

if (!supabaseUrl || !supabaseKey) {
  // eslint-disable-next-line no-console
  console.error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY env vars.');
}

export const supabase = createClient(supabaseUrl, supabaseKey);
