"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { TokenBadge } from "./TokenBadge";
import { useTokenBalance } from "./useTokenBalance";
import { supabase } from "@/lib/supabaseClient";

type Props = {
  title?: string;
  backHref?: string;
  rightSlot?: React.ReactNode;
};

export default function AppHeader({ title = "Create", backHref, rightSlot }: Props) {
  const { balance, isReady } = useTokenBalance();

  const [tokenHref, setTokenHref] = useState<string>("/login");

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      const authed = !!data.session?.user;
      setTokenHref(authed ? "/account" : "/login");
    })();
  }, []);

  const TokenChip = useMemo(() => {
    return (
      <Link
        href={tokenHref}
        className="hover:opacity-90"
        title={tokenHref === "/account" ? "View account & tokens" : "Log in"}
      >
        <TokenBadge balance={isReady ? balance : null} />
      </Link>
    );
  }, [tokenHref, isReady, balance]);

  return (
    <div className="flex items-center justify-between gap-3">
      {/* 左侧：Back + Title */}
      <div className="flex items-center gap-3">
        {backHref ? (
          <Link
            href={backHref}
            className="inline-flex items-center rounded-xl border border-neutral-200 px-3 py-2 text-sm hover:bg-neutral-50"
          >
            ← Back
          </Link>
        ) : null}
        <div className="text-lg font-semibold">{title}</div>
      </div>

      {/* 右侧：Home + Token */}
      <div className="flex items-center gap-2">
        {/* 🏠 Home 按钮 */}
        <Link
          href="/"
          title="Home"
          className="rounded-md border border-neutral-200 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100"
        >
          Home
        </Link>

        {rightSlot}
        {TokenChip}
      </div>
    </div>
  );
}
