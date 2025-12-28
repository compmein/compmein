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

function json(status: number, body: any) {
  return NextResponse.json(body, { status });
}

async function generateImageNanoBanana(args: {
  imageBase64: string;
  refBase64?: string;
  prompt: string;
  modelType: ModelType;
}) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("MISSING_GEMINI_KEY");

  // ✅ 这里完全沿用你 old route 的模型，不碰 env
  const model =
    args.modelType === "pro"
      ? "nano-banana-pro"
      : "nano-banana";

  const resp = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/" +
      model +
      ":generateImage",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        prompt: args.prompt,
        image: args.imageBase64,
        referenceImage: args.refBase64 ?? null,
        responseModalities: ["IMAGE"],
        imageConfig: {
          numberOfImages: 1,
        },
      }),
    }
  );

  const data = await resp.json();

  if (!resp.ok || !data?.images?.[0]?.base64) {
    return { ok: false as const, raw: data };
  }

  return {
    ok: true as const,
    imageBase64: data.images[0].base64,
    mimeType: "image/png",
  };
}

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(400, { error: "BAD_FORMDATA" });
  }

  const image = form.get("image");
  const refImage = form.get("refImage");
  const prompt = String(form.get("prompt") || "").trim();
  const modelType = String(form.get("modelType") || "nano") as ModelType;

  if (!(image instanceof File)) return json(400, { error: "MISSING_IMAGE" });
  if (!prompt) return json(400, { error: "MISSING_PROMPT" });

  const cost = COSTS[modelType];

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
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        },
      },
    }
  );

  const { data: auth } = await supabase.auth.getUser();
  const user = auth?.user;
  if (!user) return json(401, { error: "UNAUTH" });

  // 1️⃣ 扣费（pending）
  const { data: spend, error: spendErr } = await supabase.rpc(
    "spend_tokens_with_ledger",
    {
      p_user: user.id,
      p_cost: cost,
      p_action: modelType === "pro" ? "AI_PRO" : "AI_QUICK",
    }
  );

  if (spendErr) return json(403, { error: "SPEND_FAILED" });

  const chargeId = spend[0].charge_id;

  try {
    const base64 = Buffer.from(await image.arrayBuffer()).toString("base64");
    const refBase64 =
      refImage instanceof File
        ? Buffer.from(await refImage.arrayBuffer()).toString("base64")
        : undefined;

    // 2️⃣ 调 Nano Banana（和 old 一致）
    const gen = await generateImageNanoBanana({
      imageBase64: base64,
      refBase64,
      prompt,
      modelType,
    });

    if (!gen.ok) {
      await supabase.rpc("refund_charge", { p_charge_id: chargeId });
      return json(500, { error: "GEN_FAILED", raw: gen.raw });
    }

    // 3️⃣ 存 Storage
    const resultId = crypto.randomUUID();
    const path = `${user.id}/${resultId}.png`;
    const buf = Buffer.from(gen.imageBase64, "base64");

    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, buf, { contentType: "image/png" });

    if (upErr) {
      await supabase.rpc("refund_charge", { p_charge_id: chargeId });
      return json(500, { error: "UPLOAD_FAILED" });
    }

    // 4️⃣ 写 ai_results
    const { data: row, error: insErr } = await supabase
      .from("ai_results")
      .insert({
        user_id: user.id,
        kind: "image",
        model: modelType,
        storage_bucket: BUCKET,
        storage_path: path,
        status: "ready",
      })
      .select("id")
      .single();

    if (insErr) {
      await supabase.storage.from(BUCKET).remove([path]);
      await supabase.rpc("refund_charge", { p_charge_id: chargeId });
      return json(500, { error: "DB_FAILED" });
    }

    // 5️⃣ settle
    await supabase.rpc("settle_charge", {
      p_charge_id: chargeId,
      p_result_id: row.id,
    });

    return json(200, {
      imageBase64: gen.imageBase64,
      resultId: row.id,
      cost,
    });
  } catch (e: any) {
    await supabase.rpc("refund_charge", { p_charge_id: chargeId });
    return json(500, { error: "ADV_COMBINE_FAILED", detail: String(e) });
  }
}
