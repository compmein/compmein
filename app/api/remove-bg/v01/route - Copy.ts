import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const image = formData.get("image");

    if (!image || !(image instanceof File)) {
      return NextResponse.json(
        { error: "No image uploaded" },
        { status: 400 }
      );
    }

    const apiKey = process.env.REMOVE_BG_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Missing REMOVE_BG_API_KEY" },
        { status: 500 }
      );
    }

    const fd = new FormData();
    fd.append("image_file", image);
    fd.append("size", "auto");

    const resp = await fetch("https://api.remove.bg/v1.0/removebg", {
      method: "POST",
      headers: {
        "X-Api-Key": apiKey,
      },
      body: fd,
    });

    if (!resp.ok) {
      const text = await resp.text();
      return new NextResponse(text, { status: resp.status });
    }

    const blob = await resp.blob();
    return new NextResponse(blob, {
      headers: {
        "Content-Type": "image/png",
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Unknown error" },
      { status: 500 }
    );
  }
}
