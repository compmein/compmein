import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import crypto from "crypto";

export const runtime = "nodejs";

const BUCKET = "ai-results";
const MAX_IMAGES_PER_USER = 10;
const SIGNED_URL_TTL_SECONDS = 60;

const COSTS = {
  nano: 15,
  pro: 45,
} as const;

type ModelType = "nano" | "pro";

function reply(status: number, body: any, headers?: Record<string, string>) {
  return NextResponse.json(body, { status, headers });
}

function isImageFile(v: any): v is File {
  return (
    v instanceof File &&
    (
      (typeof v.type === "string" && v.type.startsWith("image/")) ||
      (typeof v.name === "string" && /\.(png|jpe?g|webp)$/i.test(v.name))
    )
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

async function safeRefund(supabase: any, chargeId: string) {
  const { error } = await supabase.rpc("refund_charge", { p_charge_id: chargeId });
  // 已结算/已退款等都忽略
  if (error) {
    // console.warn("refund_charge:", error.message);
  }
}

async function safeSettle(supabase: any, chargeId: string, resultId: string) {
  const { error } = await supabase.rpc("settle_charge", { p_charge_id: chargeId, p_result_id: resultId });
  if (error) {
    // console.warn("settle_charge:", error.message);
  }
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

export async function POST(req: Request) {
  // 1) form-data
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
  const imageSize = String(form.get("imageSize") ?? "").trim(); // pro 可选

  if (!prompt) return reply(400, { error: "Missing prompt" });
  if (!isImageFile(sceneRaw)) return reply(400, { error: "Missing scene image (field: image)" });

  const sceneFile = sceneRaw as File;
  const refFile = isImageFile(refRaw) ? (refRaw as File) : null;

  // 保护服务器内存：限制输入文件大小（你 old 里就有类似逻辑）
  const MAX_BYTES = 6 * 1024 * 1024;
  if (sceneFile.size > MAX_BYTES) return reply(413, { error: "Scene image too large (max 6MB)" });
  if (refFile && refFile.size > MAX_BYTES) return reply(413, { error: "Reference image too large (max 6MB)" });

  if (modelType !== "nano" && modelType !== "pro") return reply(400, { error: "BAD_MODELTYPE" });

  const mt = modelType;
  const cost = COSTS[mt];

  // 2) Supabase server client（基于当前登录用户 cookie session）
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
  if (userErr || !user) return reply(401, { error: "UNAUTH" });

  // 3) 扣费（原子）-> ledger pending
  let chargeId = "";
  let newBalance = 0;

  {
    const { data, error } = await supabase.rpc("spend_tokens_with_ledger", {
      p_user: user.id,
      p_cost: cost,
      p_action: mt === "pro" ? "AI_PRO" : "AI_QUICK",
    });

    if (error) {
      const msg = String(error.message || error);
      if (msg.includes("NOT_ENOUGH_TOKENS")) return reply(403, { error: "NOT_ENOUGH_TOKENS", cost });
      return reply(500, { error: "SPEND_FAILED", detail: msg });
    }

    const row = Array.isArray(data) ? data[0] : data;
    chargeId = String(row?.charge_id || "");
    newBalance = Number(row?.new_balance ?? row?.balance ?? 0);
    if (!chargeId) return reply(500, { error: "SPEND_FAILED_NO_CHARGE_ID" });
  }

  // 4) 调用你 old 里验证可用的 image 模型（不改 .env）
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    await safeRefund(supabase, chargeId);
    return reply(500, { error: "MISSING_GEMINI_KEY" });
  }

  const modelUsed =
    mt === "pro"
      ? "gemini-3-pro-image-preview"
      : "gemini-2.5-flash-image";

  try {
    const parts: any[] = [{ text: prompt }];
    parts.push(await fileToInlineData(sceneFile));
    if (refFile) parts.push(await fileToInlineData(refFile));

    // old 逻辑：pro 才带 imageSize
    const imageConfig: any =
      mt === "pro"
        ? { aspectRatio, ...(imageSize ? { imageSize } : {}) }
        : { aspectRatio };

    const body = {
      contents: [{ parts }],
      generationConfig: {
        responseModalities: ["Image"], // ✅ 保持 old（你验证过可用）
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

    // ✅ 修复点：先读 text，再尝试 JSON（避免 Unexpected end of JSON input）
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
      return reply(502, {
        error: "GEMINI_ERROR",
        modelUsed,
        details: rawJson?._nonJson ? rawJson._nonJson : rawJson,
      });
    }

    const picked = pickFirstImageFromGemini(rawJson);
    if (!picked) {
      await safeRefund(supabase, chargeId);
      return reply(502, { error: "NO_IMAGE_RETURNED", modelUsed, raw: rawJson });
    }

    // 5) 存 Storage（Private）
    const outMime = picked.mimeType || "image/png";
    const ext = outMime.includes("jpeg") ? "jpg" : outMime.includes("webp") ? "webp" : "png";

    const localResultId = crypto.randomUUID();
    const storagePath = `${user.id}/${localResultId}.${ext}`;
    const outBuf = Buffer.from(picked.base64, "base64");

    const upload = await supabase.storage.from(BUCKET).upload(storagePath, outBuf, {
      contentType: outMime,
      upsert: false,
    });

    if (upload.error) {
      await safeRefund(supabase, chargeId);
      return reply(500, { error: "UPLOAD_FAILED", detail: upload.error.message });
    }

    // 6) 写 ai_results
    const ins = await supabase
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
        ready_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (ins.error || !ins.data?.id) {
      // 回滚文件 + 退款
      const { error: rmErr } = await supabase.storage.from(BUCKET).remove([storagePath]);
      if (rmErr) {
        // console.warn("rollback remove failed:", rmErr.message);
      }
      await safeRefund(supabase, chargeId);
      return reply(500, { error: "DB_INSERT_FAILED", detail: ins.error?.message || "UNKNOWN" });
    }

    const dbResultId = String(ins.data.id);

    // 7) enforce：只保留最近 10 张
    const list = await supabase
      .from("ai_results")
      .select("id, storage_path, created_at")
      .eq("user_id", user.id)
      .eq("kind", "image")
      .order("created_at", { ascending: false });

    if (!list.error && Array.isArray(list.data) && list.data.length > MAX_IMAGES_PER_USER) {
      const toDelete = list.data.slice(MAX_IMAGES_PER_USER);
      const paths = toDelete.map((r: any) => r.storage_path).filter(Boolean) as string[];
      if (paths.length) {
        const { error: rmOldErr } = await supabase.storage.from(BUCKET).remove(paths);
        if (rmOldErr) {
          // console.warn("remove old files:", rmOldErr.message);
        }
      }
      const ids = toDelete.map((r: any) => r.id).filter(Boolean) as string[];
      if (ids.length) {
        const { error: delErr } = await supabase.from("ai_results").delete().in("id", ids);
        if (delErr) {
          // console.warn("delete old rows:", delErr.message);
        }
      }
    }

    // 8) settle（只有成功落库才结算，防钻）
    await safeSettle(supabase, chargeId, dbResultId);

    // 9) signed url（短时）
    const signed = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);

    return reply(
      200,
      {
        imageBase64: picked.base64, // ✅ 兼容你现有前端
        mimeType: outMime,
        modelUsed,
        resultId: dbResultId,
        storagePath,
        resultUrl: signed.data?.signedUrl || null,
        chargeId,
        cost,
        balance: newBalance,
      },
      {
        "Cache-Control": "no-store",
        "X-Token-Balance": String(newBalance ?? ""),
      }
    );
  } catch (e: any) {
    if (String(e?.name) === "AbortError") {
      await safeRefund(supabase, chargeId);
      return reply(504, { error: "MODEL_TIMEOUT" });
    }
    await safeRefund(supabase, chargeId);
    return reply(500, { error: "ADV_COMBINE_FAILED", detail: String(e?.message ?? e) });
  }
}
