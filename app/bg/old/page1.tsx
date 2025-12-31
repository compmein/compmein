"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import AppHeader from "../components/AppHeader";
import { useTokenBalance } from "../components/useTokenBalance";

const TOKEN_COSTS = { BG: 15 } as const;

const ALLOWED_ASPECTS = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
] as const;

type AllowedAR = (typeof ALLOWED_ASPECTS)[number];

const SAFE_STAGE_SIZE_MAP: Record<AllowedAR, { w: number; h: number }> = {
  "1:1": { w: 2000, h: 2000 },
  "2:3": { w: 1600, h: 2400 },
  "3:2": { w: 2400, h: 1600 },
  "3:4": { w: 1728, h: 2304 },
  "4:3": { w: 2304, h: 1728 },
  "4:5": { w: 1760, h: 2200 },
  "5:4": { w: 2200, h: 1760 },
  "9:16": { w: 1440, h: 2560 },
  "16:9": { w: 2560, h: 1440 },
  "21:9": { w: 2880, h: 1234 },
};

function mpText(w: number, h: number) {
  const mp = (w * h) / 1_000_000;
  return `${mp.toFixed(2)}MP`;
}

/**
 * LocalStorage keys:
 * - lastBgDataUrl: reserved for USER-UPLOADED BG on Create page (do NOT touch here)
 * - lastAIBgResultId: authoritative pointer to last generated AI BG in Supabase (stable across refresh)
 * - lastAIBgDataUrl: optional cache (signedUrl or small dataUrl) for faster preview
 */
const LS_AI_BG_RESULT = "lastAIBgResultId";
const LS_AI_BG_URL = "lastAIBgDataUrl";
const LS_BG_PROMPT = "lastBgPrompt";
const LS_STAGE_AR = "lastStageAR";

