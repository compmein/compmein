"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";

export default function AccountButton() {
  const [isAuthed, setIsAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      setIsAuthed(!!data.session?.user);
    })();
  }, []);

  const href = isAuthed ? "/account" : "/login";
  const label = isAuthed ? "Account" : "Log in";

  return (
    <Link
      href={href}
      className="inline-flex items-center gap-2 rounded-xl border border-neutral-200 px-3 py-2 text-sm hover:bg-neutral-50"
      title={isAuthed ? "进入账号页" : "去登录"}
    >
      <span className="h-2 w-2 rounded-full bg-neutral-400" />
      {label}
    </Link>
  );
}
