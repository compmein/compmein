import { NextResponse } from "next/server";

/**
 * Nano Banana Pro (Gemini 3 Pro Image Preview) — Advanced Combine
 *
 * POST multipart/form-data:
 * - image: File (png/jpg/webp)
 * - prompt: string
 * - (optional) aspectRatio: e.g. "16:9"
 * - (optional) imageSize: "1K" | "2K" | "4K"   (✅ default = 1K)
 *
 * Response JSON:
 * - { imageBase64: string, mimeType: string }
 */

export const runtime = "nodejs"; // needs Buffer

function badRequest(message: string, extra?: any) {
  return NextResponse.json({ error: message, extra }, { status: 400 });
}

function serverError(message: string, extra?: any) {
  return NextResponse.json({ error: message, extra }, { status: 500 });
}

/** ✅ Simple in-memory rate limit (good for dev/single instance). */
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

export async function POST(req: Request) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return serverError("Missing GEMINI_API_KEY in env.");

    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

    // ✅ rate limit: 6 requests / minute / IP
    if (!rateLimit(ip, 6, 60_000)) {
      return NextResponse.json(
        { error: "Too many requests. Please wait a bit and try again." },
        { status: 429 }
      );
    }

    const form = await req.formData();
    const file = form.get("image");
    const prompt = String(form.get("prompt") ?? "").trim();

    if (!prompt) return badRequest("Missing prompt.");
    if (!(file instanceof File)) return badRequest("Missing image file.");

    // ✅ basic protection (server-side)
    if (!/^image\/(png|jpeg|jpg|webp)$/.test(file.type)) {
      return badRequest("Unsupported image type. Use PNG/JPEG/WEBP.", {
        got: file.type,
      });
    }

    // ✅ size limit (avoid cost spikes / slow)
    const MAX_BYTES = 6 * 1024 * 1024; // 6MB
    if (file.size > MAX_BYTES) {
      return badRequest("Image too large (max 6MB).", { size: file.size });
    }

    const aspectRatio = String(form.get("aspectRatio") ?? "16:9");
    const imageSize = String(form.get("imageSize") ?? "1K"); // ✅ default 1K

    const bytes = await file.arrayBuffer();
    const base64 = Buffer.from(bytes).toString("base64");

    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      "gemini-3-pro-image-preview:generateContent";

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
        responseModalities: ["IMAGE"],
        imageConfig: {
          aspectRatio,
          imageSize,
        },
      },
    };

    // ✅ timeout protection
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
      return NextResponse.json(
        {
          error: "NanoBanana API failed",
          status: resp.status,
          details: txt,
        },
        { status: 502 }
      );
    }

    const data = await resp.json();

    // ✅ find first returned image
    const parts =
      data?.candidates?.[0]?.content?.parts ??
      data?.candidates?.[0]?.content?.[0]?.parts ??
      [];

    const imgPart = parts.find((p: any) => p?.inlineData?.data);
    const outBase64 = imgPart?.inlineData?.data as string | undefined;
    const outMime = imgPart?.inlineData?.mimeType || "image/png";

    if (!outBase64) {
      return NextResponse.json(
        { error: "No image returned from NanoBanana.", raw: data },
        { status: 502 }
      );
    }

    return NextResponse.json({ imageBase64: outBase64, mimeType: outMime });
  } catch (e: any) {
    // AbortController timeout case
    if (String(e?.name) === "AbortError") {
      return NextResponse.json(
        { error: "NanoBanana request timed out (30s). Please try again." },
        { status: 504 }
      );
    }

    return serverError("Unexpected error", {
      message: String(e?.message ?? e),
    });
  }
}
