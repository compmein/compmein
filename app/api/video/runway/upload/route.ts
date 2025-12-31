import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

export const runtime = "nodejs";

const INPUT_BUCKET = "video-inputs";
const ASSET_LINK_TTL_MS = 15 * 60 * 1000; // 15 min 给 Runway 拉图足够（生成任务会很快开始取图）

function j(status: number, body: any) {
  return NextResponse.json(body, { status });
}

function isImageFile(v: any): v is File {
  return v instanceof File && typeof v.type === "string" && v.type.startsWith("image/");
}

function extFromMime(mime: string) {
  const m = (mime || "").toLowerCase();
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  return "jpg";
}

function b64url(buf: Buffer) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function sign(path: string, exp: number, secret: string) {
  const h = crypto.createHmac("sha256", secret);
  h.update(`${path}|${exp}`);
  return b64url(h.digest());
}

export async function POST(req: Request) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const supabaseService = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const assetSecret = process.env.RUNWAY_ASSET_SIGNING_SECRET;

  if (!supabaseUrl || !supabaseAnon || !supabaseService) return j(500, { error: "MISSING_SUPABASE_ENV" });
  if (!assetSecret) return j(500, { error: "Missing env RUNWAY_ASSET_SIGNING_SECRET" });

  const cookieStore = await cookies();
  const supabaseAuth = createServerClient(supabaseUrl, supabaseAnon, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
      },
    },
  });

  const {
    data: { user },
    error: userErr,
  } = await supabaseAuth.auth.getUser();

  if (userErr || !user) return j(401, { error: "UNAUTH" });

  const ct = req.headers.get("content-type") || "";
  if (!ct.includes("multipart/form-data")) return j(400, { error: "Expected multipart/form-data" });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return j(400, { error: "BAD_FORMDATA" });
  }

  const img = form.get("image");
  if (!isImageFile(img)) return j(400, { error: "Missing image file" });

  const ext = extFromMime(img.type);
  const path = `${user.id}/runway_inputs/${Date.now()}-${crypto.randomUUID()}.${ext}`;

  const supabaseAdmin = createClient(supabaseUrl, supabaseService, { auth: { persistSession: false } });

  const buf = Buffer.from(await img.arrayBuffer());
  const { error: upErr } = await supabaseAdmin.storage.from(INPUT_BUCKET).upload(path, buf, {
    contentType: img.type || "image/jpeg",
    upsert: true,
  });

  if (upErr) return j(500, { error: "UPLOAD_FAILED", details: upErr });

  // build short asset url on YOUR domain
  const exp = Date.now() + ASSET_LINK_TTL_MS;
  const sig = sign(path, exp, assetSecret);
  const origin = new URL(req.url).origin;

  const assetUrl = `${origin}/api/video/runway/asset?p=${encodeURIComponent(path)}&e=${exp}&s=${sig}`;

  return j(200, {
    bucket: INPUT_BUCKET,
    path,
    assetUrl,
    expiresAt: exp,
  });
}
