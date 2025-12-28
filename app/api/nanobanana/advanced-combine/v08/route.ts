import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

export const runtime = "nodejs";

/** 服务器端唯一真相：价格表（别信前端） */
const TOKEN_COSTS = {
  nano: 15,
  pro: 45,
} as const;

const buckets = new Map<string, number[]>();
function rateLimit(ip: string, limit = 10, windowMs = 60_000) {
  const now = Date.now();
  const arr = buckets.get(ip) ?? [];
  const recent = arr.filter((t) => now - t < windowMs);
  if (recent.length >= limit) return false;
  recent.push(now);
  buckets.set(ip, recent);
  return true;
}

function isImageFile(v: any): v is File {
  return (
    v instanceof File &&
    /^image\/(png|jpeg|jpg|webp)$/.test(v.type) &&
    v.size > 0
  );
}

async function fileToInlineData(file: File) {
  const bytes = await file.arrayBuffer();
  return {
    inlineData: {
      mimeType: file.type,
      data: Buffer.from(bytes).toString("base64"),
    },
  };
}

export async function POST(req: Request) {
  const cookieStore = await cookies();
  const toSet: Array<{ name: string; value: string; options?: any }> = [];

  const reply = (
    status: number,
    body: any,
    extra?: { headers?: Record<string, string> }
  ) => {
    const res = NextResponse.json(body, { status, headers: extra?.headers });
    toSet.forEach(({ name, value, options }) =>
      res.cookies.set(name, value, options)
    );
    return res;
  };

  try {
    const apiKey = process.env.GEMINI_API_KEY || process.env.NANOBANANA_API_KEY;
    if (!apiKey) return reply(500, { error: "Missing API KEY" });

    // 0) 轻量限流（保留你原本逻辑）
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    if (!rateLimit(ip, 10, 60_000))
      return reply(429, { error: "Too many requests" });

    // 1) 识别当前登录用户（cookie session）
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll: () => cookieStore.getAll(),
          setAll: (cookiesToSet) => cookiesToSet.forEach((c) => toSet.push(c)),
        },
      }
    );

    const { data: auth } = await supabase.auth.getUser();
    const user = auth?.user;
    if (!user) return reply(401, { error: "UNAUTH" });

    // 2) 读 formData（只能读一次）
    const form = await req.formData();

    const sceneRaw = form.get("image");
    const refRaw = form.get("refImage"); // ✅ 前端就是 refImage
    const prompt = String(form.get("prompt") ?? "").trim();
    const modelType = String(form.get("modelType") ?? "nano").trim(); // "nano" | "pro"
    const aspectRatio = String(form.get("aspectRatio") ?? "16:9").trim();
    const imageSize = String(form.get("imageSize") ?? "").trim(); // optional, only for pro

    // 3) ✅ 先校验（避免缺图也扣 token）
    if (!prompt) return reply(400, { error: "Missing prompt" });
    if (!isImageFile(sceneRaw))
      return reply(400, { error: "Missing scene image (field: image)" });

    const sceneFile = sceneRaw as File;
    const refFile = isImageFile(refRaw) ? (refRaw as File) : null;

    // basic limits (protect server memory)
    const MAX_BYTES = 6 * 1024 * 1024;
    if (sceneFile.size > MAX_BYTES)
      return reply(400, { error: "Scene image too large (max 6MB)" });
    if (refFile && refFile.size > MAX_BYTES)
      return reply(400, { error: "Ref image too large (max 6MB)" });

    // 4) ✅ 决定 cost（服务器端写死）
    const mt = modelType === "pro" ? "pro" : "nano";
    const cost = mt === "pro" ? TOKEN_COSTS.pro : TOKEN_COSTS.nano;

    // 5) ✅ 原子扣费（业务 API 内扣费，防绕过）
    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    );

    const { data: newBalance, error: spendErr } = await admin.rpc(
      "spend_tokens",
      {
        p_user: user.id,
        p_cost: cost,
      }
    );

    if (spendErr) {
      const msg = String(spendErr.message || "");
      if (msg.includes("NOT_ENOUGH_TOKENS")) {
        return reply(403, { error: "NOT_ENOUGH_TOKENS", cost });
      }
      return reply(500, { error: msg });
    }

    // 6) model mapping（保留你原本逻辑）
    const modelUsed =
      mt === "pro"
        ? "gemini-3-pro-image-preview"
        : "gemini-2.5-flash-image";

    // parts: text + Image1 + (optional) Image2
    const parts: any[] = [{ text: prompt }];
    parts.push(await fileToInlineData(sceneFile));
    if (refFile) parts.push(await fileToInlineData(refFile));

    const imageConfig: any =
      mt === "pro"
        ? {
            aspectRatio,
            ...(imageSize ? { imageSize } : {}),
          }
        : { aspectRatio }; // nano: don't send imageSize

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
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      // 这里暂不做“失败退款”（下一步我们可以补）
      return reply(502, {
        error: "Gemini request failed",
        details: txt,
        modelUsed,
      });
    }

    const data = await resp.json();
    const outPart = data?.candidates?.[0]?.content?.parts?.find(
      (p: any) => p?.inlineData?.data
    );

    if (!outPart) {
      return reply(502, { error: "No image returned", raw: data, modelUsed });
    }

    // ✅ 返回成功，同时把最新余额塞在 header（可选）
    return reply(
      200,
      {
        imageBase64: outPart.inlineData.data,
        mimeType: outPart.inlineData.mimeType || "image/png",
        modelUsed,
      },
      {
        headers: {
          "Cache-Control": "no-store",
          "X-Token-Balance": String(newBalance ?? ""),
        },
      }
    );
  } catch (e: any) {
    if (String(e?.name) === "AbortError") {
      return reply(504, {
        error: "Gemini request timed out (60s). Please try again.",
      });
    }
    console.error(e);
    return reply(500, { error: String(e?.message ?? e) });
  }
}
