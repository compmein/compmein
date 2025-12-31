"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import AppHeader from "../components/AppHeader";
import { useTokenBalance } from "../components/useTokenBalance";

const TOKEN_COSTS = {
  NANO: 15,
  PRO: 45,
} as const;

const ALLOWED_ASPECTS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const;
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
 * - lastBgPrompt: last prompt
 * - lastStageAR: last selected aspect ratio
 * - lastBgReferenceDataUrl: cached reference image (small) for UI restore
 */
const LS_AI_BG_RESULT = "lastAIBgResultId";
const LS_AI_BG_URL = "lastAIBgDataUrl";
const LS_BG_PROMPT = "lastBgPrompt";
const LS_STAGE_AR = "lastStageAR";
const LS_BG_REF = "lastBgReferenceDataUrl";

type ModelType = "nano" | "pro";

function safeSetLS(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function safeGetLS(key: string) {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

async function fileToDataUrl(file: File) {
  return await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(new Error("File read failed"));
    r.readAsDataURL(file);
  });
}

/** Resize to <= maxPixels, output JPEG blob */
async function fileToJpegBlobMaxPixels(file: File, maxPixels: number, quality = 0.9) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Image load failed"));
      img.src = url;
    });

    const w0 = img.naturalWidth || img.width;
    const h0 = img.naturalHeight || img.height;
    if (!w0 || !h0) throw new Error("Bad image size");

    const pixels = w0 * h0;
    const scale = pixels > maxPixels ? Math.sqrt(maxPixels / pixels) : 1;

    const w = Math.max(1, Math.round(w0 * scale));
    const h = Math.max(1, Math.round(h0 * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No canvas context");
    ctx.drawImage(img, 0, 0, w, h);

    const blob: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b || new Blob()), "image/jpeg", quality));
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

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

  // Reference image (optional)
  const [refDataUrl, setRefDataUrl] = useState<string>("");

  const stageSize = useMemo(() => SAFE_STAGE_SIZE_MAP[ar] ?? SAFE_STAGE_SIZE_MAP["16:9"], [ar]);

  // --- Restore on mount (always prefer Supabase via resultId) ---
  useEffect(() => {
    setMounted(true);
    (async () => {
      try {
        const storedAR = (safeGetLS(LS_STAGE_AR) as AllowedAR) || "";
        if (storedAR && (ALLOWED_ASPECTS as readonly string[]).includes(storedAR)) setAr(storedAR);

        const storedPrompt = safeGetLS(LS_BG_PROMPT);
        if (storedPrompt) setPrompt(storedPrompt);

        const storedRef = safeGetLS(LS_BG_REF);
        if (storedRef) setRefDataUrl(storedRef);

        // fast preview cache
        const cachedUrl = safeGetLS(LS_AI_BG_URL);
        if (cachedUrl) setOutUrl(cachedUrl);

        // authoritative restore: resultId -> signedUrl
        const rid = safeGetLS(LS_AI_BG_RESULT);
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
              safeSetLS(LS_AI_BG_URL, signedUrl);
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

  async function onSelectRefFile(file: File) {
    try {
      // 缓存一个小一点的 dataUrl（UI用）
      const d = await fileToDataUrl(file);
      setRefDataUrl(d);
      safeSetLS(LS_BG_REF, d);
      setUiMsg("✅ Reference 已选择");
    } catch {
      setUiMsg("Reference 读取失败");
    }
  }

  function clearRef() {
    setRefDataUrl("");
    try {
      localStorage.removeItem(LS_BG_REF);
    } catch {}
  }

  function buildFinalPrompt(userPrompt: string, hasRef: boolean, aspectRatio: AllowedAR) {
    const clean = (userPrompt || "").trim();

    if (!hasRef) {
      // 纯文生图
      return [
        "You are generating a BACKGROUND image only.",
        "No people, no text, no watermark.",
        `Aspect ratio: ${aspectRatio}.`,
        `Prompt: ${clean}`,
      ].join("\n");
    }

    // 图生背景：做“背景净化/去人”
    const defaultEdit = [
      "Use the uploaded photo as the reference.",
      "Task: remove ALL people/subjects from the scene and reconstruct the background naturally.",
      "Keep the same location, perspective, lighting, and photo-realistic style.",
      "No text, no watermark, no logo.",
      `Output aspect ratio: ${aspectRatio}.`,
    ].join("\n");

    // 允许用户补充：比如“只移除背景里其他人，保留环境细节”等
    const userLine = clean ? `User instructions:\n${clean}` : "User instructions:\n(If nothing else, just remove all people and keep a clean background.)";

    return [defaultEdit, userLine].join("\n\n");
  }

  async function generate(modelType: ModelType) {
    if (!isReady) {
      setUiMsg("Token 正在加载，请稍等…");
      return;
    }

    const cost = modelType === "pro" ? TOKEN_COSTS.PRO : TOKEN_COSTS.NANO;
    if (!hasTokens(cost)) {
      setUiMsg(`Not enough tokens (requires ${cost})`);
      return;
    }

    // 允许：有 ref 但没写 prompt（我们会给默认指令）
    if (!prompt.trim() && !refDataUrl) {
      setUiMsg("请先写一句 BG Prompt，或上传一张 Reference 图");
      return;
    }

    setIsGenerating(true);
    try {
      safeSetLS(LS_BG_PROMPT, prompt);
      safeSetLS(LS_STAGE_AR, ar);

      const fd = new FormData();
      const finalPrompt = buildFinalPrompt(prompt, !!refDataUrl, ar);

      fd.append("prompt", finalPrompt);
      fd.append("aspectRatio", ar);
      fd.append("modelType", modelType);

      // 给后端一个语义提示：pro 希望走“<=4MP 但更清晰”的档位
      fd.append("imageSize", "SAFE_4MP");

      // 如果有 reference，转成 jpeg 并压到 <=4MP（pro 强制；nano 也压一下更稳定）
      if (refDataUrl) {
        const refBlob = await (await fetch(refDataUrl)).blob();
        const refFile = new File([refBlob], "bg_reference", { type: refBlob.type || "image/*" });

        const maxPixels = 4_000_000;
        const jpgBlob = await fileToJpegBlobMaxPixels(refFile, maxPixels, 0.9);
        fd.append("image", jpgBlob, "bg_reference.jpg");
      }

      const resp = await fetch("/api/nanobanana/generate-bg", {
        method: "POST",
        body: fd,
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

      if (!resultId) throw new Error("No resultId returned from server (cannot restore on refresh).");

      // Save authoritative pointer
      safeSetLS(LS_AI_BG_RESULT, resultId);

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
    safeSetLS(LS_AI_BG_URL, outUrl);
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

      {uiMsg ? <div className="mt-3 rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm">{uiMsg}</div> : null}

      <div className="mt-4 rounded-2xl border p-4">
        <div className="text-sm font-medium">Upload Image Reference（可选）</div>
        <div className="mt-1 text-xs text-neutral-500">
          用于“去掉背景里其他人 / 做干净背景板”。上传后会把图片 + Prompt 一起发给 Gemini。
        </div>

        <div className="mt-3 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="file"
              accept="image/*"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onSelectRefFile(f);
              }}
              className="text-sm"
            />
            {refDataUrl ? (
              <button onClick={clearRef} className="rounded-xl border px-3 py-2 text-sm hover:bg-neutral-50">
                Remove reference
              </button>
            ) : null}
          </div>

          {refDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={refDataUrl} alt="BG reference" className="w-full rounded-xl border object-contain" />
          ) : (
            <div className="rounded-xl border border-dashed p-4 text-sm text-neutral-500">未选择 Reference（可不上传）</div>
          )}
        </div>
      </div>

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
          placeholder="e.g. Keep the same scene, remove all other people, reconstruct background naturally. Or: A cozy modern living room, realistic photo, no people, no text."
        />

        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div>
            <div className="text-xs font-medium text-neutral-700">Aspect ratio</div>
            <select className="mt-1 w-full rounded-xl border px-3 py-2 text-sm" value={ar} onChange={(e) => setAr(e.target.value as AllowedAR)}>
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

            <div className="mt-2 text-xs text-neutral-500">
              nano：不强制限制输出大小（模型会自己处理）。<br />
              pro：我们保证输入 reference ≤4MP，并按该 aspect ratio 生成。
            </div>
          </div>

          <div className="flex flex-col justify-end gap-2">
            <button
              onClick={() => generate("nano")}
              disabled={isGenerating || !isReady || !hasTokens(TOKEN_COSTS.NANO)}
              title={
                !isReady ? "Token 正在加载…" : !hasTokens(TOKEN_COSTS.NANO) ? `Not enough tokens (requires ${TOKEN_COSTS.NANO})` : ""
              }
              className="w-full rounded-xl bg-neutral-900 px-4 py-2.5 text-sm text-white hover:opacity-90 disabled:opacity-40"
            >
              {isGenerating ? "Generating..." : `Generate AI BG 1k · nano · ${TOKEN_COSTS.NANO} Token`}
            </button>

            <button
              onClick={() => generate("pro")}
              disabled={isGenerating || !isReady || !hasTokens(TOKEN_COSTS.PRO)}
              title={!isReady ? "Token 正在加载…" : !hasTokens(TOKEN_COSTS.PRO) ? `Not enough tokens (requires ${TOKEN_COSTS.PRO})` : ""}
              className="w-full rounded-xl border px-4 py-2.5 text-sm hover:bg-neutral-50 disabled:opacity-40"
            >
              {isGenerating ? "Generating..." : `Generate AI BG 2k · pro · ${TOKEN_COSTS.PRO} Tokens`}
            </button>
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-2xl border p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-medium">Preview</div>
          <div className="flex items-center gap-2">
            {outUrl ? (
              <button onClick={downloadBg} className="rounded-xl border px-3 py-2 text-sm hover:bg-neutral-50" title="下载当前背景">
                Download
              </button>
            ) : null}
            <button onClick={useThisBgAndReturn} className="rounded-xl border px-3 py-2 text-sm hover:bg-neutral-50">
              Use this BG & Return
            </button>
          </div>
        </div>

        {isRestoring && !outUrl ? (
          <div className="mt-3 rounded-xl border border-dashed p-6 text-center text-sm text-neutral-500">正在从 Supabase 恢复预览…</div>
        ) : outUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={outUrl} alt="AI BG" className="mt-3 w-full rounded-xl border object-contain" />
        ) : (
          <div className="mt-3 rounded-xl border border-dashed p-6 text-center text-sm text-neutral-500">生成后会在这里显示预览</div>
        )}
      </div>
    </div>
  );
}
