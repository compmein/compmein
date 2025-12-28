"use client";

import { useEffect } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

export default function AuthCallbackPage() {
  const sp = useSearchParams();
  const router = useRouter();

  useEffect(() => {
    (async () => {
      await supabase.auth.getSession();
      const next = sp.get("next") || "/create";
      router.replace(next);
    })();
  }, [router, sp]);

  return (
    <div className="mx-auto max-w-md rounded-3xl border bg-white p-8 shadow-sm">
      正在完成登录...
    </div>
  );
}
