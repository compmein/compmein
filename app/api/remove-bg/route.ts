import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

export const runtime = "nodejs";

const COST_CUTOUT = 1;

export async function POST(req: Request) {
  const cookieStore = await cookies();
  const toSet: Array<{ name: string; value: string; options?: any }> = [];

  // 1) 识别当前用户（从 cookie session）
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
  if (!user) {
    const res = NextResponse.json({ error: "UNAUTH" }, { status: 401 });
    toSet.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
    return res;
  }

  // 2) 先扣费（原子扣费，防并发刷）
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  const { data: newBalance, error: spendErr } = await admin.rpc("spend_tokens", {
    p_user: user.id,
    p_cost: COST_CUTOUT,
  });

  if (spendErr) {
    const msg = String(spendErr.message || "");
    const res =
      msg.includes("NOT_ENOUGH_TOKENS")
        ? NextResponse.json({ error: "NOT_ENOUGH_TOKENS", cost: COST_CUTOUT }, { status: 403 })
        : NextResponse.json({ error: msg }, { status: 500 });

    toSet.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
    return res;
  }

  // 3) 扣费成功后才执行真正抠图逻辑
  try {
    const formData = await req.formData();
    const image = formData.get("image");

    if (!image || !(image instanceof File)) {
      const res = NextResponse.json(
        { error: "No image uploaded (field name should be 'image')" },
        { status: 400 }
      );
      toSet.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
      return res;
    }

    const token = process.env.REPLICATE_API_TOKEN;
    if (!token) {
      const res = NextResponse.json({ error: "Missing REPLICATE_API_TOKEN" }, { status: 500 });
      toSet.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
      return res;
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
        Prefer: "wait",
      },
      body: JSON.stringify({
        version,
        input: { image: dataUrl, format: "png" },
      }),
    });

    if (!createResp.ok) {
      const text = await createResp.text();
      const res = new NextResponse(text, { status: createResp.status });
      toSet.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
      return res;
    }

    const prediction = (await createResp.json()) as any;
    if (prediction?.status !== "succeeded" || typeof prediction?.output !== "string") {
      const res = NextResponse.json(
        {
          error: "Replicate prediction not succeeded",
          status: prediction?.status,
          detail: prediction?.error ?? null,
        },
        { status: 502 }
      );
      toSet.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
      return res;
    }

    const outResp = await fetch(prediction.output);
    if (!outResp.ok) {
      const text = await outResp.text();
      const res = NextResponse.json({ error: "Failed to download output PNG", detail: text }, { status: 502 });
      toSet.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
      return res;
    }

    const outBlob = await outResp.blob();
    const res = new NextResponse(outBlob, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "no-store",
        // 可选：把扣费后的余额带回前端（以后你想做“自动刷新余额”会更爽）
        "X-Token-Balance": String(newBalance ?? ""),
      },
    });

    toSet.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
    return res;
  } catch (err: any) {
    const res = NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
    toSet.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
    return res;
  }
}
