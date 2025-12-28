import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const image = formData.get("image");

    if (!image || !(image instanceof File)) {
      return NextResponse.json({ error: "No image uploaded (field name should be 'image')" }, { status: 400 });
    }

    const token = process.env.REPLICATE_API_TOKEN;
    if (!token) {
      return NextResponse.json({ error: "Missing REPLICATE_API_TOKEN" }, { status: 500 });
    }

    // File -> data URL
    const buf = Buffer.from(await image.arrayBuffer());
    const mime = image.type?.startsWith("image/") ? image.type : "image/png";
    const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;

    // 851-labs/background-remover (model output is a PNG url)
    const version = "a029dff38972b5fda4ec5d75d7d1cd25aeff621d2cf4946a41055d7db66b80bc";

    const createResp = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Prefer: "wait", // sync wait
      },
      body: JSON.stringify({
        version,
        input: {
          image: dataUrl,
          // some models accept these; harmless if ignored
          format: "png",
        },
      }),
    });

    if (!createResp.ok) {
      const text = await createResp.text();
      return new NextResponse(text, { status: createResp.status });
    }

    const prediction = (await createResp.json()) as any;
    if (prediction?.status !== "succeeded" || typeof prediction?.output !== "string") {
      return NextResponse.json(
        { error: "Replicate prediction not succeeded", status: prediction?.status, detail: prediction?.error ?? null },
        { status: 502 }
      );
    }

    const outResp = await fetch(prediction.output);
    if (!outResp.ok) {
      const text = await outResp.text();
      return NextResponse.json({ error: "Failed to download output PNG", detail: text }, { status: 502 });
    }

    const outBlob = await outResp.blob();
    return new NextResponse(outBlob, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "no-store",
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}