export default function AiBgStudioPage() {
  const router = useRouter();
  const sp = useSearchParams();
  const returnTo = sp.get("return") || "/create";

  const { balance, isReady } = useTokenBalance();
  const hasTokens = (cost: number) => (isReady ? (balance ?? 0) >= cost : false);

  const [mounted, setMounted] = useState(false);
  const [ar, setAr] = useState<AllowedAR>("16:9");
  const [prompt, setPrompt] = useState<string>("");

  const [isGenerating, setIsGenerating] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);

  const [outUrl, setOutUrl] = useState<string>(""); // signedUrl OR small dataUrl
  const [uiMsg, setUiMsg] = useState<string>("");

  const stageSize = useMemo(() => SAFE_STAGE_SIZE_MAP[ar] ?? SAFE_STAGE_SIZE_MAP["16:9"], [ar]);

  // --- Restore on mount (always prefer Supabase via resultId) ---
  useEffect(() => {
    setMounted(true);
    (async () => {
      try {
        const storedAR = (localStorage.getItem(LS_STAGE_AR) as AllowedAR | null) || null;
        if (storedAR && (ALLOWED_ASPECTS as readonly string[]).includes(storedAR)) setAr(storedAR);

        const storedPrompt = localStorage.getItem(LS_BG_PROMPT) || "";
        setPrompt(storedPrompt);

        // If we already have a cached URL, show it immediately (fast)
        const cachedUrl = localStorage.getItem(LS_AI_BG_URL) || "";
        if (cachedUrl) setOutUrl(cachedUrl);

        // Authoritative restore: use resultId -> fetch fresh signedUrl
        const rid = localStorage.getItem(LS_AI_BG_RESULT) || "";
        if (rid) {
          setIsRestoring(true);
          const r = await fetch("/api/ai-results/get-signed-url", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ resultId: rid }),
          });
          if (r.ok) {
            const j = await r.json();
            const signedUrl = String(j?.signedUrl || "");
            if (signedUrl) {
              setOutUrl(signedUrl);
              try {
                localStorage.setItem(LS_AI_BG_URL, signedUrl);
              } catch {}
            }
          }
        }
      } catch {
        // ignore
      } finally {
        setIsRestoring(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!uiMsg) return;
    const t = setTimeout(() => setUiMsg(""), 3200);
    return () => clearTimeout(t);
  }, [uiMsg]);

  async function generate() {
    if (!isReady) {
      setUiMsg("Token 正在加载，请稍等…");
      return;
    }
    if (!hasTokens(TOKEN_COSTS.BG)) {
      setUiMsg(`Not enough tokens (requires ${TOKEN_COSTS.BG})`);
      return;
    }
    if (!prompt.trim()) {
      setUiMsg("请先写一句 BG Prompt");
      return;
    }

    setIsGenerating(true);
    try {
      localStorage.setItem(LS_BG_PROMPT, prompt);
      localStorage.setItem(LS_STAGE_AR, ar);

      const resp = await fetch("/api/nanobanana/generate-bg", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, aspectRatio: ar }),
      });

      if (resp.status === 401) {
        setUiMsg("请先登录再生成背景");
        return;
      }

      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status} ${resp.statusText}: ${txt.slice(0, 300)}`);
      }

      const json = await resp.json();

      const resultId = (json?.resultId as string | undefined) || undefined;
      const signedUrl = (json?.signedUrl as string | undefined) || undefined;

      const base64 = (json?.imageBase64 as string | undefined) || undefined;
      const mimeType = (json?.mimeType as string | undefined) || "image/png";

      if (!resultId) {
        throw new Error("No resultId returned from server (cannot restore on refresh).");
      }

      // Save authoritative pointer
      try {
        localStorage.setItem(LS_AI_BG_RESULT, resultId);
      } catch {}

      // Preview immediately:
      const previewUrl = signedUrl || (base64 ? `data:${mimeType};base64,${base64}` : "");
      if (!previewUrl) throw new Error("No image returned.");

      setOutUrl(previewUrl);

      // Cache URL if it's not huge data url
      try {
        if (!previewUrl.startsWith("data:") || previewUrl.length < 3_500_000) {
          localStorage.setItem(LS_AI_BG_URL, previewUrl);
        } else if (signedUrl) {
          localStorage.setItem(LS_AI_BG_URL, signedUrl);
        }
      } catch {}

      setUiMsg("✅ 已生成（刷新也能恢复）");
    } catch (e) {
      console.error(e);
      setUiMsg(e instanceof Error ? e.message : "Generate AI BG failed");
    } finally {
      setIsGenerating(false);
    }
  }

  function useThisBgAndReturn() {
    if (!outUrl) {
      setUiMsg("请先生成一张背景");
      return;
    }
    try {
      localStorage.setItem(LS_AI_BG_URL, outUrl);
    } catch {}
    router.push(returnTo);
  }

  async function downloadBg() {
    if (!outUrl) return;
    try {
      if (outUrl.startsWith("data:")) {
        const a = document.createElement("a");
        a.href = outUrl;
        a.download = "ai-bg.png";
        document.body.appendChild(a);
        a.click();
        a.remove();
        return;
      }
      const r = await fetch(outUrl);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "ai-bg.png";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setUiMsg("下载失败：请右键图片另存为");
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <AppHeader title="AI BG Studio" backHref={returnTo} />

      {uiMsg ? (
        <div className="mt-3 rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm">{uiMsg}</div>
      ) : null}

      <div className="mt-4 rounded-2xl border p-4">
        <div className="text-sm font-medium">BG Prompt</div>
        <div className="mt-1 text-xs text-neutral-500">
          生成结果会保存到 Supabase（最近 10 张），本页用 <span className="font-mono">resultId</span> 刷新自动恢复。
        </div>

        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          className="mt-2 w-full resize-none rounded-xl border px-3 py-2 text-sm"
          placeholder="e.g. A cozy modern living room, warm sunlight, realistic photo, no people, no text."
        />

        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div>
            <div className="text-xs font-medium text-neutral-700">Aspect ratio</div>
            <select
              className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              value={ar}
              onChange={(e) => setAr(e.target.value as AllowedAR)}
            >
              {ALLOWED_ASPECTS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>

            <div className="mt-1 text-xs text-neutral-600">
              安全画布:{" "}
              {mounted ? (
                <>
                  <span className="font-medium">
                    {stageSize.w}×{stageSize.h}
                  </span>{" "}
                  （{mpText(stageSize.w, stageSize.h)}）
                </>
              ) : (
                <span className="text-neutral-400">—</span>
              )}
            </div>
          </div>

          <div className="flex items-end">
            <button
              onClick={generate}
              disabled={isGenerating || !isReady || !hasTokens(TOKEN_COSTS.BG)}
              title={
                !isReady
                  ? "Token 正在加载…"
                  : !hasTokens(TOKEN_COSTS.BG)
                    ? `Not enough tokens (requires ${TOKEN_COSTS.BG})`
                    : ""
              }
              className="w-full rounded-xl bg-neutral-900 px-4 py-2.5 text-sm text-white hover:opacity-90 disabled:opacity-40"
            >
              {isGenerating ? "Generating..." : `Generate AI BG · ${TOKEN_COSTS.BG} Token`}
            </button>
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-2xl border p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-medium">Preview</div>
          <div className="flex items-center gap-2">
            {outUrl ? (
              <button
                onClick={downloadBg}
                className="rounded-xl border px-3 py-2 text-sm hover:bg-neutral-50"
                title="下载当前背景"
              >
                Download
              </button>
            ) : null}
            <button onClick={useThisBgAndReturn} className="rounded-xl border px-3 py-2 text-sm hover:bg-neutral-50">
              Use this BG & Return
            </button>
          </div>
        </div>

        {isRestoring && !outUrl ? (
          <div className="mt-3 rounded-xl border border-dashed p-6 text-center text-sm text-neutral-500">
            正在从 Supabase 恢复预览…
          </div>
        ) : outUrl ? (
          <img src={outUrl} alt="AI BG" className="mt-3 w-full rounded-xl border object-contain" />
        ) : (
          <div className="mt-3 rounded-xl border border-dashed p-6 text-center text-sm text-neutral-500">
            生成后会在这里显示预览
          </div>
        )}
      </div>
    </div>
  );
}
