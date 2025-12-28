"use client";

import { useCallback, useEffect, useState } from "react";

type Options = {
  storageKey?: string;
  defaultBalance?: number;
};

export function useTokenBalance(options: Options = {}) {
  const storageKey = options.storageKey ?? "tokenBalance";
  const defaultBalance = options.defaultBalance ?? 100;

  // null = 还没从 localStorage 加载完（避免 hydration mismatch）
  const [balance, setBalance] = useState<number | null>(null);

  // 只在客户端读取
  useEffect(() => {
    try {
      const v = localStorage.getItem(storageKey);
      const n = v === null ? NaN : Number(v);
      const init = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : defaultBalance;
      setBalance(init);
    } catch {
      setBalance(defaultBalance);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 写入 localStorage：只要 balance 有值就同步
  useEffect(() => {
    if (balance === null) return;
    try {
      localStorage.setItem(storageKey, String(balance));
    } catch {
      // ignore
    }
  }, [balance, storageKey]);

  const isReady = balance !== null;

  const hasTokens = useCallback(
    (cost: number) => {
      if (balance === null) return false;
      return balance >= cost;
    },
    [balance]
  );

  const spend = useCallback((cost: number) => {
    setBalance((prev) => {
      if (prev === null) return prev;
      const next = Math.max(0, Math.floor(prev - cost));
      return next;
    });
  }, []);

  const add = useCallback((amount: number) => {
    setBalance((prev) => {
      const base = prev === null ? defaultBalance : prev;
      const next = Math.max(0, Math.floor(base + amount));
      return next;
    });
  }, [defaultBalance]);

  const set = useCallback((value: number) => {
    setBalance(Math.max(0, Math.floor(value)));
  }, []);

  return { balance, isReady, hasTokens, spend, add, set };
}
