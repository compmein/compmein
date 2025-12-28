"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Konva from "konva";
import { Stage, Layer, Image as KonvaImage, Transformer, Ellipse, Rect } from "react-konva";

import { useTokenBalance } from "./useTokenBalance";
import { TokenBadge } from "./TokenBadge";

const DEFAULT_SYSTEM_PROMPT = `
### ROLE: PRECISION IMAGE EDITOR

### INPUTS:
1) Image 1 (Primary): Base scene with person.
2) Image 2 (Reference): Reference for CLOTHING/ACCESSORIES ONLY.

### ABSOLUTE RULES (STRICT ADHERENCE):
1. FACE PRESERVATION: DO NOT modify, redraw, or enhance the person's face from Image 1. Keep all facial features, expression, and identity 100% identical.
2. CLOTHING SWAP: Only apply the clothing, style, or objects from Image 2 onto the body in Image 1.
3. POSE: Maintain the exact body pose and head orientation from Image 1.
4. BLENDING: Integrate the person naturally into the lighting/shadows of the background without altering their identity.
`.trim();
// ✅ Token costs (per click)
const TOKEN_COSTS = {
  CUTOUT: 2,
  QUICK: 1,
  PRO: 3,
} as const;
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

/**
 * ✅ 所有上传图片：自动按“长边 <= maxLongSide”压缩（默认 1080p）
 * - 支持 JPG/PNG
 * - 返回新 File（尺寸变小、体积更小）
 */
async function resizeImageFile(file: File, maxLongSide = 1080, quality = 0.9): Promise<File> {
  // 兼容更多格式（image/*）。如果浏览器能解码，就能在前端压缩。
  if (!file.type.startsWith("image/")) return file;

  // 默认：保持 PNG 透明；其它格式转 JPEG（更省体积/更稳）
  const output: "keep" | "jpeg" | "png" = file.type === "image/png" ? "png" : "jpeg";

  try {
    return await fileToFileMaxSide(file, maxLongSide, output, quality, (file.name || "image").replace(/\.[^/.]+$/, ""));
  } catch {
    return file;
  }
}

/** Blob -> DataURL（用于 localStorage 保存） */
async function blobToDataURL(blob: Blob): Promise<string> {
  return await new Promise<string>((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.readAsDataURL(blob);
  });
}


/** ✅ 通用：把任意图片 File 压到“最长边 <= maxLongSide”，并导出为指定格式（jpeg/png/keep） */
async function fileToDataUrlMaxSide(
  file: File,
  maxLongSide: number,
  output: "keep" | "jpeg" | "png" = "keep",
  quality = 0.9
): Promise<{ dataUrl: string; mimeType: string }> {
  if (!file.type.startsWith("image/")) {
    return { dataUrl: await blobToDataURL(file), mimeType: file.type || "application/octet-stream" };
  }

  const objectUrl = URL.createObjectURL(file);
  const img = new Image();
  img.crossOrigin = "anonymous";

  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Image load failed"));
    img.src = objectUrl;
  });

  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const longSide = Math.max(w, h);

  const scale = Math.min(maxLongSide / longSide, 1);
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));

  const canvas = document.createElement("canvas");
  canvas.width = nw;
  canvas.height = nh;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    URL.revokeObjectURL(objectUrl);
    return { dataUrl: await blobToDataURL(file), mimeType: file.type || "application/octet-stream" };
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, nw, nh);

  let outType: "image/jpeg" | "image/png";
  if (output === "jpeg") outType = "image/jpeg";
  else if (output === "png") outType = "image/png";
  else outType = file.type === "image/png" ? "image/png" : "image/jpeg";

  const blob: Blob = await new Promise((resolve) => {
    canvas.toBlob(
      (b) => resolve(b as Blob),
      outType,
      outType === "image/jpeg" ? quality : undefined
    );
  });

  URL.revokeObjectURL(objectUrl);
  return { dataUrl: await blobToDataURL(blob), mimeType: outType };
}

/** ✅ 同上，但返回 File（用于上传到后端 API，比如 remove-bg） */
async function fileToFileMaxSide(
  file: File,
  maxLongSide: number,
  output: "keep" | "jpeg" | "png" = "keep",
  quality = 0.9,
  filenameHint = "image"
): Promise<File> {
  const { dataUrl, mimeType } = await fileToDataUrlMaxSide(file, maxLongSide, output, quality);
  const blob = await (await fetch(dataUrl)).blob();
  const ext = mimeType === "image/png" ? "png" : "jpg";
  return new File([blob], `${filenameHint}.${ext}`, { type: mimeType });
}


/**
 * ✅ 尝试写入 localStorage（避免 QuotaExceededError 直接让页面崩）
 * - 仅用于较大的 dataURL
 * - 写入失败：删除旧值并忽略（本次会话仍可用 state 正常显示）
 */
