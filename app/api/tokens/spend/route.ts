import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

const COSTS = {
  CUTOUT: 1,
  QUICK: 15,
  PRO: 45,
} as const;

type Action = keyof typeof COSTS;

export async function POST(req: Request) {
  const cookieStore = await cookies();

  const toSet: Array<{ name: string; value: string; options?: any }> = [];

  // ✅ 用户态：从 cookie 识别当前是谁
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach((c) => toSet.push(c));
        },
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

  const body = await req.json().catch(() => ({}));
  const action = body?.action as Action | undefined;

  if (!action || !(action in COSTS)) {
    const res = NextResponse.json({ error: "BAD_ACTION" }, { status: 400 });
    toSet.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
    return res;
  }

  const cost = COSTS[action];

  // ✅ 管理态：用 service role 扣 token（绕过 RLS，只有服务器能扣）
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  const { data, error } = await admin.rpc("spend_tokens", {
    p_user: user.id,
    p_cost: cost,
  });

  if (error) {
    const msg = String(error.message || "");
    const res =
      msg.includes("NOT_ENOUGH_TOKENS")
        ? NextResponse.json({ error: "NOT_ENOUGH_TOKENS", cost }, { status: 403 })
        : NextResponse.json({ error: msg }, { status: 500 });

    toSet.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
    return res;
  }

  const res = NextResponse.json({ ok: true, action, cost, balance: data });
  toSet.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
  return res;
}
