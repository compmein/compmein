"use client";

import React from "react";

export function TokenBadge(props: { balance: number | null }) {
  return (
    <div className="rounded-full border px-3 py-1 text-sm">
      🪙 Tokens: <b>{props.balance === null ? "…" : props.balance}</b>
    </div>
  );
}