function safeSetLocalStorageDataUrl(key: string, dataUrl: string, maxLen = 4_000_000) {
  try {
    // 太大的不存，避免触发配额限制
    if (dataUrl.length > maxLen) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, dataUrl);
  } catch (e) {
    // QuotaExceededError / SecurityError 等
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
  }
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

/**
 * ✅ 统一调色 Filter（避免 Konva 版本差异导致 node.colorMatrix 不存在）
 * 支持：gain / gamma / exposure / temp(冷暖) / tint(绿紫)
 */
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

      // exposure：加法偏移（-1~1 映射到 -35~35）
      const add = exposure * 35;

      // temp：+R -B；tint：+G - (R+B)/2（简化但好用）
      const t = temp * 0.15;
      const ti = tint * 0.15;

      const rGain = gain * (1 + t - ti * 0.5);
      const gGain = gain * (1 + ti);
      const bGain = gain * (1 - t - ti * 0.5);

      // gamma：非线性
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

/** 将 dataURL 下载为文件 */
function downloadDataUrl(dataUrl: string, filename: string) {
  const a = document.createElement("a");
  a.download = filename;
  a.href = dataUrl;
  a.click();
}

/** 尝试从后端透传的 Gemini 报错中解析 safety block 信息 */
function parseGeminiSafetyBlock(rawText: string): {
  isSafetyBlock: boolean;
  finishReason?: string;
  finishMessage?: string;
  modelUsed?: string;
} {
  try {
    const obj = JSON.parse(rawText);
    const finishReason = obj?.raw?.candidates?.[0]?.finishReason;
    const finishMessage = obj?.raw?.candidates?.[0]?.finishMessage;
    const modelUsed = obj?.modelUsed;
    const isSafetyBlock = finishReason === "IMAGE_SAFETY";
    return { isSafetyBlock, finishReason, finishMessage, modelUsed };
  } catch {
    return { isSafetyBlock: false };
  }
}

/** 加载 dataURL 为 HTMLImageElement */
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

