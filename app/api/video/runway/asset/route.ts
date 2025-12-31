import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

export const runtime = "nodejs";

const INPUT_BUCKET = "video-inputs";
const SIGNED_URL_TTL = 60 * 60; // 1 hour

function j(status: number, body: any) {
  return NextResponse.json(body, { status });
}

function b64url(buf: Buffer) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function sign(path: string, exp: number, secret: string) {
  const h = crypto.createHmac("sha256", secret);
  h.update(`${path}|${exp}`);
  return b64url(h.digest());
}

export async function GET(req: Request) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseService = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const assetSecret = process.env.RUNWAY_ASSET_SIGNING_SECRET;

  if (!supabaseUrl || !supabaseService) return j(500, { error: "MISSING_SUPABASE_ENV" });
  if (!assetSecret) return j(500, { error: "Missing env RUNWAY_ASSET_SIGNING_SECRET" });

  const { searchParams } = new URL(req.url);
  const path = String(searchParams.get("p") || "");
  const exp = Number(searchParams.get("e") || "0");
  const sig = String(searchParams.get("s") || "");

  if (!path || !exp || !sig) return j(400, { error: "BAD_QUERY" });
  if (Date.now() > exp) return j(410, { error: "LINK_EXPIRED" });

  const expected = sign(path, exp, assetSecret);
  if (sig !== expected) return j(401, { error: "BAD_SIGNATURE" });

  const supabaseAdmin = createClient(supabaseUrl, supabaseService, { auth: { persistSession: false } });

  const { data: signed, error: signErr } = await supabaseAdmin.storage
    .from(INPUT_BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL);

  if (signErr || !signed?.signedUrl) return j(500, { error: "SIGNED_URL_FAILED", details: signErr });

  // 302 redirect to the real (possibly long) signed URL
  return NextResponse.redirect(signed.signedUrl, 302);
}
