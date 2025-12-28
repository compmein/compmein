"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Konva from "konva";
import { Stage, Layer, Image as KonvaImage, Transformer, Ellipse } from "react-konva";
import { useTokenBalance } from "./useTokenBalance";
import { TokenBadge } from "./TokenBadge";

/**
 * ✅ 极简换装 Prompt（省 token）
 * - Image1: 场景（人物+背景）
 * - Image2: 参考（只用于衣服/配件/道具）
 * - 输出只保留蓝框内内容（你画布本身就是蓝框）
 */
const CLOTHING_PROMPT = `
1) Image 1 is the base scene. Keep the person's identity and pose identical.
2) Image 2 is the clothing/accessory reference. Apply ONLY the clothing/accessories/objects from Image 2 onto the person in Image 1.
3) Match lighting/shadows to Image 1. Do NOT include Image 2 or any UI elements in the final output.
`.trim();

type BgOption = { id: string; name: string; src: string; isUser?: boolean };

function useHtmlImage(src?: string) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    if (!src) return;

    const image = new window.Image();
    image.crossOrigin = "anonymous";
    image.onload = () => setImg(image);
    image.onerror = () => setImg(null);
    image.src = src;

    return () => setImg(null);
  }, [src]);

  return img;
}

/** 背景图等比缩放+居中（contain，不拉伸） */
function fitImage(img: HTMLImageElement, stageW: number, stageH: number) {
  const imgRatio = img.width / img.height;
  const stageRatio = stageW / stageH;

  let width: number;
  let height: number;

  if (imgRatio > stageRatio) {
    width = stageW;
    height = stageW / imgRatio;
  } else {
    height = stageH;
    width = stageH * imgRatio;
  }

  return {
    width,
    height,
    x: (stageW - width) / 2,
    y: (stageH - height) / 2,
  };
}

async function resizeImageFile(file: File, maxLongSide = 1080, quality = 0.9): Promise<File> {
  if (!/image\/(jpeg|png)/.test(file.type)) return file;

  const img = new Image();
  const objectUrl = URL.createObjectURL(file);

  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Image load failed"));
    img.src = objectUrl;
  });

  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const longSide = Math.max(w, h);

  if (longSide <= maxLongSide) {
    URL.revokeObjectURL(objectUrl);
    return file;
  }

  const scale = maxLongSide / longSide;
  const nw = Math.round(w * scale);
  const nh = Math.round(h * scale);

  const canvas = document.createElement("canvas");
  canvas.width = nw;
  canvas.height = nh;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    URL.revokeObjectURL(objectUrl);
    return file;
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, nw, nh);

  const outType = file.type === "image/png" ? "image/png" : "image/jpeg";

  const blob: Blob = await new Promise((resolve) => {
    canvas.toBlob(
      (b) => resolve(b as Blob),
      outType,
      outType === "image/jpeg" ? quality : undefined
    );
  });

  URL.revokeObjectURL(objectUrl);

  return new File(
    [blob],
    file.name.replace(/\.\w+$/, outType === "image/png" ? ".png" : ".jpg"),
    { type: outType }
  );
}

