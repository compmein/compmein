import { NextResponse } from "next/server";

/**
 * Nano Banana Pro (Gemini 3 Pro Image Preview) — Advanced Combine
 *
 * ✅ 你说的逻辑：发给 NanoBanana 的是「一张图」：
 * - 没有 reference：前端直接下载，不走这个 API
 * - 有 reference：前端把“合成画布 + 右侧 reference 面板”一起导出成一张 PNG/JPG，连同 prompt 发给本 API
 *
 * POST multipart/form-data:
 * - image: File (png/jpg/webp)
 * - prompt: string
 * - (optional) aspectRatio: e.g. "16:9"
 * - (optional) imageSize: "1K" | "2K" | "4K"
 *
 * Response JSON:
 * - { imageBase64: string, mimeType: string }
 */

export const runtime = "nodejs"; // 需要 Buffer

function badRequest(message: string, extra?: any) {
  return NextResponse.json({ error: message, extra }, { status: 400 });
}

function serverError(message: string, extra?: any) {
  return NextResponse.json({ error: message, extra }, { status: 500 });
}

export async function POST(req: Request) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return serverError("Missing GEMINI_API_KEY in env.");

    const form = await req.formData();
    const file = form.get("image");
    const prompt = String(form.get("prompt") ?? "").trim();

    if (!prompt) return badRequest("Missing prompt.");
    if (!(file instanceof File)) return badRequest("Missing image file.");

    // 你前端已经做了 1080p 压缩；这里仍做一次基本保护
    if (!/^image\/(png|jpeg|jpg|webp)$/.test(file.type)) {
      return badRequest("Unsupported image type. Use PNG/JPEG/WEBP.", {
        got: file.type,
      });
    }

    const aspectRatio = String(form.get("aspectRatio") ?? "16:9");
    const imageSize = String(form.get("imageSize") ?? "2K"); // 默认 2K

    const bytes = await file.arrayBuffer();
    const base64 = Buffer.from(bytes).toString("base64");

    // ✅ Gemini API: models/gemini-3-pro-image-preview:generateContent
    // 文档：支持 text+image 输入，返回 inlineData 图片
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

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

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

    // ✅ 找第一张返回图片
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
    return serverError("Unexpected error", { message: String(e?.message ?? e) });
  }
}
