import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL?.trim().replace(/\/(rest|auth)\/v1.*$/, '').replace(/\/$/, '');
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();

export const supabase = url && key
  ? createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
  : null;
