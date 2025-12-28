import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * POST multipart/form-data:
 *  - image: File
 *  - prompt: string
 *  - (optional) aspectRatio: "1:1" | "16:9" | ...
 *  - (optional) modelType: "nano" | "pro"
 *  - (optional) imageSize: "1K" | "2K" | "4K"   (ONLY for pro; nano ignores it)
 */

const buckets = new Map<string, number[]>();
function rateLimit(ip: string, limit = 6, windowMs = 60_000) {
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

export async function POST(req: Request) {
  try {
    const apiKey = process.env.GEMINI_API_KEY || process.env.NANOBANANA_API_KEY;
    if (!apiKey) return json(500, { error: "Missing GEMINI_API_KEY in env." });

    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

    if (!rateLimit(ip, 6, 60_000)) {
      return json(429, { error: "Too many requests. Please wait and try again." });
    }

    const form = await req.formData();
    const file = form.get("image");
    const prompt = String(form.get("prompt") ?? "").trim();
    const aspectRatio = String(form.get("aspectRatio") ?? "16:9").trim();
    const modelType = String(form.get("modelType") ?? "nano").trim(); // "nano" | "pro"
    const imageSize = String(form.get("imageSize") ?? "1K").trim();

    if (!prompt) return json(400, { error: "Missing prompt." });
    if (!(file instanceof File)) return json(400, { error: "Missing image file." });

    if (!/^image\/(png|jpeg|jpg|webp)$/.test(file.type)) {
      return json(400, {
        error: "Unsupported image type. Use PNG/JPEG/WEBP.",
        got: file.type,
      });
    }

    const MAX_BYTES = 6 * 1024 * 1024;
    if (file.size > MAX_BYTES) {
      return json(400, { error: "Image too large (max 6MB).", size: file.size });
    }

    const modelUsed =
      modelType === "pro" ? "gemini-3-pro-image-preview" : "gemini-2.5-flash-image";

    // ✅ IMPORTANT: gemini-2.5-flash-image DOES NOT accept imageSize.
    // Only gemini-3-pro-image-preview supports imageSize (1K/2K/4K).
    const imageConfig =
      modelUsed === "gemini-3-pro-image-preview"
        ? { aspectRatio, imageSize }
        : { aspectRatio };

    const bytes = await file.arrayBuffer();
    const base64 = Buffer.from(bytes).toString("base64");

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelUsed}:generateContent`;

    const body = {
      contents: [
        {
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType: file.type,
                data: base64,
              },
            },
          ],
        },
      ],
      generationConfig: {
        // ✅ docs use "Image" casing for REST
        responseModalities: ["Image"],
        imageConfig,
      },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);

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
      return json(502, {
        error: "Gemini request failed",
        status: resp.status,
        details: txt,
        modelUsed,
        sentImageConfig: imageConfig,
      });
    }

    const data = await resp.json();

    const parts = data?.candidates?.[0]?.content?.parts ?? [];
    const imgPart = parts.find((p: any) => p?.inlineData?.data);

    const outBase64 = imgPart?.inlineData?.data as string | undefined;
    const outMime = imgPart?.inlineData?.mimeType || "image/png";

    if (!outBase64) {
      return json(502, { error: "No image returned.", modelUsed, raw: data });
    }

    return json(200, { imageBase64: outBase64, mimeType: outMime, modelUsed });
  } catch (e: any) {
    if (String(e?.name) === "AbortError") {
      return json(504, { error: "Gemini request timed out (30s). Please try again." });
    }
    return json(500, { error: "Unexpected error", message: String(e?.message ?? e) });
  }
}
