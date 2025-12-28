"use client";

import { useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const valid = useMemo(() => /\S+@\S+\.\S+/.test(email), [email]);

async function sendLink() {
  if (!valid) return;
  setLoading(true);
  try {
    console.log("SUPABASE_URL =", process.env.NEXT_PUBLIC_SUPABASE_URL);
    console.log(
      "SUPABASE_KEY_PREFIX =",
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.slice(0, 10)
    );

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback?next=/create`,
      },
    });
    if (error) throw error;
    setSent(true);
  } catch (e: any) {
    console.error("OTP error:", e);
    alert(e?.message || "登录链接发送失败");
  } finally {
    setLoading(false);
  }
}


  return (
    <div className="mx-auto max-w-md space-y-4 rounded-3xl border bg-white p-8 shadow-sm">
      <h1 className="text-2xl font-semibold">登录</h1>
      <p className="text-sm text-neutral-600">输入邮箱，我们会发你一个登录链接（无需密码）。</p>

      <input
        className="w-full rounded-xl border px-3 py-2 text-sm"
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />

      <button
        className="w-full rounded-xl bg-neutral-900 px-4 py-2.5 text-sm text-white disabled:opacity-40"
        disabled={!valid || loading}
        onClick={sendLink}
      >
        {loading ? "发送中..." : "发送登录链接"}
      </button>

      {sent && (
        <div className="rounded-xl border bg-neutral-50 p-3 text-sm">
          已发送到 <b>{email}</b>，去邮箱点链接完成登录。
        </div>
      )}
    </div>
  );
}
