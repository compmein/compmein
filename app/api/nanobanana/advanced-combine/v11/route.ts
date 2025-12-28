import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import crypto from "crypto";

export const runtime = "nodejs";

const BUCKET = "ai-results";
const MAX_IMAGES_PER_USER = 10;
const SIGNED_URL_TTL_SECONDS = 60;

// Token costs
const COSTS = {
  nano: 15,
  pro: 45,
} as const;

type ModelType = keyof typeof COSTS;

type PickedImage = { base64: string; mimeType: string };

function json(status: number, body: any) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function isImageFile(v: any): v is File {
  return (
    v instanceof File &&
    ((typeof v.type === "string" && v.type.startsWith("image/")) ||
      (typeof v.name === "string" && /\.(png|jpe?g|webp)$/i.test(v.name)))
  );
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

function pickFirstImageFromGemini(respJson: any): PickedImage | null {
  const parts = respJson?.candidates?.[0]?.content?.parts;
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

async function safeRefund(supabase: any, chargeId: string) {
  const { error } = await supabase.rpc("refund_charge", { p_charge_id: chargeId });
  if (error) {
    // ignore
  }
}

async function safeSettle(supabase: any, chargeId: string, resultId: string) {
  const { error } = await supabase.rpc("settle_charge", {
    p_charge_id: chargeId,
    p_result_id: resultId,
  });
  if (error) {
    // ignore
  }
}

export async function POST(req: Request) {
  // 1) Parse form-data
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(400, { error: "BAD_FORMDATA" });
  }

  const sceneRaw = form.get("image");
  const refRaw = form.get("refImage");
  const prompt = String(form.get("prompt") ?? "").trim();
  const modelType = String(form.get("modelType") ?? "nano").trim() as ModelType;
  const aspectRatio = String(form.get("aspectRatio") ?? "16:9").trim();
  const imageSize = String(form.get("imageSize") ?? "").trim(); // optional (pro)

  if (!prompt) return json(400, { error: "Missing prompt" });
  if (!isImageFile(sceneRaw)) return json(400, { error: "Missing scene image (field: image)" });
  if (modelType !== "nano" && modelType !== "pro") return json(400, { error: "BAD_MODELTYPE" });

  const sceneFile = sceneRaw as File;
  const refFile = isImageFile(refRaw) ? (refRaw as File) : null;

  // 2) Enforce strict scene size caps (aligns with your pricing tiers)
  const MAX_SCENE_BYTES = modelType === "pro" ? 2_500_000 : 2_000_000; // ~2.5MB / ~2MB
  const MAX_REF_BYTES = 512_000; // ~512KB
  if (sceneFile.size > MAX_SCENE_BYTES) {
    return json(413, {
      error: "SCENE_TOO_LARGE",
      message: `Scene image too large (max ${Math.round((MAX_SCENE_BYTES / 1_000_000) * 10) / 10}MB)`,
      maxBytes: MAX_SCENE_BYTES,
      gotBytes: sceneFile.size,
    });
  }
  if (refFile && refFile.size > MAX_REF_BYTES) {
    return json(413, {
      error: "REF_TOO_LARGE",
      message: "Reference image too large (max 512KB)",
      maxBytes: MAX_REF_BYTES,
      gotBytes: refFile.size,
    });
  }

  // 3) Supabase server client
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        },
      },
    }
  );

  const { data: userData, error: userErr } = await supabase.auth.getUser();
  const user = userData?.user;
  if (userErr || !user) return json(401, { error: "UNAUTH" });

  // 4) Spend tokens (pending)
  const cost = COSTS[modelType];
  let chargeId = "";
  let newBalance = 0;
  {
    const { data, error } = await supabase.rpc("spend_tokens_with_ledger", {
      p_user: user.id,
      p_cost: cost,
      p_action: modelType === "pro" ? "AI_PRO" : "AI_QUICK",
    });

    if (error) {
      const msg = String(error.message || error);
      if (msg.includes("NOT_ENOUGH_TOKENS")) return json(403, { error: "NOT_ENOUGH_TOKENS", cost });
      return json(500, { error: "SPEND_FAILED", detail: msg });
    }

    const row = Array.isArray(data) ? data[0] : data;
    chargeId = String(row?.charge_id || "");
    newBalance = Number(row?.new_balance ?? row?.balance ?? 0);
    if (!chargeId) return json(500, { error: "SPEND_FAILED_NO_CHARGE_ID" });
  }

  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    await safeRefund(supabase, chargeId);
    return json(500, { error: "MISSING_GEMINI_KEY" });
  }

  // 5) Call Gemini
  const modelUsed = modelType === "pro" ? "gemini-3-pro-image-preview" : "gemini-2.5-flash-image";

  try {
    const parts: any[] = [{ text: prompt }];
    parts.push(await fileToInlineData(sceneFile));
    if (refFile) parts.push(await fileToInlineData(refFile));

    const imageConfig: any =
      modelType === "pro" ? { aspectRatio, ...(imageSize ? { imageSize } : {}) } : { aspectRatio };

    const body = {
      contents: [{ parts }],
      generationConfig: {
        responseModalities: ["Image"],
        imageConfig,
      },
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelUsed}:generateContent`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    const rawText = await resp.text().catch(() => "");
    let rawJson: any = null;
    if (rawText) {
      try {
        rawJson = JSON.parse(rawText);
      } catch {
        rawJson = { _nonJson: rawText };
      }
    }

    if (!resp.ok) {
      await safeRefund(supabase, chargeId);
      return json(502, { error: "GEMINI_ERROR", modelUsed, details: rawJson?._nonJson ?? rawJson });
    }

    const picked = pickFirstImageFromGemini(rawJson);
    if (!picked) {
      await safeRefund(supabase, chargeId);
      return json(502, { error: "NO_IMAGE_RETURNED", modelUsed, raw: rawJson });
    }

    // 6) Save EXACT returned bytes (no server-side compression)
    const outBuf = Buffer.from(picked.base64, "base64");
    const outMime = picked.mimeType || "image/png";
    const ext =
      outMime.includes("jpeg") || outMime.includes("jpg") ? "jpg" : outMime.includes("webp") ? "webp" : "png";

    const resultUuid = crypto.randomUUID();
    const storagePath = `${user.id}/${resultUuid}.${ext}`;

    const upload = await supabase.storage.from(BUCKET).upload(storagePath, outBuf, {
      contentType: outMime,
      upsert: false,
    });

    if (upload.error) {
      await safeRefund(supabase, chargeId);
      return json(500, { error: "UPLOAD_FAILED", detail: upload.error.message });
    }

    const ins = await supabase
      .from("ai_results")
      .insert({
        user_id: user.id,
        kind: "image",
        model: modelType,
        storage_bucket: BUCKET,
        storage_path: storagePath,
        mime_type: outMime,
        bytes: outBuf.length,
        status: "ready",
        ready_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (ins.error || !ins.data?.id) {
      await supabase.storage.from(BUCKET).remove([storagePath]); // best-effort rollback
      await safeRefund(supabase, chargeId);
      return json(500, { error: "DB_INSERT_FAILED", detail: ins.error?.message || "UNKNOWN" });
    }

    const dbResultId = String(ins.data.id);

    // 7) Enforce history limit (no .catch chain to avoid TS error)
    const list = await supabase
      .from("ai_results")
      .select("id, storage_path, created_at")
      .eq("user_id", user.id)
      .eq("kind", "image")
      .order("created_at", { ascending: false });

    if (!list.error && Array.isArray(list.data) && list.data.length > MAX_IMAGES_PER_USER) {
      const toDelete = list.data.slice(MAX_IMAGES_PER_USER);
      const paths = toDelete.map((r: any) => r.storage_path).filter(Boolean) as string[];
      if (paths.length) await supabase.storage.from(BUCKET).remove(paths);

      const ids = toDelete.map((r: any) => r.id).filter(Boolean) as string[];
      if (ids.length) await supabase.from("ai_results").delete().in("id", ids);
    }

    // 8) Settle token spend
    await safeSettle(supabase, chargeId, dbResultId);

    // 9) Signed URL
    const signed = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);

    return NextResponse.json(
      {
        // ✅ 你要求：返图“不压缩”，所以直接把 Gemini 返回的 base64 给前端
        imageBase64: picked.base64,
        mimeType: outMime,
        modelUsed,
        resultId: dbResultId,
        storagePath,
        resultUrl: signed.data?.signedUrl || null,
        chargeId,
        cost,
        balance: newBalance,
      },
      { status: 200, headers: { "Cache-Control": "no-store", "X-Token-Balance": String(newBalance ?? "") } }
    );
  } catch (e: any) {
    if (String(e?.name) === "AbortError") {
      await safeRefund(supabase, chargeId);
      return json(504, { error: "MODEL_TIMEOUT" });
    }
    await safeRefund(supabase, chargeId);
    return json(500, { error: "ADV_COMBINE_FAILED", detail: String(e?.message ?? e) });
  }
}
