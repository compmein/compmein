import { NextResponse } from "next/server";

export const runtime = "nodejs";

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

function json(status: number, body: any) {
  return NextResponse.json(body, { status });
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
  try {
    const apiKey = process.env.GEMINI_API_KEY || process.env.NANOBANANA_API_KEY;
    if (!apiKey) return json(500, { error: "Missing API KEY" });

    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    if (!rateLimit(ip, 10, 60_000))
      return json(429, { error: "Too many requests" });

    const form = await req.formData();

    const sceneRaw = form.get("image");
    const refRaw = form.get("refImage");
    const prompt = String(form.get("prompt") ?? "").trim();
    const modelType = String(form.get("modelType") ?? "nano").trim(); // "nano" | "pro"
    const aspectRatio = String(form.get("aspectRatio") ?? "16:9").trim();
    const imageSize = String(form.get("imageSize") ?? "").trim(); // optional, only for pro

    if (!prompt) return json(400, { error: "Missing prompt" });
    if (!isImageFile(sceneRaw))
      return json(400, { error: "Missing scene image" });

    const sceneFile = sceneRaw as File;
    const refFile = isImageFile(refRaw) ? (refRaw as File) : null;

    // basic limits (protect server memory)
    const MAX_BYTES = 6 * 1024 * 1024;
    if (sceneFile.size > MAX_BYTES)
      return json(400, { error: "Scene image too large (max 6MB)" });
    if (refFile && refFile.size > MAX_BYTES)
      return json(400, { error: "Ref image too large (max 6MB)" });

    // model mapping
    const modelUsed =
      modelType === "pro" ? "gemini-3-pro-image-preview" : "gemini-2.5-flash-image";

    // parts: text + Image1 + (optional) Image2
    const parts: any[] = [{ text: prompt }];
    parts.push(await fileToInlineData(sceneFile));
    if (refFile) parts.push(await fileToInlineData(refFile));

    const imageConfig: any =
      modelType === "pro"
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
      return json(502, { error: "Gemini request failed", details: txt, modelUsed });
    }

    const data = await resp.json();
    const outPart = data?.candidates?.[0]?.content?.parts?.find(
      (p: any) => p?.inlineData?.data
    );

    if (!outPart) return json(502, { error: "No image returned", raw: data, modelUsed });

    return json(200, {
      imageBase64: outPart.inlineData.data,
      mimeType: outPart.inlineData.mimeType || "image/png",
      modelUsed,
    });
  } catch (e: any) {
    if (String(e?.name) === "AbortError") {
      return json(504, { error: "Gemini request timed out (60s). Please try again." });
    }
    console.error(e);
    return json(500, { error: String(e?.message ?? e) });
  }
}