async function blobToDataURL(blob: Blob): Promise<string> {
  return await new Promise<string>((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.readAsDataURL(blob);
  });
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function ensureGradeFilter() {
  // @ts-ignore
  Konva.Filters ??= {};

  // @ts-ignore
  if (!Konva.Filters.__grade) {
    // @ts-ignore
    Konva.Filters.__grade = function (imageData: ImageData) {
      // @ts-ignore
      const g = this.__gradeValue ?? {
        gain: 1,
        gamma: 1,
        exposure: 0,
        temp: 0,
        tint: 0,
      };

      const gain = clamp(g.gain ?? 1, 0.1, 10);
      const gamma = clamp(g.gamma ?? 1, 0.1, 10);
      const exposure = clamp(g.exposure ?? 0, -2, 2);
      const temp = clamp(g.temp ?? 0, -1, 1);
      const tint = clamp(g.tint ?? 0, -1, 1);

      const add = exposure * 35;

      const t = temp * 0.15;
      const ti = tint * 0.15;

      const rGain = gain * (1 + t - ti * 0.5);
      const gGain = gain * (1 + ti);
      const bGain = gain * (1 - t - ti * 0.5);

      const invGamma = 1 / gamma;

      const d = imageData.data;
      for (let i = 0; i < d.length; i += 4) {
        let r = d[i];
        let gg = d[i + 1];
        let b = d[i + 2];

        r = r * rGain + add;
        gg = gg * gGain + add;
        b = b * bGain + add;

        r = Math.max(0, Math.min(255, r));
        gg = Math.max(0, Math.min(255, gg));
        b = Math.max(0, Math.min(255, b));

        r = 255 * Math.pow(r / 255, invGamma);
        gg = 255 * Math.pow(gg / 255, invGamma);
        b = 255 * Math.pow(b / 255, invGamma);

        d[i] = r;
        d[i + 1] = gg;
        d[i + 2] = b;
      }
    };
  }
}

function downloadDataUrl(dataUrl: string, filename: string) {
  const a = document.createElement("a");
  a.download = filename;
  a.href = dataUrl;
  a.click();
}

async function loadImageFromDataUrl(dataUrl: string) {
  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = dataUrl;
  });
  return img;
}

/** scene：最长边 <= 1024 */
async function dataUrlToJpegBlob(dataUrl: string, maxSide = 1024, quality = 0.85): Promise<Blob> {
  const img = await loadImageFromDataUrl(dataUrl);

  const w = img.width;
  const h = img.height;
  const scale = Math.min(maxSide / Math.max(w, h), 1);
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));

  const canvas = document.createElement("canvas");
  canvas.width = nw;
  canvas.height = nh;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No 2D context");

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, nw, nh);

  const blob: Blob = await new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b as Blob), "image/jpeg", quality);
  });

  return blob;
}

/** reference：最长边 <= 512（你要求的“不超过512等比缩放”） */
async function dataUrlToRefJpegBlob(dataUrl: string, maxSide = 512, quality = 0.85): Promise<Blob> {
  return dataUrlToJpegBlob(dataUrl, maxSide, quality);
}

