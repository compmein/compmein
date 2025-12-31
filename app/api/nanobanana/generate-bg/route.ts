import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

export const runtime = "nodejs";

const BUCKET = "ai-results";
const MAX_IMAGES_PER_USER = 10;

const COSTS = {
  nano: 15,
  pro: 45,
} as const;

type ModelType = "nano" | "pro";
type GeminiImageSize = "1K" | "2K" | "4K";

const ALLOWED_AR = new Set(["21:9", "16:9", "4:3", "3:2", "1:1", "9:16", "3:4", "2:3", "5:4", "4:5"]);

function reply(status: number, body: any) {
  return NextResponse.json(body, { status });
}

function safeJsonParse(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function isImageFile(v: any): v is File {
  return v instanceof File && typeof v.type === "string" && v.type.startsWith("image/");
}

async function fileToInlineData(f: File) {
  const bytes = new Uint8Array(await f.arrayBuffer());
  return {
    inlineData: {
      mimeType: f.type || "image/jpeg",
      data: Buffer.from(bytes).toString("base64"),
    },
  };
}

function pickFirstImageFromGemini(json: any): { base64: string; mimeType: string } | null {
  const parts = json?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;
  for (const p of parts) {
    const d = p?.inlineData?.data;
    if (typeof d === "string" && d.length > 100) {
      const mt = (p?.inlineData?.mimeType as string) || "image/png";
      return { base64: d, mimeType: mt };
    }
  }
  return null;
}

function mapImageSizeToGemini(v: string): GeminiImageSize {
  const s = (v ?? "").trim().toUpperCase();
  if (s === "4K" || s.includes("FORCE_4K")) return "4K";
  if (s === "1K" || s.includes("1MP")) return "1K";
  if (s.includes("SAFE_4MP") || s.includes("4MP") || s === "2K") return "2K";
  return "2K";
}

async function safeRefund(supabase: any, chargeId?: string) {
  if (!chargeId) return;
  await supabase.rpc("refund_charge", { p_charge_id: chargeId });
}

async function safeSettle(supabase: any, chargeId?: string, resultId?: string) {
  if (!chargeId || !resultId) return;
  await supabase.rpc("settle_charge", { p_charge_id: chargeId, p_result_id: resultId });
}

export async function POST(req: Request) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const supabaseService = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseAnon || !supabaseService) return reply(500, { error: "MISSING_SUPABASE_ENV" });

  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) return reply(500, { error: "MISSING_GEMINI_API_KEY" });

  // Auth user (cookie session)
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

  if (userErr) return reply(401, { error: "UNAUTH", detail: userErr });
  if (!user) return reply(401, { error: "UNAUTH" });

  // ---- Parse input (prefer FormData; keep JSON compatibility) ----
  let prompt = "";
  let aspectRatio = "16:9";
  let modelType: ModelType = "nano";
  let imageSizeHint = "SAFE_4MP";
  let imageFile: File | null = null;

  const ct = req.headers.get("content-type") || "";
  if (ct.includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return reply(400, { error: "BAD_FORMDATA" });
    }

    prompt = String(form.get("prompt") ?? "").trim();
    const ar = String(form.get("aspectRatio") ?? "16:9").trim();
    aspectRatio = ALLOWED_AR.has(ar) ? ar : "16:9";

    const mt = String(form.get("modelType") ?? "nano").trim();
    modelType = mt === "pro" ? "pro" : "nano";

    imageSizeHint = String(form.get("imageSize") ?? "SAFE_4MP").trim();

    const imgRaw = form.get("image");
    if (isImageFile(imgRaw)) imageFile = imgRaw as File;
  } else {
    const body = await req.json().catch(() => ({}));
    prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
    const ar = typeof body?.aspectRatio === "string" ? body.aspectRatio : "16:9";
    aspectRatio = ALLOWED_AR.has(ar) ? ar : "16:9";

    const mt = typeof body?.modelType === "string" ? body.modelType : "nano";
    modelType = mt === "pro" ? "pro" : "nano";

    imageSizeHint = typeof body?.imageSize === "string" ? body.imageSize : "SAFE_4MP";
    // JSON mode不支持图（保持兼容即可）
  }

  if (!prompt) return reply(400, { error: "MISSING_PROMPT" });

  // ---- Charge tokens (server-side) ----
  const cost = modelType === "pro" ? COSTS.pro : COSTS.nano;
  const { data: chargeData, error: chargeError } = await supabaseAuth.rpc("spend_tokens_with_ledger", {
    p_user: user.id,
    p_cost: cost,
    p_action: modelType === "pro" ? "BG_PRO" : "BG_NANO",
  });

  if (chargeError) return reply(403, { error: chargeError.message });
  const chargeId: string | undefined = chargeData?.[0]?.charge_id;

  // ---- Build Gemini request ----
  const modelUsed = modelType === "pro" ? "gemini-3-pro-image-preview" : "gemini-2.5-flash-image";

  const imageConfig: any = { aspectRatio };
  if (modelType === "pro") {
    imageConfig.imageSize = mapImageSizeToGemini(imageSizeHint);
  }

  try {
    const parts: any[] = [{ text: prompt }];
    if (imageFile) parts.push(await fileToInlineData(imageFile));

    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelUsed}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          responseModalities: ["Image"],
          imageConfig,
        },
      }),
    });

    const rawTxt = await resp.text().catch(() => "");
    const rawJson = safeJsonParse(rawTxt) ?? rawTxt;

    if (!resp.ok) {
      await safeRefund(supabaseAuth, chargeId);
      return reply(502, { error: "GEMINI_ERROR", details: rawJson });
    }

    const picked = pickFirstImageFromGemini(rawJson);
    if (!picked) {
      await safeRefund(supabaseAuth, chargeId);
      return reply(502, { error: "SAFETY_OR_NO_IMAGE", raw: rawJson });
    }

    // ---- Store output (upload + ai_results insert) ----
    const outMime = picked.mimeType || "image/png";
    const ext = outMime.includes("jpeg") || outMime.includes("jpg") ? "jpg" : "png";
    const storagePath = `${user.id}/bg/${Date.now()}-${crypto.randomUUID()}.${ext}`;
    const outBuf = Buffer.from(picked.base64, "base64");

    const supabaseAdmin = createClient(supabaseUrl, supabaseService, { auth: { persistSession: false } });

    const { error: uploadError } = await supabaseAdmin.storage.from(BUCKET).upload(storagePath, outBuf, {
      contentType: outMime,
      upsert: true,
    });

    if (uploadError) {
      await safeRefund(supabaseAuth, chargeId);
      return reply(500, { error: "UPLOAD_FAILED", detail: uploadError });
    }

    const { data: resultData, error: insertError } = await supabaseAdmin
      .from("ai_results")
      .insert({
        user_id: user.id,
        kind: "image",
        model: modelUsed,
        storage_bucket: BUCKET,
        storage_path: storagePath,
        mime_type: outMime,
        bytes: outBuf.length,
        status: "ready",
      })
      .select("id")
      .single();

    if (insertError || !resultData?.id) {
      await safeRefund(supabaseAuth, chargeId);
      return reply(500, { error: "DB_INSERT_FAILED", details: insertError });
    }

    // keep only last N
    try {
      const { data: oldImages } = await supabaseAdmin
        .from("ai_results")
        .select("id, storage_path")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });

      if (oldImages && oldImages.length > MAX_IMAGES_PER_USER) {
        const toDelete = oldImages.slice(MAX_IMAGES_PER_USER);
        await supabaseAdmin.storage.from(BUCKET).remove(toDelete.map((r: any) => r.storage_path));
        await supabaseAdmin.from("ai_results").delete().in("id", toDelete.map((r: any) => r.id));
      }
    } catch {
      // ignore cleanup failures
    }

    await safeSettle(supabaseAuth, chargeId, resultData.id);

    // signed URL for preview (1 hour)
    const { data: signed, error: signErr } = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(storagePath, 60 * 60);
    if (signErr || !signed?.signedUrl) {
      // even if sign fails, result is stored; return base64 as fallback
      return reply(200, {
        resultId: resultData.id,
        mimeType: outMime,
        imageBase64: picked.base64,
      });
    }

    return reply(200, {
      resultId: resultData.id,
      signedUrl: signed.signedUrl,
      mimeType: outMime,
      imageBase64: picked.base64,
    });
  } catch (e: any) {
    await safeRefund(supabaseAuth, chargeId);
    return reply(500, { error: "SERVER_ERROR", message: e?.message || String(e) });
  }
}
