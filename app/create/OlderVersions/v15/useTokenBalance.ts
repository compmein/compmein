import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabaseClient";

const DEFAULT_TOKEN = 10;

export function useTokenBalance() {
  const [balance, setBalance] = useState<number>(0);
  const [userId, setUserId] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      const user = data.session?.user ?? null;

      if (!user) {
        setUserId(null);
        setBalance(0);
        setIsReady(true);
        return;
      }

      setUserId(user.id);

      const key = `token_balance_${user.id}`;
      const cached = localStorage.getItem(key);

      if (cached !== null) {
        setBalance(Number(cached));
      } else {
        localStorage.setItem(key, String(DEFAULT_TOKEN));
        setBalance(DEFAULT_TOKEN);
      }

      setIsReady(true);
    })();
  }, []);

  // ✅ 这里改成函数：hasTokens(cost)
  const hasTokens = useCallback(
    (cost: number) => {
      if (!userId) return false;
      return balance >= cost;
    },
    [balance, userId]
  );

  // ✅ spend(cost) 成功返回 true，并同步写入该 user 的 key
  const spend = useCallback(
    (cost: number) => {
      if (!userId) return false;

      let ok = false;

      setBalance((prev) => {
        if (prev < cost) {
          ok = false;
          return prev;
        }
        const next = prev - cost;
        localStorage.setItem(`token_balance_${userId}`, String(next));
        ok = true;
        return next;
      });

      return ok;
    },
    [userId]
  );

  return {
    balance,
    isReady,
    hasTokens, // ✅ 函数
    spend,
  };
}
