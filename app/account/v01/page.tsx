"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";
import { useTokenBalance } from "@/app/create/useTokenBalance"; // 如果你的 hook 路径不同，改成实际路径

function shortId(id: string) {
  if (!id) return "";
  return `${id.slice(0, 8)}…${id.slice(-6)}`;
}

export default function AccountPage() {
  const [email, setEmail] = useState<string | null>(null);
  const [uid, setUid] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  const { balance, isReady } = useTokenBalance();

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      const user = data.session?.user ?? null;

      if (!user) {
        // 没登录就送回 login
        window.location.href = "/login";
        return;
      }

      setEmail(user.email ?? null);
      setUid(user.id);
      setChecking(false);
    })();
  }, []);

  const tokenText = useMemo(() => {
    if (!isReady) return "Loading…";
    return String(balance);
  }, [isReady, balance]);

  const onSignOut = async () => {
    await supabase.auth.signOut();
    window.location.href = "/login";
  };

  if (checking) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <div className="text-sm text-neutral-600">Loading account…</div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Account</h1>
          <div className="mt-1 text-sm text-neutral-600">
            {email ?? "Unknown email"} {uid ? `· ${shortId(uid)}` : ""}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Link
            href="/create"
            className="rounded-xl border border-neutral-200 px-3 py-2 text-sm hover:bg-neutral-50"
          >
            Back to Create
          </Link>
          <button
            onClick={onSignOut}
            className="rounded-xl bg-neutral-900 px-3 py-2 text-sm text-white hover:opacity-90"
          >
            Sign out
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-neutral-200 p-5">
        <div className="text-sm text-neutral-600">Token Balance</div>
        <div className="mt-1 text-3xl font-semibold">{tokenText}</div>
        <div className="mt-2 text-xs text-neutral-500">
          Tokens are currently stored per-account in your browser (localStorage).
          (DB/Payment 接入后这里会升级到云端余额)
        </div>
      </div>

      <div className="mt-6 rounded-2xl border border-neutral-200 p-5">
        <div className="text-base font-semibold">Buy Tokens</div>
        <div className="mt-2 text-sm text-neutral-600">
          这里先放占位（你接 Stripe/Paddle 后我给你补完整购买流程）。
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {[
            { title: "Starter", price: "$1.99", tokens: "120" },
            { title: "Value", price: "$9.99", tokens: "800" },
            { title: "Pro", price: "$29.99", tokens: "2800" },
          ].map((p) => (
            <div key={p.title} className="rounded-2xl border border-neutral-200 p-4">
              <div className="font-semibold">{p.title}</div>
              <div className="mt-1 text-sm text-neutral-600">
                {p.price} · {p.tokens} tokens
              </div>
              <button
                disabled
                className="mt-3 w-full rounded-xl bg-neutral-900 px-3 py-2 text-sm text-white opacity-40"
                title="Coming soon"
              >
                Coming soon
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
