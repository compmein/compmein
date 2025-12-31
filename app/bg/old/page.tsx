"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import AppHeader from "../components/AppHeader";

// =======================
// ✅ Aspect ratio + SAFE SIZE MAP (≤4MP) — aligned with Create page
// =======================
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
  "1:1": { w: 2000, h: 2000 }, // 4.00MP
  "2:3": { w: 1600, h: 2400 }, // 3.84MP
  "3:2": { w: 2400, h: 1600 }, // 3.84MP
  "3:4": { w: 1728, h: 2304 }, // 3.98MP
  "4:3": { w: 2304, h: 1728 }, // 3.98MP
  "4:5": { w: 1760, h: 2200 }, // 3.87MP
  "5:4": { w: 2200, h: 1760 }, // 3.87MP
  "9:16": { w: 1440, h: 2560 }, // 3.69MP
  "16:9": { w: 2560, h: 1440 }, // 3.69MP
  "21:9": { w: 2880, h: 1234 }, // 3.55MP
};

function mpText(w: number, h: number) {
  return `${((w * h) / 1_000_000).toFixed(2)}MP`;
}

function safeSetLocalStorage(key: string, value: string, maxLen = 1_800_000) {
  try {
    if (!value) {
      localStorage.removeItem(key);
      return;
    }
    // 避免 QuotaExceededError
    if (value.length > maxLen) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, value);
  } catch {
    try {
      localStorage.removeItem(key);
    } catch {}
  }
}

async function fileToDataUrl(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

async function loadImageFromDataUrl(dataUrl: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = dataUrl;
  });
  return img;
}

/**
 * ✅ 把任意底图“cover 裁切”到目标画布尺寸（无留白，居中裁剪），并导出 JPG
 * - 输出尺寸严格等于 SAFE_STAGE_SIZE_MAP[aspectRatio]（≤4MP）
 * - nano/pro 都可以用同一张 4MP-safe master（你现在 create page 也是这么做的）
 */
async function coverCropToSafeJpeg(baseDataUrl: string, targetW: number, targetH: number, quality = 0.9) {
  const img = await loadImageFromDataUrl(baseDataUrl);
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;

  // cover scale
  const scale = Math.max(targetW / iw, targetH / ih);
  const cropW = targetW / scale;
  const cropH = targetH / scale;
  const cropX = Math.max(0, (iw - cropW) / 2);
  const cropY = Math.max(0, (ih - cropH) / 2);

  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No 2D context");

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, targetW, targetH);

  const blob: Blob = await new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b as Blob), "image/jpeg", quality);
  });

  return new File([blob], "base_safe.jpg", { type: "image/jpeg" });
}

const LS_BG_PROMPT = "bgStudioPrompt";
const LS_BG_AR = "bgStudioAR";
const LS_BG_BASE = "bgStudioBaseDataUrl";
const LS_BG_OUT = "lastAIBgDataUrl"; // ✅ Create page will pick this up

