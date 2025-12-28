import { NextResponse } from "next/server";

/**
 * Nano Banana / Nano Banana Pro — Advanced Combine
 *
 * POST multipart/form-data:
 * - image: File (png/jpg/webp)  // usually the "combined input" image you built on frontend
 * - prompt: string
 * - (optional) modelType: "nano" | "pro"   (default: "nano")
 * - (optional) aspectRatio: e.g. "16:9"
 * - (optional) imageSize: "1K" | "2K" | "4K"   (default: "1K"; Pro supports 2K/4K)
 *
 * Response JSON:
 * - { imageBase64: string, mimeType: string, modelUsed: string }
 */

export const runtime = "nodejs"; // Buffer

function badRequest(message: string, extra?: any) {
  return NextResponse.json({ error: message, extra }, { status: 400 });
}
function serverError(message: string, extra?: any) {
  return NextResponse.json({ error: message, extra }, { status: 500 });
}

/** Simple in-memory rate limit (dev-friendly). */
const buckets = new Map<string, number[]>();
function allow(ip: string, limit = 12, windowMs = 60_000) {
  const now = Date.now();
  const arr = buckets.get(ip) ?? [];
  const fresh = arr.filter((t) => now - t < windowMs);
  if (fresh.length >= limit) return false;
  fresh.push(now);
  buckets.set(ip, fresh);
  return true;
}

function getIp(req: Request) {
  const xf = req.headers.get("x-forwarded-for");
  if (xf) return xf.split(",")[0]?.trim() || "unknown";
  return req.headers.get("x-real-ip") || "unknown";
}

function toBase64(buf: ArrayBuffer) {
  return Buffer.from(buf).toString("base64");
}

function pickFirstInlineImage(candidate: any): { data: string; mimeType: string } | null {
  const parts = candidate?.content?.parts ?? [];
  for (const p of parts) {
    if (p?.inlineData?.data) {
      return {
        data: String(p.inlineData.data),
        mimeType: String(p.inlineData.mimeType || "image/png"),
      };
    }
  }
  return null;
}

export async function POST(req: Request) {
  const ip = getIp(req);
  if (!allow(ip)) {
    return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });
  }

  const apiKey = process.env.GEMINI_API_KEY || process.env.NANOBANANA_API_KEY;
  if (!apiKey) {
    return serverError("Missing API key. Set GEMINI_API_KEY (recommended) in .env.local");
  }

  try {
    const fd = await req.formData();

    const image = fd.get("image");
    const prompt = String(fd.get("prompt") || "").trim();
    const modelType = (String(fd.get("modelType") || "nano").toLowerCase() as "nano" | "pro");
    const aspectRatio = String(fd.get("aspectRatio") || "16:9");
    const imageSize = String(fd.get("imageSize") || "1K").toUpperCase(); // 1K/2K/4K

    if (!image || !(image instanceof Blob)) return badRequest("Missing 'image' file");
    if (!prompt) return badRequest("Missing 'prompt'");

    // Model mapping:
    // - Nano Banana (cheaper): gemini-2.5-flash-image
    // - Nano Banana Pro (stronger): gemini-3-pro-image-preview
    const modelUsed =
      modelType === "pro" ? "gemini-3-pro-image-preview" : "gemini-2.5-flash-image";

    // Read image -> base64
    const buf = await image.arrayBuffer();
    const base64 = toBase64(buf);
    const mimeType = image.type || "image/png";

    const body: any = {
      contents: [
        {
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType,
                data: base64,
              },
            },
          ],
        },
      ],
      generationConfig: {
        // Ask for IMAGE output
        responseModalities: ["IMAGE"],
        imageConfig: {
          aspectRatio,
          // Only Pro officially supports imageSize (1K/2K/4K). Sending it for nano is harmless.
          imageSize,
        },
      },
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelUsed}:generateContent`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!resp.ok) {
      const txt = await resp.text();
      return NextResponse.json(
        { error: "Gemini request failed", status: resp.status, details: txt, modelUsed },
        { status: 502 }
      );
    }

    const json = await resp.json();

    const candidate = json?.candidates?.[0];
    const img = pickFirstInlineImage(candidate);

    if (!img) {
      return NextResponse.json(
        { error: "No image returned from model", raw: json, modelUsed },
        { status: 502 }
      );
    }

    return NextResponse.json({
      imageBase64: img.data,
      mimeType: img.mimeType,
      modelUsed,
    });
  } catch (e: any) {
    if (String(e?.name) === "AbortError") {
      return NextResponse.json(
        { error: "NanoBanana request timed out (30s). Please try again." },
        { status: 504 }
      );
    }
    return serverError("Unexpected error", { message: String(e?.message ?? e) });
  }
}
