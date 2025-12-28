import { createClient } from "@supabase/supabase-js";

const supabaseUrl =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;

const serviceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

if (!supabaseUrl || !/^https?:\/\//.test(supabaseUrl)) {
  throw new Error(
    `Invalid supabaseUrl. Got: ${JSON.stringify(supabaseUrl)}. Please set SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL).`
  );
}

if (!serviceRoleKey) {
  throw new Error(
    "Missing SUPABASE_SERVICE_ROLE_KEY. Please set it in .env.local (Supabase Project Settings → API → service_role key)."
  );
}

export const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false },
});
