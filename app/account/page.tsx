"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";
import { useTokenBalance } from "../components/useTokenBalance";

function shortId(id: string) {
  if (!id) return "";
  return `${id.slice(0, 8)}…${id.slice(-6)}`;
}

type Plan = {
  key: string;
  title: string;
  price: string;
  tokens: number;
  priceId: string; // Stripe price_...
};

export default function AccountPage() {
  const [email, setEmail] = useState<string | null>(null);
  const [uid, setUid] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  const { balance, isReady } = useTokenBalance();

  const [buyingKey, setBuyingKey] = useState<string | null>(null);
  const [buyError, setBuyError] = useState<string | null>(null);

  // ✅ 用你刚给我的真实 priceId
  const plans: Plan[] = [
    { key: "starter", title: "Starter", price: "$1.99", tokens: 120, priceId: "price_1SimQWJXUXYOjGjwUDA8mMC5" },
    { key: "value", title: "Value", price: "$9.99", tokens: 800, priceId: "price_1SimQ1JXUXYOjGjwDyeODYvE" },
    { key: "pro", title: "Pro", price: "$29.99", tokens: 2800, priceId: "price_1SimOtJXUXYOjGjw3uztzGm5" },
    { key: "ultra", title: "Ultra", price: "$49.99", tokens: 5000, priceId: "price_1SimLRJXUXYOjGjwEsrXuc2s" },
  ];

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      const user = data.session?.user ?? null;

      if (!user) {
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

  const onBuy = async (plan: Plan) => {
    setBuyError(null);

    if (!uid) {
      setBuyError("Missing userId. Please refresh and try again.");
      return;
    }

    // 保险校验（你已经有，保留）
    if (plan.priceId.startsWith("price_") === false) {
      setBuyError(`Please set Stripe priceId for "${plan.title}" (currently: ${plan.priceId}).`);
      return;
    }

    try {
      setBuyingKey(plan.key);

      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priceId: plan.priceId, userId: uid }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setBuyError(data?.error || "Failed to start checkout.");
        setBuyingKey(null);
        return;
      }

      if (!data?.url) {
        setBuyError("Checkout URL missing. Please check /api/billing/checkout response.");
        setBuyingKey(null);
        return;
      }

      window.location.href = data.url;
    } catch (e: any) {
      setBuyError(e?.message || "Network error. Please try again.");
      setBuyingKey(null);
    }
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
          点击 Recharge 会跳转到 Stripe Checkout。
        </div>

        {buyError ? (
          <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {buyError}
          </div>
        ) : null}

        <div className="mt-4 grid items-stretch gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {plans.map((p) => {
            const isBuying = buyingKey === p.key;

            return (
              <div
                key={p.key}
                className="flex h-full flex-col rounded-2xl border border-neutral-200 p-4"
              >
                <div className="font-semibold">{p.title}</div>

                <div className="mt-1 min-h-[40px] text-sm leading-5 text-neutral-600">
                  {p.price} · {p.tokens} tokens
                </div>

                <div className="h-4" />

                <button
                  onClick={() => onBuy(p)}
                  disabled={!!buyingKey}
                  className="w-full rounded-xl bg-neutral-900 px-3 py-2 text-sm text-white hover:opacity-90 disabled:opacity-40"
                  title={isBuying ? "Redirecting…" : "Recharge"}
                >
                  {isBuying ? "Redirecting…" : "Recharge"}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
