import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function GET() {
  const cookieStore = await cookies();

  // ✅ 收集 supabase 想写回的 cookies，最后统一塞进 response
  const toSet: Array<{ name: string; value: string; options?: any }> = [];

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

  const { data: auth, error: authErr } = await supabase.auth.getUser();
  const user = auth?.user;

  if (authErr || !user) {
    const res = NextResponse.json({ error: "UNAUTH" }, { status: 401 });
    toSet.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
    return res;
  }

  const { data, error } = await supabase
    .from("user_tokens")
    .select("balance")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    const res = NextResponse.json({ error: error.message }, { status: 500 });
    toSet.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
    return res;
  }

  const res = NextResponse.json({ balance: data?.balance ?? 0 });
  toSet.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
  return res;
}