/** dataURL -> JPEG Blob，最长边不超过 maxSide（等比缩放，不裁剪不变形） */
async function dataUrlToJpegBlob(dataUrl: string, maxSide: number, quality = 0.85): Promise<Blob> {
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

/** Reference：最长边 ≤ 512（按最长边不超过 512 等比缩放） */
async function dataUrlToRefJpegBlob(dataUrl: string, quality = 0.85): Promise<Blob> {
  return dataUrlToJpegBlob(dataUrl, 512, quality);
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

  // ✅ Token balance (client-only, SSR-safe)
  const { balance: tokenBalance, isReady: tokenReady, hasTokens, spend } = useTokenBalance();
  // ✅ 用户上传背景（保留 1 张）
  const [userBgDataUrl, setUserBgDataUrl] = useState<string | null>(null);

  const bgOptions: BgOption[] = useMemo(() => {
    const userOpt: BgOption[] = userBgDataUrl
      ? [{ id: "user", name: "你上传的背景", src: userBgDataUrl, isUser: true }]
      : [];
    return [...userOpt, ...presetBgOptions];
  }, [presetBgOptions, userBgDataUrl]);

  const [bgSrc, setBgSrc] = useState<string>(() => presetBgOptions[0].src);
  const bgImg = useHtmlImage(bgSrc);

  // 人物（像背景一样：保留 1 张，刷新后还在）
  const [storedPersonDataUrl, setStoredPersonDataUrl] = useState<string | null>(null);
  const [personImg, setPersonImg] = useState<HTMLImageElement | null>(null);

  // ✅ 人物来源选择（与你的背景选择保持一致）
  const [subjectChoice, setSubjectChoice] = useState<"uploaded" | "none">("none");

  // ✅ 保存“压缩后的原始人物文件”（用于点“抠图”时请求 API）
  const [originalFile, setOriginalFile] = useState<File | null>(null);
  const [isCutting, setIsCutting] = useState(false);

  // ✅ 记录最近一次抠图结果（用于“下载抠图”）
  const [cutoutDataUrl, setCutoutDataUrl] = useState<string | null>(null);

  // Reference（像背景一样：dropdown + 保留 1 张）
  const [storedReferenceDataUrl, setStoredReferenceDataUrl] = useState<string | null>(null);
  const [referenceChoice, setReferenceChoice] = useState<"uploaded" | "none">("none");
  const activeReferenceDataUrl = referenceChoice === "uploaded" ? storedReferenceDataUrl : null;

  // ✅ Advanced Combine
  const [combinePrompt, setCombinePrompt] = useState<string>(
    "Integrate the subject naturally into the scene. If there's a reference, use reference for clothing, accessories."
  );

  const [isCombining, setIsCombining] = useState(false);
  const [aiOutputDataUrl, setAiOutputDataUrl] = useState<string | null>(null);

  // 人物变换
  const [person, setPerson] = useState({
    x: 260,
    y: 220,
    scale: 0.7,
    rotation: 0,
  });

  // 人物真实包围盒，用来定位“脚底”
  const [personRect, setPersonRect] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);

  // ✅ 调色：明暗/伽马 + 冷暖 / 绿紫 + 曝光
  const [grade, setGrade] = useState({
    gain: 1.0,
    gamma: 1.0,
    exposure: 0.0,
    temp: 0.0,
    tint: 0.0,
  });

  // ✅ 阴影（恢复你昨天那套：双层 + 真 blur + 左右滑块）
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

  // 背景绘制参数
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

  // 初次加载：恢复上一次人物（优先抠图结果，其次原上传）（各保留 1 张）
  useEffect(() => {
    const savedCutout = localStorage.getItem("lastCutPngDataUrl");
    const savedPerson = localStorage.getItem("lastPersonDataUrl");

    const pick = savedCutout || savedPerson;
    if (!pick) return;

    if (savedCutout) setCutoutDataUrl(savedCutout);

    setStoredPersonDataUrl(pick);
    setSubjectChoice("uploaded");

    const img = new window.Image();
    img.onload = () => setPersonImg(img);
    img.src = pick;
  }, []);

  // 初次加载：恢复上一次上传背景/Reference/AI 输出（各保留 1 张）
  useEffect(() => {
    const savedBg = localStorage.getItem("lastBgDataUrl");
    if (savedBg) setUserBgDataUrl(savedBg);

    const savedRef = localStorage.getItem("lastReferenceDataUrl");
    if (savedRef) {
      setStoredReferenceDataUrl(savedRef);
      setReferenceChoice("uploaded");
    }

    const savedAI = localStorage.getItem("lastAIOutputDataUrl");
    if (savedAI) setAiOutputDataUrl(savedAI);
  }, []);

  // 初次加载：恢复上次调色/阴影参数
  useEffect(() => {
    const g = localStorage.getItem("lastGrade");
    const s = localStorage.getItem("lastShadow");
    if (g) setGrade((p) => ({ ...p, ...JSON.parse(g) }));
    if (s) setShadow((p) => ({ ...p, ...JSON.parse(s) }));
  }, []);

  // 保存调色/阴影参数
  useEffect(() => {
    localStorage.setItem("lastGrade", JSON.stringify(grade));
  }, [grade]);
  useEffect(() => {
    localStorage.setItem("lastShadow", JSON.stringify(shadow));
  }, [shadow]);

  // Transformer 绑定人物
  useEffect(() => {
    if (!trRef.current || !personNodeRef.current) return;
    trRef.current.nodes([personNodeRef.current]);
    trRef.current.getLayer()?.batchDraw();
    setTimeout(() => updatePersonRect(), 0);
  }, [personImg]);

  // ✅ 不再在这里强制把 uploaded 打回 none（上传流程是 async，容易发生竞态导致看不到人物）

  // ✅ 根据 dropdown 选择，切换人物显示（不删除已保存的那张）
  useEffect(() => {
    if (subjectChoice === "none") {
      setPersonImg(null);
      return;
    }
    if (!storedPersonDataUrl) {
      setPersonImg(null);
      return;
    }
    const img = new window.Image();
    img.onload = () => setPersonImg(img);
    img.src = storedPersonDataUrl;
  }, [subjectChoice, storedPersonDataUrl]);

  // 阴影绘制参数（基于人物包围盒脚底）
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

  // Blur 生效关键：cache + filters
  useEffect(() => {
    if (!shadowDraw) return;
    outerShadowRef.current?.cache();
    innerShadowRef.current?.cache();
    stageRef.current?.getStage?.()?.batchDraw?.();
  }, [shadowDraw]);

  /** ✅ 上传人物：只预览（不自动抠图），并按 1080p 压缩后保存 originalFile */
  async function onSelectPersonFile(file: File) {
    const resized = await resizeImageFile(file, 1080, 0.9);
    setOriginalFile(resized);

    // 新上传人物后：切换为“已上传人物”，并清除旧的抠图下载缓存
    setSubjectChoice("uploaded");
    setCutoutDataUrl(null);
    try {
      localStorage.removeItem("lastCutPngDataUrl");
    } catch {}

    const url = URL.createObjectURL(resized);
    const img = new window.Image();
    img.onload = () => setPersonImg(img);
    img.src = url;
  }

  /** ✅ 上传背景：按 1080p 压缩，并保留 1 张（localStorage） */
  async function onSelectBgFile(file: File) {
    const resized = await resizeImageFile(file, 1080, 0.9);
    const dataUrl = await blobToDataURL(resized);
    setUserBgDataUrl(dataUrl);
    safeSetLocalStorageDataUrl("lastBgDataUrl", dataUrl);
    setBgSrc(dataUrl);
  }

  /** ✅ 上传 reference：按 1080p 压缩，并保留 1 张（localStorage） */
  async function onSelectReferenceFile(file: File) {
    const resized = await resizeImageFile(file, 1080, 0.9);
    const dataUrl = await blobToDataURL(resized);
    setStoredReferenceDataUrl(dataUrl);
    // localStorage 容量有限：写入失败也不要让页面崩（本次会话仍可用）
    safeSetLocalStorageDataUrl("lastReferenceDataUrl", dataUrl);
  }

  /** ✅ 抠图按键触发 */
  async function doRemoveBg() {
    if (!originalFile) {
      alert("请先上传一张人物 JPG/PNG，然后再点“抠图”");
      return;
    }

    if (!tokenReady) {
      alert("Token 正在加载，请稍等…");
      return;
    }

    if (!hasTokens(TOKEN_COSTS.CUTOUT)) {
      alert(`Token 不够：抠图需要 ${TOKEN_COSTS.CUTOUT} Tokens`);
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

      const blob = await resp.blob(); // 透明 PNG
      const url = URL.createObjectURL(blob);

      const img = new window.Image();
      img.onload = () => setPersonImg(img);
      img.src = url;

      // 保存“上一次抠图”（并用于“下载抠图”）
      try {
        const dataUrl = await blobToDataURL(blob);
        setCutoutDataUrl(dataUrl);
        safeSetLocalStorageDataUrl("lastCutPngDataUrl", dataUrl);

        // ✅ 抠图后，把“当前人物”也更新为抠图结果（刷新后仍是抠图人物）
        setStoredPersonDataUrl(dataUrl);
        safeSetLocalStorageDataUrl("lastPersonDataUrl", dataUrl);

        const img2 = new window.Image();
        img2.onload = () => setPersonImg(img2);
        img2.src = dataUrl;
      } catch {
        // ignore
      }

      // ✅ Only spend tokens after success
      spend(TOKEN_COSTS.CUTOUT);
    } catch (err) {
      console.error(err);
      alert("抠图失败：请看 F12 → Network → /api/remove-bg 的状态码/返回内容");
    } finally {
      setIsCutting(false);
    }
  }

  /** ✅ 对人物图片应用 filters（调色） */
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

  /** ✅ 导出“客户手动合成图”（不带 reference 面板、不带蓝框） */
  function exportCustomerDataUrl() {
    const stage = stageRef.current;
    if (!stage) return null;

    const tr = trRef.current;
    const prevNodes = tr?.nodes?.() ?? [];

    // hide transformer + canvas for customer download
    tr?.nodes([]);
    stage.batchDraw();

    const uri = stage.toDataURL({ pixelRatio: 2 });

    // restore
    tr?.nodes(prevNodes);
    stage.batchDraw();

    return uri as string;
  }

  /** ✅ 导出给 Nano Banana 的输入图（包含蓝框作为输出边界） */
  function exportAiStageDataUrl() {
    const stage = stageRef.current;
    if (!stage) return null;

    const tr = trRef.current;
    const prevNodes = tr?.nodes?.() ?? [];

    // hide transformer only (keep canvas)
    tr?.nodes([]);
    stage.batchDraw();

    const uri = stage.toDataURL({ pixelRatio: 2 });

    // restore
    tr?.nodes(prevNodes);
    stage.batchDraw();

    return uri as string;
  }

  /** ✅ 下载抠图 PNG（不触发任何 API） */
  async function downloadCutout() {
    if (cutoutDataUrl) {
      downloadDataUrl(cutoutDataUrl, "cutout.png");
      return;
    }

    const src = personImg?.src;
    if (!src) return;
    try {
      const blob = await (await fetch(src)).blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.download = "cutout.png";
      a.href = url;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      console.warn(e);
      alert("下载抠图失败：请先点一次“抠图”生成透明 PNG");
    }
  }

  /** ✅ 下载客户手动合成图 */
  function downloadCustomer() {
    const uri = exportCustomerDataUrl();
    if (!uri) return;
    downloadDataUrl(uri, "customer_output.png");
  }

  /** ✅ Advanced Combine：只有在有 reference 时才可用（按你的规则） */
  async function runAdvancedCombine(modelType: "nano" | "pro") {
    const stage = stageRef.current;
    if (!stage) return;

    const cost = modelType === "pro" ? TOKEN_COSTS.PRO : TOKEN_COSTS.QUICK;
    if (!tokenReady) {
      alert("Token 正在加载，请稍等…");
      return;
    }
    if (!hasTokens(cost)) {
      alert(`Token 不够：${modelType === "pro" ? "Pro" : "Quick"} 需要 ${cost} Tokens`);
      return;
    }

    setIsCombining(true);
    try {
      // 1) 导出 Nano Banana 输入用的左侧 stage（包含蓝框作为输出边界）
      const stageDataUrl = exportAiStageDataUrl();
      if (!stageDataUrl) throw new Error("Failed to export stage image");

      // 2) Image 1：scene（最长边 ≤ 1024，JPG，省 token）
      const sceneBlob = await dataUrlToJpegBlob(stageDataUrl, 1024, 0.85);

      const fd = new FormData();
      fd.append("image", sceneBlob, "scene.jpg");

      // 3) Image 2：reference（可选，最长边 ≤ 512，等比缩放）
      if (activeReferenceDataUrl) {
        const refBlob = await dataUrlToRefJpegBlob(activeReferenceDataUrl, 0.85);
        fd.append("refImage", refBlob, "reference.jpg");
      }
      // Pro 模型更容易触发安全过滤：追加“家庭友好/非色情/无裸露”的明确约束，降低误伤
      const safetySuffix =
        modelType === "pro"
          ? "\n\nSafety constraints:\nThis is a wholesome, family-friendly image. No nudity, no sexual content, no fetish content, and no suggestive focus. Keep attire appropriate and non-revealing."
          : "";

      // 2) 新增：强制脸部一致性的指令（Face Strict Suffix）
      const faceStrictSuffix = `
### MANDATORY: 
- THE PERSON'S FACE FROM IMAGE 1 IS SACROSANCT. 
- KEEP THE EYES, NOSE, MOUTH, AND IDENTITY 100% IDENTICAL TO IMAGE 1. 
- DO NOT APPLY ANY FEATURES FROM IMAGE 2 TO THE PERSON'S FACE.
`.trim();

      // 3) 组合成最终发送给 Nano Banana 的 Prompt
      const finalPrompt = `${DEFAULT_SYSTEM_PROMPT}

${faceStrictSuffix}
${safetySuffix}

User request:
${combinePrompt}`;
      fd.append("prompt", finalPrompt);
fd.append("modelType", modelType);
      fd.append("aspectRatio", "16:9");
      fd.append("imageSize", "1K");

      const resp = await fetch("/api/nanobanana/advanced-combine", {
        method: "POST",
        body: fd,
      });

      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        const safety = parseGeminiSafetyBlock(txt);
        if (safety.isSafetyBlock) {
          // Gemini Pro 被安全策略拦截时，给出可操作的提示（不会计费）
          alert(
            `Pro Generation was blocked by the model safety filter (${safety.modelUsed || "Gemini"}).\n\n` +
              `How to fix:\n` +
              `1) Try a more neutral prompt (e.g. “family-friendly vacation photo, keep everything modest, no nudity”).\n` +
              `2) Avoid revealing outfits / swimsuit-heavy scenes (Pro is stricter).\n` +
              `3) If needed, remove the reference image and test again to isolate what triggers the block.\n\n` +
              `Message: ${safety.finishMessage || "IMAGE_SAFETY"}`
          );
          return;
        }
        throw new Error(txt || `HTTP ${resp.status}`);
      }

      const json = await resp.json();
      const base64 = json?.imageBase64;
      const mimeType = json?.mimeType || "image/png";
      if (!base64) throw new Error("No image returned.");

      const outDataUrl = `data:${mimeType};base64,${base64}`;
      setAiOutputDataUrl(outDataUrl);

      // ✅ Only spend tokens after success
      spend(cost);

      // 保存 AI 输出（至少 1 张）
      if (outDataUrl.length < 4_000_000) {
        localStorage.setItem("lastAIOutputDataUrl", outDataUrl);
      } else {
        localStorage.removeItem("lastAIOutputDataUrl");
      }
    } catch (e: any) {
      console.error(e);
      const msg = typeof e?.message === "string" && e.message.trim() ? e.message : "AI Comp 失败：请看 Console / Network";
      alert(msg);
    } finally {
      setIsCombining(false);
    }
  }

  /** ✅ 下载 AI 输出 */
  function downloadAI() {
    if (!aiOutputDataUrl) return;
    downloadDataUrl(aiOutputDataUrl, "ai_output.png");
  }
