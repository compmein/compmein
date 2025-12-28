import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
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

function reply(status: number, body: any, headers?: Record<string, string>) {
  return NextResponse.json(body, { status, headers });
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

async function safeRefund(supabase: any, chargeId?: string) {
  if (!chargeId) return;
  await supabase.rpc("refund_charge", { p_charge_id: chargeId });
}

async function safeSettle(supabase: any, chargeId?: string, resultId?: string) {
  if (!chargeId || !resultId) return;
  await supabase.rpc("settle_charge", { p_charge_id: chargeId, p_result_id: resultId });
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

/**
 * Map client hint -> Gemini imageSize.
 *
 * IMPORTANT (per docs/pricing):
 * - imageSize accepts "1K" | "2K" | "4K" (uppercase K).
 * - Default is "1K" if omitted.
 * - 1K and 2K have the same output token cost; 4K costs more.
 *
 * Product intent here:
 * - "SAFE_4MP" (your 4MP-safe stage export) -> request "2K" output,
 *   which avoids 4K cost but is higher than the 1K default.
 * - If you ever want true 4K output, pass "4K" explicitly.
 */
function mapImageSizeToGemini(v: string): GeminiImageSize {
  const s = (v ?? "").trim().toUpperCase();

  if (s === "4K" || s.includes("FORCE_4K")) return "4K";
  if (s === "1K" || s.includes("1MP")) return "1K";

  // Treat SAFE_4MP / 4MP as "maximize quality without entering 4K cost tier"
  if (s.includes("SAFE_4MP") || s.includes("4MP") || s === "2K") return "2K";

  // Pro default: 2K (better than default 1K, same token cost as 1K on Vertex pricing)
  return "2K";
}

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return reply(400, { error: "BAD_FORMDATA" });
  }

  const sceneRaw = form.get("image");
  const refRaw = form.get("refImage");
  const prompt = String(form.get("prompt") ?? "").trim();
  const modelType = String(form.get("modelType") ?? "nano").trim() as ModelType;
  const aspectRatio = String(form.get("aspectRatio") ?? "16:9").trim();
  const clientImageSize = String(form.get("imageSize") ?? "").trim();

  if (!prompt || !isImageFile(sceneRaw)) {
    return reply(400, { error: "Missing prompt or scene image" });
  }

  const sceneFile = sceneRaw as File;
  const refFile = isImageFile(refRaw) ? (refRaw as File) : null;

  const mt: ModelType = modelType === "pro" ? "pro" : "nano";
  const cost = COSTS[mt];

  const cookieStore = await cookies();
  const supabase = createServerClient(
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
  } = await supabase.auth.getUser();
  if (!user) return reply(401, { error: "UNAUTH" });

  // 1) Charge tokens
  const { data: chargeData, error: chargeError } = await supabase.rpc("spend_tokens_with_ledger", {
    p_user: user.id,
    p_cost: cost,
    p_action: mt === "pro" ? "AI_PRO" : "AI_QUICK",
  });

  if (chargeError) return reply(403, { error: chargeError.message });
  const chargeId: string | undefined = chargeData?.[0]?.charge_id;

  // 2) Build Gemini request
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const modelUsed = mt === "pro" ? "gemini-3-pro-image-preview" : "gemini-2.5-flash-image";

  const imageConfig: any = { aspectRatio };
  if (mt === "pro") {
    // Default to 2K to avoid accidental 4K cost, while improving over 1K default.
    imageConfig.imageSize = mapImageSizeToGemini(clientImageSize);
  }

  try {
    const parts: any[] = [{ text: prompt }];
    parts.push(await fileToInlineData(sceneFile));
    if (refFile) parts.push(await fileToInlineData(refFile));

    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelUsed}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            responseModalities: ["Image"],
            imageConfig,
          },
        }),
      }
    );

    const rawJson = await resp.json();
    if (!resp.ok) {
      await safeRefund(supabase, chargeId);
      return reply(502, { error: "GEMINI_ERROR", details: rawJson });
    }

    const picked = pickFirstImageFromGemini(rawJson);
    if (!picked) {
      await safeRefund(supabase, chargeId);
      return reply(502, { error: "SAFETY_OR_NO_IMAGE", raw: rawJson });
    }

    // 3) Store output (no re-encode / no resize)
    const outMime = picked.mimeType || "image/png";
    const ext = outMime.includes("jpeg") ? "jpg" : "png";
    const storagePath = `${user.id}/${crypto.randomUUID()}.${ext}`;
    const outBuf = Buffer.from(picked.base64, "base64");

    const { error: uploadError } = await supabase.storage.from(BUCKET).upload(storagePath, outBuf, {
      contentType: outMime,
    });

    if (uploadError) {
      await safeRefund(supabase, chargeId);
      return reply(500, { error: "UPLOAD_FAILED" });
    }

    const { data: resultData, error: insertError } = await supabase
      .from("ai_results")
      .insert({
        user_id: user.id,
        kind: "image",
        model: mt,
        storage_bucket: BUCKET,
        storage_path: storagePath,
        mime_type: outMime,
        bytes: outBuf.length,
        status: "ready",
      })
      .select("id")
      .single();

    if (insertError || !resultData?.id) {
      await safeRefund(supabase, chargeId);
      return reply(500, { error: "DB_INSERT_FAILED", details: insertError?.message });
    }

    // Optional cleanup: keep only last N
    try {
      const { data: oldImages } = await supabase
        .from("ai_results")
        .select("id, storage_path")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });

      if (oldImages && oldImages.length > MAX_IMAGES_PER_USER) {
        const toDelete = oldImages.slice(MAX_IMAGES_PER_USER);
        await supabase.storage.from(BUCKET).remove(toDelete.map((r: any) => r.storage_path));
        await supabase.from("ai_results").delete().in("id", toDelete.map((r: any) => r.id));
      }
    } catch {
      // ignore cleanup failures
    }

    await safeSettle(supabase, chargeId, resultData.id);

    return reply(200, {
      imageBase64: picked.base64,
      mimeType: outMime,
      resultId: resultData.id,
      // Useful for debugging in UI/console if you want:
      // requestedImageSize: mt === "pro" ? imageConfig.imageSize : undefined,
    });
  } catch (e: any) {
    await safeRefund(supabase, chargeId);
    return reply(500, { error: "SERVER_ERROR", detail: e?.message || String(e) });
  }
}
