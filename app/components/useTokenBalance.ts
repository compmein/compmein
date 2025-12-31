"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type UseTokenBalanceReturn = {
  balance: number;
  isReady: boolean;
  hasTokens: (cost: number) => boolean;
  refresh: () => Promise<void>;
};

export function useTokenBalance(): UseTokenBalanceReturn {
  const [balance, setBalance] = useState<number>(0);
  const [isReady, setIsReady] = useState<boolean>(false);

  const refresh = useCallback(async () => {
    try {
      const { data } = await supabase.auth.getSession();
      const user = data.session?.user;

      // 未登录：回退到本地（或 0）
      if (!user) {
        const local = Number(localStorage.getItem("token_balance") || "0");
        setBalance(Number.isFinite(local) ? local : 0);
        setIsReady(true);
        return;
      }

      // ✅ 优先读云端 user_tokens（你现在已经有这张表）
      const { data: row, error } = await supabase
        .from("user_tokens")
        .select("balance")
        .eq("user_id", user.id)
        .maybeSingle();

      if (error) {
        // 云端读失败：回退本地
        const local = Number(localStorage.getItem("token_balance") || "0");
        setBalance(Number.isFinite(local) ? local : 0);
        setIsReady(true);
        return;
      }

      const b = Number(row?.balance ?? 0);
      setBalance(Number.isFinite(b) ? b : 0);
      setIsReady(true);
    } catch {
      const local = Number(localStorage.getItem("token_balance") || "0");
      setBalance(Number.isFinite(local) ? local : 0);
      setIsReady(true);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const hasTokens = useCallback(
    (cost: number) => {
      if (!Number.isFinite(cost)) return false;
      return balance >= cost;
    },
    [balance]
  );

  return useMemo(
    () => ({ balance, isReady, hasTokens, refresh }),
    [balance, isReady, hasTokens, refresh]
  );
}