return (
    <div className="space-y-6">
      <div className="rounded-3xl border bg-white p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-xl font-semibold">合成 Honolulu 照片</h2>
          <TokenBadge balance={tokenBalance} />
        </div>
        <p className="mt-2 text-sm text-neutral-600">
          上传人物和背景会<strong>自动压缩到长边 1080p</strong>（更快、更稳定）。
          人物不会自动抠图，点 <strong>“抠图”</strong> 才会请求 API。系统会保留你上一次抠过的人物和上一次上传的背景（各 1 张）。
        </p>

        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          {/* 左侧控制面板 */}
          <div className="space-y-4">
            {/* ✅ 素材：背景（可折叠，默认展开） */}
            <details open className="rounded-2xl border p-4">
              <summary className="cursor-pointer select-none text-sm font-medium">选择背景（预置/上传）</summary>

              <div className="mt-2 space-y-2">
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
                    accept="image/*"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) onSelectBgFile(f);
                    }}
                    className="w-full text-sm"
                  />
                  <div className="mt-1 text-xs text-neutral-500">
                    上传背景会自动保存 1 张（刷新后还在）。如果不满意预置背景，可直接上传自己的。
                  </div>
                </div>
              </div>
            </details>

            {/* ✅ 素材：人物 + 抠图 + Regular 下载（可折叠，默认展开） */}
            <details open className="rounded-2xl border p-4">
              <summary className="cursor-pointer select-none text-sm font-medium">选择人物（上传/暂无）</summary>

              <div className="mt-2 space-y-2">
                <select
                  className="w-full rounded-xl border px-3 py-2 text-sm"
                  value={subjectChoice}
                  onChange={(e) => {
                    const v = e.target.value as "uploaded" | "none";
                    setSubjectChoice(v);
                    if (v === "none") {
                      setPersonImg(null);
                    }
                  }}
                >
                  <option value="none">暂无人物</option>
                  <option value="uploaded" disabled={!storedPersonDataUrl}>
                    {storedPersonDataUrl ? "你上传的人物" : "你上传的人物（未上传）"}
                  </option>
                </select>

                <div className="mt-2">
                  <input
                    type="file"
                    accept="image/*"
                    disabled={isCutting}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) onSelectPersonFile(f);
                    }}
                    className="w-full text-sm"
                  />
                  <div className="mt-1 text-xs text-neutral-500">
                    上传人物会自动压缩到长边 1080p。选择“暂无人物”可让 AI 仅基于背景生成。
                  </div>
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={doRemoveBg}
                    className="w-1/2 rounded-xl bg-neutral-900 px-4 py-2.5 text-sm text-white hover:opacity-90 disabled:opacity-40"
                    disabled={!originalFile || isCutting || !hasTokens(TOKEN_COSTS.CUTOUT)}
                    title={!hasTokens(TOKEN_COSTS.CUTOUT) ? `Not enough tokens (requires ${TOKEN_COSTS.CUTOUT})` : ""}
                  >
                    {isCutting ? "正在抠图..." : `抠图 · ${TOKEN_COSTS.CUTOUT} Tokens`}
                  </button>

                  <button
                    onClick={downloadCutout}
                    className="w-1/2 rounded-xl border px-4 py-2.5 text-sm hover:bg-neutral-50 disabled:opacity-40"
                    disabled={!cutoutDataUrl}
                    title={!cutoutDataUrl ? "请先点一次“抠图”生成透明 PNG" : ""}
                  >
                    下载抠图
                  </button>
                </div>

                <button
                  onClick={downloadCustomer}
                  className="w-full rounded-xl border px-4 py-2.5 text-sm hover:bg-neutral-50 disabled:opacity-40"
                  disabled={!bgImg}
                >
                  Regular Comp - download
                </button>

                <div className="text-xs text-neutral-500">提示：点击人物后可用角点缩放/旋转；也可以直接拖动位置。</div>
              </div>
            </details>

            {/* ✅ 阴影控制（可折叠，默认展开） */}
            <details open className="rounded-2xl border p-4">
              <summary className="cursor-pointer select-none text-sm font-medium">阴影</summary>

              <div className="mt-2">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium" />
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
                      <span>左右移动</span>
                      <span>{shadow.xOffset}</span>
                    </div>
                    <input
                      type="range"
                      min={-80}
                      max={80}
                      step={1}
                      value={shadow.xOffset}
                      onChange={(e) =>
                        setShadow((s) => ({
                          ...s,
                          xOffset: parseInt(e.target.value, 10),
                        }))
                      }
                      className="w-full"
                      disabled={!shadow.enabled}
                    />
                  </div>

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
                      <span>模糊（外层）</span>
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
                    <div className="mt-1 text-[11px] text-neutral-500">这是“真模糊”（filters+cache）。外层建议 25~60。</div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between text-xs text-neutral-600">
                      <span>宽度（越大越窄）</span>
                      <span>{shadow.widthFactor.toFixed(1)}</span>
                    </div>
                    <input
                      type="range"
                      min={0.8}
                      max={3.5}
                      step={0.1}
                      value={shadow.widthFactor}
                      onChange={(e) =>
                        setShadow((s) => ({
                          ...s,
                          widthFactor: parseFloat(e.target.value),
                        }))
                      }
                      className="w-full"
                      disabled={!shadow.enabled}
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between text-xs text-neutral-600">
                      <span>高度</span>
                      <span>{shadow.height}</span>
                    </div>
                    <input
                      type="range"
                      min={6}
                      max={60}
                      step={1}
                      value={shadow.height}
                      onChange={(e) =>
                        setShadow((s) => ({
                          ...s,
                          height: parseInt(e.target.value, 10),
                        }))
                      }
                      className="w-full"
                      disabled={!shadow.enabled}
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between text-xs text-neutral-600">
                      <span>上下位置</span>
                      <span>{shadow.yOffset}</span>
                    </div>
                    <input
                      type="range"
                      min={-20}
                      max={80}
                      step={1}
                      value={shadow.yOffset}
                      onChange={(e) =>
                        setShadow((s) => ({
                          ...s,
                          yOffset: parseInt(e.target.value, 10),
                        }))
                      }
                      className="w-full"
                      disabled={!shadow.enabled}
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between text-xs text-neutral-600">
                      <span>压扁（Y）</span>
                      <span>{shadow.squashY.toFixed(2)}</span>
                    </div>
                    <input
                      type="range"
                      min={0.3}
                      max={1.3}
                      step={0.01}
                      value={shadow.squashY}
                      onChange={(e) =>
                        setShadow((s) => ({
                          ...s,
                          squashY: parseFloat(e.target.value),
                        }))
                      }
                      className="w-full"
                      disabled={!shadow.enabled}
                    />
                  </div>

                  <div className="mt-2 text-[11px] text-neutral-500">
                    半身照没脚时：优先调 <b>上下位置</b> + <b>透明度</b> + <b>模糊</b>。
                  </div>
                </div>
              </div>
            </details>

            {/* ✅ 调色控制（可折叠，默认展开） */}
            <details open className="rounded-2xl border p-4">
              <summary className="cursor-pointer select-none text-sm font-medium">调色（明暗 / 冷暖 / 绿紫）</summary>

              <div className="mt-3 space-y-3 text-sm">
                <div>
                  <div className="flex justify-between text-xs text-neutral-600">
                    <span>Gain（整体强度）</span>
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
                    <span>Gamma（中间调）</span>
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

                <div>
                  <div className="flex justify-between text-xs text-neutral-600">
                    <span>Exposure（亮度偏移）</span>
                    <span>{grade.exposure.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min={-1}
                    max={1}
                    step={0.01}
                    value={grade.exposure}
                    onChange={(e) => setGrade((p) => ({ ...p, exposure: Number(e.target.value) }))}
                    className="w-full"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-xs text-neutral-600">
                    <span>冷暖（Blue ⇄ Yellow）</span>
                    <span>{grade.temp.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min={-1}
                    max={1}
                    step={0.01}
                    value={grade.temp}
                    onChange={(e) => setGrade((p) => ({ ...p, temp: Number(e.target.value) }))}
                    className="w-full"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-xs text-neutral-600">
                    <span>绿紫（Green ⇄ Magenta）</span>
                    <span>{grade.tint.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min={-1}
                    max={1}
                    step={0.01}
                    value={grade.tint}
                    onChange={(e) => setGrade((p) => ({ ...p, tint: Number(e.target.value) }))}
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
            </details>
          </div>

          {/* 中间：画布 */}
          <div className="lg:col-span-2 space-y-4">
            <div className="flex gap-4">
              <div className="flex-1">
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

                      {/* 阴影（一定在人物下面） */}
                      {shadowDraw && (
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

                    {/* ✅ Blue frame boundary (AI should only output inside this frame) */}
</Stage>
                </div>

                <div className="mt-2 text-xs text-neutral-500">
                  说明：背景等比缩放不拉伸；调色只作用于人物层；下载会自动去掉蓝色框。
                </div>
              </div>

              {/* 右侧 reference 面板：只有上传后才显示 */}
              {activeReferenceDataUrl && (
                <div className="w-[280px] shrink-0 rounded-2xl border-4 border-black bg-white p-4 overflow-hidden">
                  <div className="text-center text-sm font-semibold">
                    Reference Clothing/Object/Pose
                  </div>
                  <div className="mt-3 rounded-xl border-4 border-black p-4 h-[440px] overflow-hidden flex flex-col">
                    <div className="text-center text-lg font-medium">Uploaded pic</div>
                    <div className="mt-3 flex items-center justify-center overflow-hidden">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={activeReferenceDataUrl!}
                        alt="reference"
                        className="max-h-[260px] max-w-[200px] w-auto rounded-lg object-contain"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* ✅ AI Comp 区块（可折叠，默认展开） */}
            <details open className="rounded-3xl border bg-white p-6 shadow-sm">
              <summary className="cursor-pointer select-none text-base font-semibold">AI Comp</summary>

              <div className="mt-2 text-lg font-semibold text-neutral-900">AI Comp 不需要抠图也可以用！</div>
              <div className="mt-1 text-sm text-neutral-600">Cutout（抠图）是可选项：想省 Token，直接用原图也能跑 AI Comp。</div>

              <div className="mt-3 grid gap-4 lg:grid-cols-3">
                <div>
                  <div className="mt-1 text-sm text-neutral-600">(Integrate char into the scene)</div>
                  <div className="mt-4 text-xs text-neutral-500">
                    reference 是可选的：没有 reference 也可以运行 AI Comp；如果上传了 reference，则会参考 clothing/object/pose。
                    <div className="mt-2 text-red-600">
                      Quick Generation（{TOKEN_COSTS.QUICK} Token） uses Nano Banana.
                      <br />
                      Pro Generation（{TOKEN_COSTS.PRO} Tokens） uses Nano Banana Pro.
                      <br />
                      Pro costs more and is slower however with better result.
                    </div>
                  </div>
                </div>

                <div className="lg:col-span-2 space-y-3">
                  <div className="text-sm font-medium">Prompt</div>
                  <textarea
                    value={combinePrompt}
                    onChange={(e) => setCombinePrompt(e.target.value)}
                    rows={4}
                    className="w-full resize-none rounded-2xl border px-3 py-2 text-sm"
                    placeholder="e.g. Integrate char into the scene, standing on the grass, holding flowers, wearing reference clothing."
                  />

                  <div className="flex flex-wrap gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="text-sm font-medium">Reference</div>
                      <select
                        className="rounded-xl border px-3 py-2 text-sm"
                        value={referenceChoice}
                        onChange={(e) => setReferenceChoice(e.target.value as "uploaded" | "none")}
                      >
                        <option value="none">暂无 Reference</option>
                        <option value="uploaded" disabled={!storedReferenceDataUrl}>
                          {storedReferenceDataUrl ? "你上传的 Reference" : "你上传的 Reference（未上传）"}
                        </option>
                      </select>

                      <input
                        type="file"
                        accept="image/*"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) onSelectReferenceFile(f);
                        }}
                        className="text-sm"
                      />
                    </div>

                    <div className="flex gap-2">
                      <button
                        onClick={() => runAdvancedCombine("nano")}
                        className="w-1/2 rounded-xl bg-neutral-900 px-4 py-2 text-sm text-white hover:opacity-90 disabled:opacity-40"
                        disabled={isCombining || !hasTokens(TOKEN_COSTS.QUICK)}
                        title={!hasTokens(TOKEN_COSTS.QUICK) ? `Not enough tokens (requires ${TOKEN_COSTS.QUICK})` : "Use gemini-3-flash-preview"}
                      >
                        {isCombining ? "AI 合成中..." : `Quick Generation · ${TOKEN_COSTS.QUICK} Token`}
                      </button>

                      <button
                        onClick={() => runAdvancedCombine("pro")}
                        className="w-1/2 rounded-xl border px-4 py-2 text-sm hover:bg-neutral-50 disabled:opacity-40"
                        disabled={isCombining || !hasTokens(TOKEN_COSTS.PRO)}
                        title={!hasTokens(TOKEN_COSTS.PRO) ? `Not enough tokens (requires ${TOKEN_COSTS.PRO})` : "Use gemini-3-pro-image-preview"}
                      >
                        {isCombining ? "AI 合成中..." : `Pro Generation · ${TOKEN_COSTS.PRO} Tokens`}
                      </button>
                    </div>

                    {activeReferenceDataUrl && (
                      <button
                        onClick={() => {
                          setReferenceChoice("none");
                        }}
                        className="rounded-xl border px-4 py-2 text-sm hover:bg-neutral-50"
                        disabled={isCombining}
                      >
                        Remove reference
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </details>

            {/* ✅ 输出分区：客户生成 vs AI 生成（你要的重点） */}
            <div className="grid gap-4">
              <details open className="rounded-3xl border bg-white p-6 shadow-sm">
                <summary className="cursor-pointer select-none text-base font-semibold">AI 输出</summary>

                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-base font-semibold">AI Comp</div>
                    <div className="text-sm text-neutral-600">（AI Comp 输出）</div>
                  </div>
                  <button
                    onClick={downloadAI}
                    className="rounded-xl bg-neutral-900 px-4 py-2 text-sm text-white hover:opacity-90 disabled:opacity-40"
                    disabled={!aiOutputDataUrl}
                  >
                    下载
                  </button>
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
                      还没有 AI 输出（直接运行 AI Comp；reference 可选）
                    </div>
                  )}
                </div>

                {aiOutputDataUrl && (
                  <button
                    className="mt-3 w-full rounded-xl border px-3 py-2 text-sm hover:bg-neutral-50"
                    onClick={() => {
                      setAiOutputDataUrl(null);
                      localStorage.removeItem("lastAIOutputDataUrl");
                    }}
                  >
                    清空 AI 输出
                  </button>
                )}
              </details>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-3xl border bg-white p-6 shadow-sm">
        <h3 className="font-semibold">说明</h3>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-neutral-700">
          <li>没有 reference：你只需要下载“Regular Combine”。</li>
          <li>有 reference：AI Comp 会分开发送：Image 1=客户合成截图（含蓝框边界），Image 2=Reference（可选）。</li>
          <li>AI Comp 输出会单独显示在下方，并可单独下载。</li>
        </ul>
      </div>
    </div>
  );
}