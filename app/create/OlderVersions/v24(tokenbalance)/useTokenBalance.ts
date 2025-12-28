import { useCallback, useEffect, useState } from "react";

export function useTokenBalance() {
  const [balance, setBalance] = useState<number>(0);
  const [isReady, setIsReady] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const resp = await fetch("/api/tokens/balance", { method: "GET" });
      if (!resp.ok) {
        setBalance(0);
        setIsReady(true);
        return;
      }
      const json = await resp.json();
      setBalance(Number(json?.balance ?? 0));
      setIsReady(true);
    } catch {
      setBalance(0);
      setIsReady(true);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const hasTokens = useCallback(
    (cost: number) => {
      return balance >= cost;
    },
    [balance]
  );

  // ✅ spend(action) ：让服务器决定 cost，并返回最新余额
  const spend = useCallback(async (action: "CUTOUT" | "QUICK" | "PRO") => {
    const resp = await fetch("/api/tokens/spend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });

    if (!resp.ok) {
      const json = await resp.json().catch(() => ({}));
      return { ok: false as const, error: json?.error || "SPEND_FAILED" };
    }

    const json = await resp.json();
    setBalance(Number(json?.balance ?? 0));
    return { ok: true as const, balance: Number(json?.balance ?? 0), cost: Number(json?.cost ?? 0) };
  }, []);

  return {
    balance,
    isReady,
    hasTokens, // 仍可用于 UI 禁用（体验）
    spend,     // 但“最终扣费”在服务器
    refresh,   // 需要时可手动刷新
  };
}