export default function CreatePage() {
  const presetBgOptions: BgOption[] = useMemo(
    () => [
      { id: "waikiki", name: "Waikiki Beach", src: "/bg/waikiki.jpg" },
      { id: "diamond", name: "Diamond Head", src: "/bg/diamondhead.jpg" },
      { id: "night", name: "Honolulu Night", src: "/bg/night.jpg" },
    ],
    []
  );

  const STAGE_W = 900;
  const STAGE_H = 520;
  const ASPECT_RATIO = "16:9";

  const [userBgDataUrl, setUserBgDataUrl] = useState<string | null>(null);

  const bgOptions: BgOption[] = useMemo(() => {
    const userOpt: BgOption[] = userBgDataUrl
      ? [{ id: "user", name: "你上传的背景", src: userBgDataUrl, isUser: true }]
      : [];
    return [...userOpt, ...presetBgOptions];
  }, [presetBgOptions, userBgDataUrl]);

  const [bgSrc, setBgSrc] = useState<string>(() => presetBgOptions[0].src);
  const bgImg = useHtmlImage(bgSrc);

  const [personImg, setPersonImg] = useState<HTMLImageElement | null>(null);
  const [originalFile, setOriginalFile] = useState<File | null>(null);
  const [isCutting, setIsCutting] = useState(false);

  const [referenceDataUrl, setReferenceDataUrl] = useState<string | null>(null);

  const [combinePrompt, setCombinePrompt] = useState<string>(
    "Integrate the subject naturally into the scene. If a reference image is provided, follow it for clothing, accessories, and relevant details."
  );

  const [isCombining, setIsCombining] = useState(false);
  const [aiOutputDataUrl, setAiOutputDataUrl] = useState<string | null>(null);

  const [person, setPerson] = useState({
    x: 260,
    y: 220,
    scale: 0.7,
    rotation: 0,
  });

  const [personRect, setPersonRect] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);

  const [grade, setGrade] = useState({
    gain: 1.0,
    gamma: 1.0,
    exposure: 0.0,
    temp: 0.0,
    tint: 0.0,
  });

  const [shadow, setShadow] = useState({
    enabled: true,
    opacity: 0.23,
    blur: 28,
    widthFactor: 1.8,
    height: 20,
    yOffset: 10,
    squashY: 0.75,
    xOffset: 0,
  });

  const stageRef = useRef<any>(null);
  const personNodeRef = useRef<any>(null);
  const trRef = useRef<any>(null);

  const outerShadowRef = useRef<any>(null);
  const innerShadowRef = useRef<any>(null);

  const { balance: tokenBalance, isReady: tokenReady, hasTokens, spend } = useTokenBalance();

  const bgDraw = bgImg ? fitImage(bgImg, STAGE_W, STAGE_H) : null;

  function updatePersonRect() {
    const node = personNodeRef.current;
    if (!node) return;
    const rect = node.getClientRect({ skipTransform: false });
    setPersonRect({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
  }

  useEffect(() => {
    const saved = localStorage.getItem("lastCutPngDataUrl");
    if (!saved) return;
    const img = new window.Image();
    img.onload = () => setPersonImg(img);
    img.src = saved;
  }, []);

  useEffect(() => {
    const savedBg = localStorage.getItem("lastBgDataUrl");
    if (savedBg) setUserBgDataUrl(savedBg);

    const savedRef = localStorage.getItem("lastReferenceDataUrl");
    if (savedRef) setReferenceDataUrl(savedRef);

    const savedAI = localStorage.getItem("lastAIOutputDataUrl");
    if (savedAI) setAiOutputDataUrl(savedAI);
  }, []);

  useEffect(() => {
    const g = localStorage.getItem("lastGrade");
    const s = localStorage.getItem("lastShadow");
    if (g) setGrade((p) => ({ ...p, ...JSON.parse(g) }));
    if (s) setShadow((p) => ({ ...p, ...JSON.parse(s) }));
  }, []);

  useEffect(() => {
    localStorage.setItem("lastGrade", JSON.stringify(grade));
  }, [grade]);
  useEffect(() => {
    localStorage.setItem("lastShadow", JSON.stringify(shadow));
  }, [shadow]);

  useEffect(() => {
    if (!trRef.current || !personNodeRef.current) return;
    trRef.current.nodes([personNodeRef.current]);
    trRef.current.getLayer()?.batchDraw();
    setTimeout(() => updatePersonRect(), 0);
  }, [personImg]);

  const shadowDraw = useMemo(() => {
    if (!shadow.enabled) return null;
    if (!personRect) return null;

    const footX = personRect.x + personRect.width / 2;
    const footY = personRect.y + personRect.height;

    const baseRx = Math.max(18, (personRect.width * 0.42) / shadow.widthFactor);
    const baseRy = Math.max(8, shadow.height);

    const x = footX + shadow.xOffset;
    const y = footY + shadow.yOffset;

    const outer = {
      x,
      y,
      radiusX: baseRx * 1.25,
      radiusY: baseRy * 1.05,
      opacity: shadow.opacity * 0.55,
      blur: shadow.blur,
      scaleY: shadow.squashY,
    };

    const inner = {
      x,
      y,
      radiusX: baseRx * 0.95,
      radiusY: baseRy * 0.9,
      opacity: shadow.opacity * 0.85,
      blur: Math.max(3, Math.round(shadow.blur * 0.45)),
      scaleY: shadow.squashY,
    };

    return { outer, inner };
  }, [shadow, personRect]);

  useEffect(() => {
    if (!shadowDraw) return;
    outerShadowRef.current?.cache();
    innerShadowRef.current?.cache();
    stageRef.current?.getStage?.()?.batchDraw?.();
  }, [shadowDraw]);

  async function onSelectPersonFile(file: File) {
    const resized = await resizeImageFile(file, 1080, 0.9);
    setOriginalFile(resized);

    const url = URL.createObjectURL(resized);
    const img = new window.Image();
    img.onload = () => setPersonImg(img);
    img.src = url;
  }

  async function onSelectBgFile(file: File) {
    const resized = await resizeImageFile(file, 1080, 0.9);
    const dataUrl = await blobToDataURL(resized);
    setUserBgDataUrl(dataUrl);
    localStorage.setItem("lastBgDataUrl", dataUrl);
    setBgSrc(dataUrl);
  }

  /** reference：存本地也按“最长边<=512”缩放，避免 localStorage 存大图 */
  async function onSelectReferenceFile(file: File) {
    const resized = await resizeImageFile(file, 1080, 0.9);
    const dataUrl = await blobToDataURL(resized);

    const refBlob = await dataUrlToRefJpegBlob(dataUrl, 512, 0.85);
    const smallDataUrl = await blobToDataURL(refBlob);

    setReferenceDataUrl(smallDataUrl);
    localStorage.setItem("lastReferenceDataUrl", smallDataUrl);
  }

  async function doRemoveBg() {
    const CUTOUT_COST = 2;
    if (!tokenReady) return;
    if (!hasTokens(CUTOUT_COST)) {
      alert("Token不足");
      return;
    }

    if (!originalFile) {
      alert("请先上传一张人物 JPG/PNG，然后再点“抠图”");
      return;
    }

    setIsCutting(true);
    try {
      const fd = new FormData();
      fd.append("image", originalFile);

      const resp = await fetch("/api/remove-bg", {
        method: "POST",
        body: fd,
      });

      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(txt);
      }

      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);

      const img = new window.Image();
      img.onload = () => setPersonImg(img);
      img.src = url;

      try {
        const dataUrl = await blobToDataURL(blob);
        if (dataUrl.length < 4_000_000) {
          localStorage.setItem("lastCutPngDataUrl", dataUrl);
        } else {
          localStorage.removeItem("lastCutPngDataUrl");
        }
      } catch {
        // ignore
      }

      // ✅ 成功后扣 token
      spend(CUTOUT_COST);
    } catch (err) {
      console.error(err);
      alert("抠图失败：请看 F12 → Network → /api/remove-bg 的状态码/返回内容");
    } finally {
      setIsCutting(false);
    }
  }

  useEffect(() => {
    const node = personNodeRef.current as Konva.Image | undefined;
    if (!node || !personImg) return;

    ensureGradeFilter();
    node.cache({ pixelRatio: 2 });

    // @ts-ignore
    const gradeFilter = Konva.Filters.__grade;
    // @ts-ignore
    node.__gradeValue = grade;

    node.filters([gradeFilter]);
    node.getLayer()?.batchDraw();
  }, [grade, personImg]);

  function exportCustomerDataUrl() {
    const stage = stageRef.current;
    if (!stage) return null;

    const tr = trRef.current;
    const prevNodes = tr?.nodes?.() ?? [];

    tr?.nodes([]);
    tr?.getLayer()?.batchDraw();

    const uri = stage.toDataURL({ pixelRatio: 2 });

    tr?.nodes(prevNodes);
    tr?.getLayer()?.batchDraw();

    return uri as string;
  }

  function downloadCustomer() {
    const uri = exportCustomerDataUrl();
    if (!uri) return;
    downloadDataUrl(uri, "customer_output.png");
  }

  async function runAdvancedCombine(modelType: "nano" | "pro") {
    const QUICK_COST = 1;
    const PRO_COST = 3;
    const cost = modelType === "pro" ? PRO_COST : QUICK_COST;

    if (!tokenReady) return;
    if (!hasTokens(cost)) {
      alert("Token不足");
      return;
    }

    const stage = stageRef.current;
    if (!stage) return;

    setIsCombining(true);
    try {
      const stageDataUrl = exportCustomerDataUrl();
      if (!stageDataUrl) throw new Error("Failed to export stage image");

      // Image1: scene (<=1024)
      const sceneBlob = await dataUrlToJpegBlob(stageDataUrl, 1024, 0.85);

      const fd = new FormData();
      fd.append("image", sceneBlob, "scene.jpg");

      // Image2: ref (optional, longest side <=512)
      if (referenceDataUrl) {
        const refBlob = await dataUrlToRefJpegBlob(referenceDataUrl, 512, 0.85);
        fd.append("refImage", refBlob, "reference.jpg");
      }

      // prompt: short + user request
      const finalPrompt = `${CLOTHING_PROMPT}\n\nUser request: ${combinePrompt}`.trim();
      fd.append("prompt", finalPrompt);

      fd.append("modelType", modelType);
      fd.append("aspectRatio", ASPECT_RATIO);
      if (modelType === "pro") fd.append("imageSize", "1K");

      const resp = await fetch("/api/nanobanana/advanced-combine", {
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

      const outDataUrl = `data:${mimeType};base64,${base64}`;
      setAiOutputDataUrl(outDataUrl);

      if (outDataUrl.length < 4_000_000) {
        localStorage.setItem("lastAIOutputDataUrl", outDataUrl);
      } else {
        localStorage.removeItem("lastAIOutputDataUrl");
      }

      // ✅ 成功后扣 token
      spend(cost);
    } catch (e: any) {
      console.error(e);
      alert("AI Comp 失败：请看 Console / Network");
    } finally {
      setIsCombining(false);
    }
  }

  function downloadAI() {
    if (!aiOutputDataUrl) return;
    downloadDataUrl(aiOutputDataUrl, "ai_output.png");
  }

  return (
    <div className="space-y-6">
      <div className="rounded-3xl border bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-xl font-semibold">合成 Honolulu 照片</h2>
          <TokenBadge balance={tokenBalance} />
        </div>

        <p className="mt-2 text-sm text-neutral-600">
          上传人物和背景会自动压缩到长边 1080。Reference 会按最长边 ≤ 512 缩放以省 token。
        </p>

        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          {/* 左侧控制面板 */}
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="text-sm font-medium">选择背景（预置/上传）</div>
              <select
                className="w-full rounded-xl border px-3 py-2 text-sm"
                value={bgSrc}
                onChange={(e) => setBgSrc(e.target.value)}
              >
                {bgOptions.map((b) => (
                  <option key={b.id} value={b.src}>
                    {b.name}
                  </option>
                ))}
              </select>

              <div className="mt-2">
                <input
                  type="file"
                  accept="image/png,image/jpeg"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onSelectBgFile(f);
                  }}
                  className="w-full text-sm"
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium">上传人物</div>
              <input
                type="file"
                accept="image/png,image/jpeg"
                disabled={isCutting}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onSelectPersonFile(f);
                }}
                className="w-full text-sm"
              />

              <div className="flex gap-2">
                <button
                  onClick={doRemoveBg}
                  className="w-1/2 rounded-xl bg-neutral-900 px-4 py-2.5 text-sm text-white hover:opacity-90 disabled:opacity-40"
                  disabled={!originalFile || isCutting || !tokenReady || !hasTokens(2)}
                >
                  {isCutting ? "正在抠图..." : "抠图"}
                </button>

                <button
                  onClick={downloadCustomer}
                  className="w-1/2 rounded-xl border px-4 py-2.5 text-sm hover:bg-neutral-50 disabled:opacity-40"
                  disabled={!bgImg}
                >
                  Regular Combine
                </button>
              </div>

              <div className="text-xs text-neutral-500">
                提示：点击人物后可用角点缩放/旋转；也可以直接拖动位置。
              </div>
            </div>

            {/* Reference 上传 */}
            <div className="rounded-2xl border p-4">
              <div className="text-sm font-medium">Reference（可选）</div>
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="file"
                  accept="image/png,image/jpeg"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onSelectReferenceFile(f);
                  }}
                  className="text-sm"
                />
                {referenceDataUrl && (
                  <button
                    className="rounded-xl border px-3 py-1 text-xs hover:bg-neutral-50"
                    onClick={() => {
                      setReferenceDataUrl(null);
                      localStorage.removeItem("lastReferenceDataUrl");
                    }}
                    disabled={isCombining}
                  >
                    移除
                  </button>
                )}
              </div>

              {referenceDataUrl ? (
                <div className="mt-3 overflow-hidden rounded-xl border bg-neutral-50 p-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={referenceDataUrl}
                    alt="reference"
                    className="max-h-[220px] w-full rounded-lg object-contain"
                  />
                  <div className="mt-1 text-[11px] text-neutral-500">
                    已按最长边 ≤ 512 压缩保存
                  </div>
                </div>
              ) : (
                <div className="mt-3 text-xs text-neutral-500">未上传 reference</div>
              )}
            </div>

            {/* 调色（保留原逻辑/参数，只展示最基本控件，避免文件过长） */}
            <div className="rounded-2xl border p-4">
              <div className="text-sm font-medium">调色（人物层）</div>
              <div className="mt-3 space-y-3 text-sm">
                <div>
                  <div className="flex justify-between text-xs text-neutral-600">
                    <span>Gain</span>
                    <span>{grade.gain.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min={0.5}
                    max={2.0}
                    step={0.01}
                    value={grade.gain}
                    onChange={(e) => setGrade((p) => ({ ...p, gain: Number(e.target.value) }))}
                    className="w-full"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-xs text-neutral-600">
                    <span>Gamma</span>
                    <span>{grade.gamma.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min={0.5}
                    max={2.0}
                    step={0.01}
                    value={grade.gamma}
                    onChange={(e) => setGrade((p) => ({ ...p, gamma: Number(e.target.value) }))}
                    className="w-full"
                  />
                </div>

                <button
                  className="w-full rounded-xl border px-3 py-2 text-sm hover:bg-neutral-50"
                  onClick={() => setGrade({ gain: 1, gamma: 1, exposure: 0, temp: 0, tint: 0 })}
                >
                  重置调色
                </button>
              </div>
            </div>

            {/* 阴影（保留原参数，略） */}
            <div className="rounded-2xl border p-4">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">阴影</div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={shadow.enabled}
                    onChange={(e) => setShadow((s) => ({ ...s, enabled: e.target.checked }))}
                  />
                  开启
                </label>
              </div>

              <div className="mt-3 space-y-3">
                <div>
                  <div className="flex items-center justify-between text-xs text-neutral-600">
                    <span>透明度</span>
                    <span>{shadow.opacity.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={0.6}
                    step={0.01}
                    value={shadow.opacity}
                    onChange={(e) =>
                      setShadow((s) => ({
                        ...s,
                        opacity: parseFloat(e.target.value),
                      }))
                    }
                    className="w-full"
                    disabled={!shadow.enabled}
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between text-xs text-neutral-600">
                    <span>模糊</span>
                    <span>{shadow.blur}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={80}
                    step={1}
                    value={shadow.blur}
                    onChange={(e) =>
                      setShadow((s) => ({
                        ...s,
                        blur: parseInt(e.target.value, 10),
                      }))
                    }
                    className="w-full"
                    disabled={!shadow.enabled}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* 中间：画布 + 右侧 AI 区 */}
          <div className="lg:col-span-2 space-y-4">
            <div className="overflow-hidden rounded-2xl border bg-neutral-100">
              <Stage width={STAGE_W} height={STAGE_H} ref={stageRef}>
                <Layer>
                  {bgImg && bgDraw && (
                    <KonvaImage
                      image={bgImg}
                      x={bgDraw.x}
                      y={bgDraw.y}
                      width={bgDraw.width}
                      height={bgDraw.height}
                      listening={false}
                    />
                  )}

                  {shadow.enabled && shadowDraw && (
                    <>
                      <Ellipse
                        ref={outerShadowRef}
                        x={shadowDraw.outer.x}
                        y={shadowDraw.outer.y}
                        radiusX={shadowDraw.outer.radiusX}
                        radiusY={shadowDraw.outer.radiusY}
                        fill="black"
                        opacity={shadowDraw.outer.opacity}
                        scaleY={shadowDraw.outer.scaleY}
                        listening={false}
                        filters={[Konva.Filters.Blur]}
                        blurRadius={shadowDraw.outer.blur}
                      />
                      <Ellipse
                        ref={innerShadowRef}
                        x={shadowDraw.inner.x}
                        y={shadowDraw.inner.y}
                        radiusX={shadowDraw.inner.radiusX}
                        radiusY={shadowDraw.inner.radiusY}
                        fill="black"
                        opacity={shadowDraw.inner.opacity}
                        scaleY={shadowDraw.inner.scaleY}
                        listening={false}
                        filters={[Konva.Filters.Blur]}
                        blurRadius={shadowDraw.inner.blur}
                      />
                    </>
                  )}

                  {personImg && (
                    <>
                      <KonvaImage
                        ref={personNodeRef}
                        image={personImg}
                        x={person.x}
                        y={person.y}
                        draggable
                        rotation={person.rotation}
                        scaleX={person.scale}
                        scaleY={person.scale}
                        onDragMove={() => updatePersonRect()}
                        onDragEnd={(e) => {
                          setPerson((p) => ({ ...p, x: e.target.x(), y: e.target.y() }));
                          updatePersonRect();
                        }}
                        onTransformEnd={() => {
                          const node = personNodeRef.current;
                          const scaleX = node.scaleX();
                          node.scaleX(1);
                          node.scaleY(1);

                          setPerson((p) => ({
                            ...p,
                            x: node.x(),
                            y: node.y(),
                            rotation: node.rotation(),
                            scale: clamp(scaleX, 0.1, 3),
                          }));
                          updatePersonRect();
                        }}
                        onClick={() => trRef.current?.nodes([personNodeRef.current])}
                        onTap={() => trRef.current?.nodes([personNodeRef.current])}
                      />

                      <Transformer
                        ref={trRef}
                        rotateEnabled
                        enabledAnchors={["top-left", "top-right", "bottom-left", "bottom-right"]}
                        boundBoxFunc={(oldBox, newBox) => {
                          if (newBox.width < 30 || newBox.height < 30) return oldBox;
                          return newBox;
                        }}
                      />
                    </>
                  )}
                </Layer>
              </Stage>
            </div>

            <div className="rounded-3xl border bg-white p-6 shadow-sm">
              <div className="grid gap-4 lg:grid-cols-3">
                <div>
                  <div className="text-base font-semibold">AI Comp</div>
                  <div className="mt-1 text-sm text-neutral-600">
                    Image1=场景（<=1024），Image2=Reference（<=512，optional）
                  </div>
                </div>

                <div className="lg:col-span-2 space-y-3">
                  <div className="text-sm font-medium">Prompt</div>
                  <textarea
                    value={combinePrompt}
                    onChange={(e) => setCombinePrompt(e.target.value)}
                    rows={4}
                    className="w-full resize-none rounded-2xl border px-3 py-2 text-sm"
                  />

                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => runAdvancedCombine("nano")}
                      className="rounded-xl bg-neutral-900 px-4 py-2 text-sm text-white hover:opacity-90 disabled:opacity-40"
                      disabled={isCombining || !tokenReady || !hasTokens(1)}
                    >
                      {isCombining ? "AI 合成中..." : "Quick Gen"}
                    </button>

                    <button
                      onClick={() => runAdvancedCombine("pro")}
                      className="rounded-xl border px-4 py-2 text-sm hover:bg-neutral-50 disabled:opacity-40"
                      disabled={isCombining || !tokenReady || !hasTokens(3)}
                    >
                      {isCombining ? "AI 合成中..." : "Pro Gen"}
                    </button>

                    <button
                      onClick={downloadAI}
                      className="rounded-xl border px-4 py-2 text-sm hover:bg-neutral-50 disabled:opacity-40"
                      disabled={!aiOutputDataUrl}
                    >
                      下载 AI
                    </button>
                  </div>
                </div>
              </div>

              <div className="mt-4 overflow-hidden rounded-2xl border bg-neutral-50">
                {aiOutputDataUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={aiOutputDataUrl}
                    alt="ai output"
                    className="h-[420px] w-full object-contain"
                  />
                ) : (
                  <div className="flex h-[420px] items-center justify-center text-sm text-neutral-500">
                    还没有 AI 输出
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-3xl border bg-white p-6 shadow-sm">
        <h3 className="font-semibold">说明</h3>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-neutral-700">
          <li>Reference 采用“最长边 ≤ 512”的等比缩放策略（不裁剪、不变形）。</li>
          <li>AI Comp 会分开发送 Image1（scene）和 Image2（ref），不再拼图。</li>
          <li>Quick/Pro 每次成功生成后扣对应 token。</li>
        </ul>
      </div>
    </div>
  );
}
