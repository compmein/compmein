import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

function json(status: number, body: any) {
  return NextResponse.json(body, { status });
}

export async function POST(req: Request) {
  let body: any = null;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "BAD_JSON" });
  }

  const resultId = String(body?.resultId || "").trim();
  if (!resultId) return json(400, { error: "MISSING_RESULT_ID" });

  // 1) Auth user via cookies + anon key (safe)
  const cookieStore = await cookies();
  const supabaseAuth = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) =>
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options)),
      },
    }
  );

  const {
    data: { user },
  } = await supabaseAuth.auth.getUser();
  if (!user) return json(401, { error: "UNAUTH" });

  // 2) Admin client for DB + storage signed URL
  const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  const { data: row, error } = await supabaseAdmin
    .from("ai_results")
    .select("id, user_id, storage_bucket, storage_path, mime_type")
    .eq("id", resultId)
    .single();

  if (error || !row) return json(404, { error: "NOT_FOUND" });
  if (row.user_id !== user.id) return json(403, { error: "FORBIDDEN" });

  const bucket = row.storage_bucket || "ai-results";
  const path = row.storage_path;
  if (!bucket || !path) return json(500, { error: "MISSING_STORAGE_INFO" });

  const { data: signed, error: signErr } = await supabaseAdmin.storage.from(bucket).createSignedUrl(path, 60 * 60);
  if (signErr || !signed?.signedUrl) return json(500, { error: "SIGN_FAILED" });

  return json(200, {
    signedUrl: signed.signedUrl,
    mimeType: row.mime_type || null,
  });
}