export default function BgPage() {
  const [aspectRatio, setAspectRatio] = useState<AllowedAR>("16:9");
  const [prompt, setPrompt] = useState<string>(
    "Remove all other people in the background. Keep the main subject unchanged. Reconstruct the background naturally. Photorealistic. No text, no watermark."
  );

  // ✅ optional base image (for edit/remove people)
  const [baseDataUrl, setBaseDataUrl] = useState<string>("");
  const [isGenerating, setIsGenerating] = useState(false);

  // output
  const [outDataUrl, setOutDataUrl] = useState<string>("");

  const safeSize = useMemo(() => SAFE_STAGE_SIZE_MAP[aspectRatio], [aspectRatio]);

  useEffect(() => {
    // restore
    try {
      const ar = (localStorage.getItem(LS_BG_AR) as AllowedAR) || "";
      if (ar && (ALLOWED_ASPECTS as readonly string[]).includes(ar)) setAspectRatio(ar);

      const p = localStorage.getItem(LS_BG_PROMPT);
      if (p) setPrompt(p);

      const base = localStorage.getItem(LS_BG_BASE) || "";
      if (base) setBaseDataUrl(base);

      const lastOut = localStorage.getItem(LS_BG_OUT) || "";
      if (lastOut) setOutDataUrl(lastOut);
    } catch {}
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(LS_BG_AR, aspectRatio);
    } catch {}
  }, [aspectRatio]);

  useEffect(() => {
    try {
      localStorage.setItem(LS_BG_PROMPT, prompt);
    } catch {}
  }, [prompt]);

  async function onPickBase(file: File) {
    const url = await fileToDataUrl(file);
    setBaseDataUrl(url);
    safeSetLocalStorage(LS_BG_BASE, url);
  }

  function clearBase() {
    setBaseDataUrl("");
    safeSetLocalStorage(LS_BG_BASE, "");
  }

  function clearOutput() {
    setOutDataUrl("");
    safeSetLocalStorage(LS_BG_OUT, "");
  }

  async function generateBg(modelType: "nano" | "pro") {
    setIsGenerating(true);
    try {
      const fd = new FormData();
      fd.append("prompt", prompt);
      fd.append("aspectRatio", aspectRatio);
      fd.append("modelType", modelType);

      // ✅ if base image exists, preprocess to SAFE (≤4MP) according to AR, then send image + prompt
      if (baseDataUrl) {
        const safeFile = await coverCropToSafeJpeg(baseDataUrl, safeSize.w, safeSize.h, 0.9);
        fd.append("image", safeFile, "base_safe.jpg");
      }
      // ✅ else: prompt-only (no image field)

      const resp = await fetch("/api/nanobanana/generate-bg", {
        method: "POST",
        body: fd,
      });

      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        throw new Error(txt || `HTTP ${resp.status}`);
      }

      const json = await resp.json();
      const base64 = json?.imageBase64;
      const mimeType = json?.mimeType || "image/png";
      if (!base64) throw new Error("No image returned.");

      const out = `data:${mimeType};base64,${base64}`;
      setOutDataUrl(out);

      // ✅ persist for Create page pickup
      safeSetLocalStorage(LS_BG_OUT, out);
    } catch (e: any) {
      console.error(e);
      alert(typeof e?.message === "string" && e.message.trim() ? e.message : "Generate failed. Check console/network.");
    } finally {
      setIsGenerating(false);
    }
  }

  function downloadOut() {
    if (!outDataUrl) return;
    const a = document.createElement("a");
    a.href = outDataUrl;
    a.download = outDataUrl.startsWith("data:image/jpeg") ? "ai_bg.jpg" : "ai_bg.png";
    a.click();
  }

  return (
    <div className="space-y-6">
      <div className="rounded-3xl border bg-white p-6 shadow-sm">
        <AppHeader
          title="AI BG Studio"
          rightSlot={
            <Link href="/create" className="rounded-xl border px-3 py-2 text-sm hover:bg-neutral-50">
              Back to Create
            </Link>
          }
        />

        <p className="mt-2 text-sm text-neutral-600">
          ✅ 选择 aspect ratio 后，底图（如有）会被 cover 裁切到「安全画布」尺寸（≤4MP），用于 Pro 输入上限控制。
          <br />
          ✅ 不上传照片：只用 prompt 生成背景；上传照片：对照片进行“编辑式生成”（例如清理路人/去杂物）。
        </p>

        <div className="mt-4 grid gap-4 lg:grid-cols-[420px_1fr]">
          {/* Left controls */}
          <div className="space-y-4">
            <div className="rounded-2xl border p-4">
              <div className="text-sm font-medium">Aspect Ratio</div>
              <div className="mt-2 flex items-center gap-3">
                <select
                  className="w-full rounded-xl border px-3 py-2 text-sm"
                  value={aspectRatio}
                  onChange={(e) => setAspectRatio(e.target.value as AllowedAR)}
                >
                  {ALLOWED_ASPECTS.map((ar) => (
                    <option key={ar} value={ar}>
                      {ar}
                    </option>
                  ))}
                </select>
              </div>

              <div className="mt-2 text-xs text-neutral-600">
                安全画布：<span className="font-medium">{safeSize.w}×{safeSize.h}</span>（{mpText(safeSize.w, safeSize.h)}）
              </div>
            </div>

            <div className="rounded-2xl border p-4">
              <div className="text-sm font-medium">Prompt</div>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={7}
                className="mt-2 w-full resize-none rounded-xl border px-3 py-2 text-sm"
                placeholder="Describe the background you want... or describe what to remove from the photo."
              />
            </div>

            {/* Upload Base Image (Optional) */}
            <div className="rounded-2xl border p-4">
              <div className="text-sm font-medium">Upload Image (Optional)</div>
              <div className="mt-1 text-xs text-neutral-500">
                适合：去掉背景其他人/杂物、保留主体不变。上传后会按当前 aspect ratio 做 cover 裁切（无留白）。
              </div>

              <input
                type="file"
                accept="image/*"
                className="mt-2 w-full text-sm"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onPickBase(f);
                }}
              />

              {baseDataUrl ? (
                <div className="mt-3 flex items-center gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={baseDataUrl} alt="base" className="h-20 w-20 rounded-xl border object-cover" />
                  <button
                    className="rounded-xl border px-3 py-2 text-sm hover:bg-neutral-50"
                    onClick={clearBase}
                    disabled={isGenerating}
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <div className="mt-3 text-xs text-neutral-400">未上传底图（将按纯 prompt 生成）。</div>
              )}
            </div>

            {/* Buttons */}
            <div className="rounded-2xl border p-4 space-y-2">
              <button
                onClick={() => generateBg("nano")}
                className="w-full rounded-xl bg-neutral-900 px-4 py-2 text-sm text-white hover:opacity-90 disabled:opacity-40"
                disabled={isGenerating}
              >
                {isGenerating ? "Generating..." : "Generate AI BG 1k (Nano Banana)"}
              </button>

              <button
                onClick={() => generateBg("pro")}
                className="w-full rounded-xl border px-4 py-2 text-sm hover:bg-neutral-50 disabled:opacity-40"
                disabled={isGenerating}
              >
                {isGenerating ? "Generating..." : "Generate AI BG 2k (Nano Banana Pro)"}
              </button>

              <div className="pt-1 text-xs text-neutral-600">
                发送策略：<span className="font-medium">上传底图</span> → image(≤4MP safe) + prompt；<span className="font-medium">未上传</span> → prompt-only。
              </div>
            </div>
          </div>

          {/* Right preview */}
          <div className="space-y-4">
            <div className="rounded-3xl border bg-white p-6 shadow-sm">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-base font-semibold">Preview</div>
                  <div className="text-sm text-neutral-600">结果会写入 lastAIBgDataUrl，Create 页面会自动读取。</div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={downloadOut}
                    className="rounded-xl bg-neutral-900 px-4 py-2 text-sm text-white hover:opacity-90 disabled:opacity-40"
                    disabled={!outDataUrl}
                  >
                    Download
                  </button>
                  <button
                    onClick={clearOutput}
                    className="rounded-xl border px-3 py-2 text-sm hover:bg-neutral-50 disabled:opacity-40"
                    disabled={!outDataUrl || isGenerating}
                  >
                    Clear
                  </button>
                </div>
              </div>

              <div className="mt-4 overflow-hidden rounded-2xl border bg-neutral-50">
                {outDataUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={outDataUrl} alt="bg output" className="h-[560px] w-full object-contain" />
                ) : (
                  <div className="flex h-[560px] items-center justify-center text-sm text-neutral-500">
                    还没有输出（左侧点击 Generate）
                  </div>
                )}
              </div>

              {baseDataUrl && (
                <div className="mt-3 text-xs text-neutral-500">
                  Tip：你现在上传了底图，prompt 建议写“Remove other people / remove clutter / keep main subject unchanged …”
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-3xl border bg-white p-6 shadow-sm">
        <h3 className="font-semibold">Notes</h3>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-neutral-700">
          <li>“1k/2k”是档位名（nano/pro）。nano 会自动按模型上限处理分辨率，无需前端强限。</li>
          <li>Pro 输入严格控制为 ≤4MP-safe（按 aspect ratio 最大化），避免超上限。</li>
          <li>生成后会写入 localStorage：lastAIBgDataUrl（Create 会自动显示 “AI 生成背景”）。</li>
        </ul>
      </div>
    </div>
  );
}
