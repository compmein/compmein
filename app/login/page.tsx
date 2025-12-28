"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabaseClient";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [shouldCreateUser, setShouldCreateUser] = useState(true);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function sendLink() {
    setErr(null);
    setMsg(null);

    const trimmed = email.trim();
    if (!trimmed) {
      setErr("请输入邮箱。");
      return;
    }

    // 统一走 callback，再由 callback 跳到 /create
    const redirectTo = `${window.location.origin}/auth/callback?next=/create`;

    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: trimmed,
        options: {
          emailRedirectTo: redirectTo,
          // ✅ 是否允许“首次登录自动注册”
          shouldCreateUser,
        },
      });

      if (error) {
        setErr(error.message || "发送失败，请稍后再试。");
      } else {
        setMsg(`已发送到 ${trimmed}，去邮箱点链接完成登录。`);
      }
    } catch (e: any) {
      setErr(e?.message || "网络错误：Failed to fetch");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-[80vh] flex items-center justify-center px-4">
      <div className="w-full max-w-md rounded-3xl border bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold mb-3">登录</h1>
        <p className="text-sm text-gray-600 mb-6">
          输入邮箱，我们会发你一个登录链接（无需密码）。
        </p>

        <label className="text-sm font-medium">邮箱</label>
        <input
          className="mt-2 w-full rounded-xl border px-4 py-3 outline-none focus:ring-2"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
        />

        <div className="mt-4 flex items-center gap-2 text-sm">
          <input
            id="createUser"
            type="checkbox"
            checked={shouldCreateUser}
            onChange={(e) => setShouldCreateUser(e.target.checked)}
          />
          <label htmlFor="createUser" className="select-none">
            允许自动创建新用户（首次登录也能直接注册）
          </label>
        </div>

        <button
          onClick={sendLink}
          disabled={loading}
          className="mt-5 w-full rounded-xl bg-black py-3 text-white disabled:opacity-50"
        >
          {loading ? "发送中..." : "发送登录链接"}
        </button>

        {err && (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {err}
          </div>
        )}
        {msg && (
          <div className="mt-4 rounded-xl border border-green-200 bg-green-50 p-3 text-sm text-green-800">
            {msg}
          </div>
        )}

        <div className="mt-6 text-xs text-gray-500">
          如果你只想“仅允许已存在用户登录”，把上面“自动创建新用户”关掉即可。
        </div>
      </div>
    </div>
  );
}
