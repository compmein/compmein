"use client";

import { supabase } from "@/lib/supabaseClient";
import React, { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Konva from "konva";
import { Stage, Layer, Image as KonvaImage, Transformer, Ellipse } from "react-konva";
import { useTokenBalance } from "../components/useTokenBalance";
import { SubjectSection } from "./components/SubjectSection";
import AppHeader from "../components/AppHeader";

const DEFAULT_SYSTEM_PROMPT = `
### ROLE: PRECISION IMAGE EDITOR

### INPUTS:
1) Image 1 (Primary): Base scene with one or multiple subjects. If any subjects are cropped or partial, naturally extend the missing areas of the scene and body.
2) Image 2 (Reference): Reference for CLOTHING/ACCESSORIES ONLY.

### ABSOLUTE RULES (STRICT ADHERENCE):
1. FACE PRESERVATION: DO NOT modify, redraw, or enhance the person's face from Image 1. Keep all facial features, expression, and identity 100% identical.
2. CLOTHING SWAP: Only apply the clothing, style, or objects from Image 2 onto the body in Image 1.
3. BLENDING: Integrate the person naturally into the lighting/shadows of the background without altering their identity.
`.trim();

// ✅ Token costs (per click) — UI only
const TOKEN_COSTS = {
  CUTOUT: 1,
  QUICK: 15,
  PRO: 45,
} as const;

type BgOption = { id: string; name: string; src: string; isUser?: boolean };

// =======================
// ✅ Aspect ratio (Gemini allowed) + SAFE SIZE MAP (≤ 4MP)
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

function aspectToNumber(a: AllowedAR) {
  const [w, h] = a.split(":").map(Number);
  return w / h;
}

function pickClosestAspectRatio(targetW: number, targetH: number): AllowedAR {
  const target = targetW / targetH;
  let best: AllowedAR = "1:1";
  let bestDiff = Infinity;

  for (const a of ALLOWED_ASPECTS) {
    const r = aspectToNumber(a);
    const diff = Math.abs(Math.log(target / r));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = a;
    }
  }
  return best;
}

/**
 * ✅ SAFE SIZE MAP（≤4MP，吃满 Pro 档但不超 4MP）
 * - 21:9 使用 1472×632（≈0.93MP）解决高度太矮，同时避开 1.05MP 踩线
 */
const SAFE_STAGE_SIZE_MAP: Record<AllowedAR, { w: number; h: number }> = {
  // ✅ 4MP-safe master sizes (all <= 4.00MP)
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

function stageSizeFromAllowedAR(ar: AllowedAR) {
  return SAFE_STAGE_SIZE_MAP[ar] ?? SAFE_STAGE_SIZE_MAP["16:9"];
}

function mpText(w: number, h: number) {
  const mp = (w * h) / 1_000_000;
  return `${mp.toFixed(2)}MP`;
}

function maxSideForAR(ar: AllowedAR) {
  const s = stageSizeFromAllowedAR(ar);
  return Math.max(s.w, s.h);
}

/** ✅ cover 裁切：背景铺满舞台，无留白，必要时居中裁剪 */
function computeCoverCrop(imgW: number, imgH: number, stageW: number, stageH: number) {
  const scale = Math.max(stageW / imgW, stageH / imgH); // cover
  const cropW = stageW / scale;
  const cropH = stageH / scale;
  const cropX = (imgW - cropW) / 2;
  const cropY = (imgH - cropH) / 2;

  return {
    cropX: Math.max(0, cropX),
    cropY: Math.max(0, cropY),
    cropWidth: Math.min(imgW, cropW),
    cropHeight: Math.min(imgH, cropH),
  };
}

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

/**
 * ✅ 所有上传图片：自动按“长边 <= maxLongSide”压缩
 * - 支持 JPG/PNG
 * - 返回新 File（尺寸变小、体积更小）
 */
async function resizeImageFile(file: File, maxLongSide = 1080, quality = 1): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  const output: "keep" | "jpeg" | "png" = file.type === "image/png" ? "png" : "jpeg";

  try {
    return await fileToFileMaxSide(
      file,
      maxLongSide,
      output,
      quality,
      (file.name || "image").replace(/\.[^/.]+$/, "")
    );
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
  quality = 1
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
    canvas.toBlob((b) => resolve(b as Blob), outType, outType === "image/jpeg" ? quality : undefined);
  });

  URL.revokeObjectURL(objectUrl);
  return { dataUrl: await blobToDataURL(blob), mimeType: outType };
}

/** ✅ 同上，但返回 File（用于上传到后端 API，比如 remove-bg） */
async function fileToFileMaxSide(
  file: File,
  maxLongSide: number,
  output: "keep" | "jpeg" | "png" = "keep",
  quality = 1,
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
 */
function safeSetLocalStorageDataUrl(key: string, dataUrl: string, maxLen = 4_000_000) {
  try {
    if (dataUrl.length > maxLen) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, dataUrl);
  } catch {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
  }
}

// ✅ Persist a single uploaded background safely:
// - Try localStorage (small dataUrl)
// - Fallback to IndexedDB blob (large dataUrl)
async function persistUploadedBg(dataUrl: string) {
  try {
    // try localStorage first
    const prev = localStorage.getItem("lastBgDataUrl");
    safeSetLocalStorageDataUrl("lastBgDataUrl", dataUrl);
    const now = localStorage.getItem("lastBgDataUrl");
    if (now && now === dataUrl) {
      localStorage.setItem("lastBgWhere", "ls");
      // clear idb copy to save space
      try {
        await idbDel("lastBgBlob");
      } catch {}
      return;
    }

    // fallback to idb
    const blob = await dataUrlToBlob(dataUrl);
    await idbSet("lastBgBlob", blob);
    localStorage.setItem("lastBgWhere", "idb");
    localStorage.removeItem("lastBgDataUrl");
  } catch {
    // if anything fails, at least attempt to clear broken keys
    try {
      localStorage.removeItem("lastBgDataUrl");
      localStorage.setItem("lastBgWhere", "none");
    } catch {}
  }
}


// --- IndexedDB helpers (store large images safely; avoids localStorage quota) ---
const IDB_DB = "dreamcombine";
const IDB_STORE = "kv";

function idbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key: string, value: any) {
  const db = await idbOpen();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet<T = any>(key: string): Promise<T | null> {
  const db = await idbOpen();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve((req.result as T) ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbDel(key: string) {
  const db = await idbOpen();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const resp = await fetch(dataUrl);
  return await resp.blob();
}

function blobToDataUrl2(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

/**
 * ✅ 统一调色 Filter（避免 Konva 版本差异导致 node.colorMatrix 不存在）
 */
function ensureGradeFilter() {
  // @ts-ignore
  Konva.Filters ??= {};

  // @ts-ignore
  if (!Konva.Filters.__grade) {
    // @ts-ignore
    Konva.Filters.__grade = function (imageData: ImageData) {
      // @ts-ignore
      const g = this.__gradeValue ?? { gain: 1, gamma: 1, exposure: 0, temp: 0, tint: 0 };

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

/** 将 dataURL 下载为文件 */
function downloadDataUrl(dataUrl: string, filename: string) {
  const a = document.createElement("a");
  a.download = filename;
  a.href = dataUrl;
  a.click();
}

function dataUrlExt(dataUrl: string) {
  if (dataUrl.startsWith("data:image/jpeg")) return "jpg";
  if (dataUrl.startsWith("data:image/png")) return "png";
  if (dataUrl.startsWith("data:image/webp")) return "webp";
  return "jpg";
}

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

async function loadImageSizeFromFile(file: File): Promise<{ w: number; h: number }> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Failed to load image"));
      img.src = url;
    });
    return { w: img.naturalWidth || img.width, h: img.naturalHeight || img.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Reference：最长边 ≤ 512 */
async function dataUrlToRefJpegBlob(dataUrl: string, quality = 1): Promise<Blob> {
  const img = await loadImageFromDataUrl(dataUrl);

  const w = img.width;
  const h = img.height;
  const scale = Math.min(512 / Math.max(w, h), 1);
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

export default function CreatePage() {
  // ✅ Auth guard
  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) window.location.replace("/login");
    })();
  }, []);

  const presetBgOptions: BgOption[] = useMemo(
    () => [
      { id: "waikiki", name: "Waikiki Beach", src: "/bg/waikiki.png" },
      { id: "diamond", name: "Diamond Head", src: "/bg/diamondhead.jpg" },
      { id: "night", name: "Honolulu Night", src: "/bg/night.jpg" },
    ],
    []
  );

  const { balance: tokenBalance, isReady: tokenReady, hasTokens, refresh } = useTokenBalance();

  // ✅ 当前 canvas/Gemini 锁定的 aspect ratio（必须是 Gemini 允许的值）
  const [stageAR, setStageAR] = useState<AllowedAR>("16:9");
  const [stageSize, setStageSize] = useState<{ w: number; h: number }>(() => stageSizeFromAllowedAR("16:9"));

  // ✅ 预览缩放（只影响显示，不影响导出/AI）— 默认 30%
  const [previewScale, setPreviewScale] = useState(0.3);

  // ✅ 用户上传背景（保留 1 张）
  const [userBgDataUrl, setUserBgDataUrl] = useState<string | null>(null);
  // ✅ AI BG from BG Studio (persisted)
  const [aiBgDataUrl, setAiBgDataUrl] = useState<string | null>(null);

  const bgOptions: BgOption[] = useMemo(() => {
    const userOpt: BgOption[] = userBgDataUrl
      ? [{ id: "user", name: "你上传的背景", src: userBgDataUrl, isUser: true }]
      : [];
    const aiOpt: BgOption[] = aiBgDataUrl ? [{ id: "ai", name: "AI 生成背景", src: aiBgDataUrl }] : [];
    return [...aiOpt, ...userOpt, ...presetBgOptions];
  }, [presetBgOptions, userBgDataUrl, aiBgDataUrl]);

  const [bgSrc, setBgSrc] = useState<string>(() => presetBgOptions[0].src);
  const bgImg = useHtmlImage(bgSrc);

  // ====================== Person 1 ======================
  const [storedPersonDataUrl, setStoredPersonDataUrl] = useState<string | null>(null);
  const [personImg, setPersonImg] = useState<HTMLImageElement | null>(null);
  const [subjectChoice, setSubjectChoice] = useState<"uploaded" | "none">("none");

  const [originalFile, setOriginalFile] = useState<File | null>(null);
  const [isCutting, setIsCutting] = useState(false);
  const [cutoutDataUrl, setCutoutDataUrl] = useState<string | null>(null);

  const [person, setPerson] = useState({ x: 260, y: 220, scale: 0.7, rotation: 0 });
  const [personRect, setPersonRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);

  const [grade, setGrade] = useState({ gain: 1.0, gamma: 1.0, exposure: 0.0, temp: 0.0, tint: 0.0 });
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

  // Reference（dropdown + 保留 1 张）
  const [storedReferenceDataUrl, setStoredReferenceDataUrl] = useState<string | null>(null);
  const [referenceChoice, setReferenceChoice] = useState<"uploaded" | "none">("none");
  const activeReferenceDataUrl = referenceChoice === "uploaded" ? storedReferenceDataUrl : null;

  // ✅ AI Comp
  const [combinePrompt, setCombinePrompt] = useState<string>(
    "Integrate the subject naturally into the scene. If there's a reference, use reference for clothing, accessories."
  );
  const [isCombining, setIsCombining] = useState(false);
  const [aiOutputDataUrl, setAiOutputDataUrl] = useState<string | null>(null);

  // Konva refs
  const stageRef = useRef<any>(null);

  const personNodeRef = useRef<any>(null);
  const outerShadowRef = useRef<any>(null);
  const innerShadowRef = useRef<any>(null);

  const trRef = useRef<any>(null);

  function updatePersonRect() {
    const node = personNodeRef.current;
    if (!node) return;
    const rect = node.getClientRect({ skipTransform: false });
    setPersonRect({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  }

  // 初次加载：恢复上一次人物1
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

  // 初次加载：恢复上一次上传背景/Reference/AI 输出 + stageAR
  useEffect(() => {
    const savedAR = localStorage.getItem("lastStageAR") as AllowedAR | null;
    if (savedAR && (ALLOWED_ASPECTS as readonly string[]).includes(savedAR)) {
      setStageAR(savedAR);
      setStageSize(stageSizeFromAllowedAR(savedAR));
    }

    const savedAiBg = localStorage.getItem("lastAIBgDataUrl") || null;
    if (savedAiBg) {
      setAiBgDataUrl(savedAiBg);
      setBgSrc(savedAiBg);
    }

    // ✅ Restore uploaded BG independently (even if AI BG exists)
    (async () => {
      try {
        const where = localStorage.getItem("lastBgWhere");
        if (where === "idb") {
          const blob = await idbGet<Blob>("lastBgBlob");
          if (blob) {
            const dataUrl = await blobToDataUrl2(blob);
            setUserBgDataUrl(dataUrl);
            return;
          }
        }
        const savedBg = localStorage.getItem("lastBgDataUrl");
        if (savedBg) setUserBgDataUrl(savedBg);
      } catch {
        const savedBg = localStorage.getItem("lastBgDataUrl");
        if (savedBg) setUserBgDataUrl(savedBg);
      }
    })();

    // If there is no AI BG selected, prefer uploaded BG as current bgSrc
    (async () => {
      if (savedAiBg) return;
      try {
        const where = localStorage.getItem("lastBgWhere");
        if (where === "idb") {
          const blob = await idbGet<Blob>("lastBgBlob");
          if (blob) {
            const dataUrl = await blobToDataUrl2(blob);
            setBgSrc(dataUrl);
            return;
          }
        }
        const savedBg = localStorage.getItem("lastBgDataUrl");
        if (savedBg) setBgSrc(savedBg);
      } catch {
        const savedBg = localStorage.getItem("lastBgDataUrl");
        if (savedBg) setBgSrc(savedBg);
      }
    })();
const savedRef = localStorage.getItem("lastReferenceDataUrl");
    if (savedRef) {
      setStoredReferenceDataUrl(savedRef);
      setReferenceChoice("uploaded");
    }

    (async () => {
      try {
        const where = localStorage.getItem("lastAIOutputWhere");
        if (where === "idb") {
          const blob = await idbGet<Blob>("lastAIOutputBlob");
          if (blob) {
            const dataUrl = await blobToDataUrl2(blob);
            setAiOutputDataUrl(dataUrl);
            return;
          }
        }
        const savedAI = localStorage.getItem("lastAIOutputDataUrl");
        if (savedAI) setAiOutputDataUrl(savedAI);
      } catch {
        const savedAI = localStorage.getItem("lastAIOutputDataUrl");
        if (savedAI) setAiOutputDataUrl(savedAI);
      }
    })();
  }, []);

  // ✅ 当 bgImg 加载时：自动选择“最接近的 Gemini 支持比例”，锁定 stageAR/stageSize，并写入 localStorage
  useEffect(() => {
    if (!bgImg) return;
    const w = bgImg.naturalWidth || bgImg.width;
    const h = bgImg.naturalHeight || bgImg.height;
    if (!w || !h) return;

    const ar = pickClosestAspectRatio(w, h);
    setStageAR((prev) => (prev === ar ? prev : ar));
    setStageSize(stageSizeFromAllowedAR(ar));

    try {
      localStorage.setItem("lastStageAR", ar);
    } catch {
      // ignore
    }
  }, [bgImg]);

  // 初次加载：恢复上次调色/阴影参数（人物1）
  useEffect(() => {
    const g = localStorage.getItem("lastGrade");
    const s = localStorage.getItem("lastShadow");
    if (g) setGrade((p) => ({ ...p, ...JSON.parse(g) }));
    if (s) setShadow((p) => ({ ...p, ...JSON.parse(s) }));
  }, []);

  // 保存调色/阴影参数（人物1）
  useEffect(() => {
    localStorage.setItem("lastGrade", JSON.stringify(grade));
  }, [grade]);
  useEffect(() => {
    localStorage.setItem("lastShadow", JSON.stringify(shadow));
  }, [shadow]);

  useEffect(() => {
    if (!trRef.current) return;
    const node = personNodeRef.current;
    if (!node) return;

    trRef.current.nodes([node]);
    trRef.current.getLayer()?.batchDraw();

    setTimeout(() => {
      updatePersonRect();
    }, 0);
  }, [personImg]);

  // dropdown：切换人物1显示
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

  // 阴影绘制参数（人物1）
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

  // Blur cache（人物1）
  useEffect(() => {
    if (!shadowDraw) return;
    outerShadowRef.current?.cache();
    innerShadowRef.current?.cache();
    stageRef.current?.getStage?.()?.batchDraw?.();
  }, [shadowDraw]);

  /** ✅ 上传人物1：最长边 ≤ 2048 */
  async function onSelectPersonFile(file: File) {
    const resized = await resizeImageFile(file, 2048, 0.9);
    setOriginalFile(resized);

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

  /**
   * ✅ 上传背景：压到 ≤4MP（像素总量），同时保存为 JPG q=0.90
   * - 仍然保持：AR=Gemini允许列表 + cover 居中裁切
   */
  async function onSelectBgFile(file: File) {
    const size = await loadImageSizeFromFile(file);
    const ar = pickClosestAspectRatio(size.w, size.h);
    const targetStage = stageSizeFromAllowedAR(ar);

    // ✅ 4MP 上限（像素总量）
    const MAX_PIXELS = 4_000_000;
    const currentPixels = size.w * size.h;

    // 默认：不放大
    let maxLongSide = Math.max(size.w, size.h);
    if (currentPixels > MAX_PIXELS) {
      const scale = Math.sqrt(MAX_PIXELS / currentPixels);
      maxLongSide = Math.max(1, Math.floor(Math.max(size.w, size.h) * scale));
    }

    // 强制保存为 JPG（其余一律 JPG）
    const resized = await fileToFileMaxSide(file, maxLongSide, "jpeg", 0.9, "bg_upload");
    const dataUrl = await blobToDataURL(resized);

    setStageAR(ar);
    setStageSize(targetStage);
    try {
      localStorage.setItem("lastStageAR", ar);
    } catch {}

    setUserBgDataUrl(dataUrl);
    await persistUploadedBg(dataUrl);
    setBgSrc(dataUrl);
  }

  /** ✅ 上传 reference：按 1080p 保存（显示更清晰），发送前仍会压到 ≤512 */
  async function onSelectReferenceFile(file: File) {
    const resized = await resizeImageFile(file, 1080, 0.9);
    const dataUrl = await blobToDataURL(resized);
    setStoredReferenceDataUrl(dataUrl);
    safeSetLocalStorageDataUrl("lastReferenceDataUrl", dataUrl);
  }

  /** ✅ 抠图人物1 */
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

      const resp = await fetch("/api/remove-bg", { method: "POST", body: fd });
      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(txt);
      }

      const blob = await resp.blob(); // PNG
      const url = URL.createObjectURL(blob);

      const img = new window.Image();
      img.onload = () => setPersonImg(img);
      img.src = url;

      try {
        const dataUrl = await blobToDataURL(blob);
        setCutoutDataUrl(dataUrl);
        safeSetLocalStorageDataUrl("lastCutPngDataUrl", dataUrl);

        setStoredPersonDataUrl(dataUrl);
        safeSetLocalStorageDataUrl("lastPersonDataUrl", dataUrl);

        const img2 = new window.Image();
        img2.onload = () => setPersonImg(img2);
        img2.src = dataUrl;
      } catch {}

      await refresh();
    } catch (err) {
      console.error(err);
      alert("抠图失败：请看 F12 → Network → /api/remove-bg 的状态码/返回内容");
    } finally {
      setIsCutting(false);
    }
  }

  /** ✅ 对人物1应用 filters（调色） */
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

  /** ✅ 导出（不含 reference 面板）— JPG q=0.90 */
  function exportStageDataUrl(pixelRatio: number) {
    const stage = stageRef.current;
    if (!stage) return null;

    const tr = trRef.current;
    const prevNodes = tr?.nodes?.() ?? [];

    tr?.nodes([]);
    stage.batchDraw();

    const uri = stage.toDataURL({
      pixelRatio,
      mimeType: "image/jpeg",
      quality: 1,
    });

    tr?.nodes(prevNodes);
    stage.batchDraw();

    return uri as string;
  }

  /** ✅ 导出（不含 reference 面板）— 4MP master（与 Canvas 一致） */
  function exportCustomerDataUrl() {
    return exportStageDataUrl(1);
  }

  /**
   * ✅ 导出给 Nano Banana 的输入图（Image 1）
   * - Quick（nano）和 Pro 一致
   */
function exportAiStageDataUrl(modelType: "nano" | "pro") {
  return exportStageDataUrl(1); // nano / pro 都发 4MP master
}


  async function downloadCutout() {
    if (cutoutDataUrl) {
      downloadDataUrl(cutoutDataUrl, "cutout_person1.png");
      return;
    }
    alert("请先点一次“抠图”生成透明 PNG");
  }

  function downloadCustomer() {
    const uri = exportCustomerDataUrl();
    if (!uri) return;
    downloadDataUrl(uri, "customer_output.jpg");
  }

  /** ✅ AI Comp：reference 可选 */
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
      const stageDataUrl = exportAiStageDataUrl(modelType);
      if (!stageDataUrl) throw new Error("Failed to export stage image");

      const sceneBlob = await (await fetch(stageDataUrl)).blob();

      const fd = new FormData();
      fd.append("image", sceneBlob, "scene.jpg"); // ✅ 一律 JPG

      if (activeReferenceDataUrl) {
        const refBlob = await dataUrlToRefJpegBlob(activeReferenceDataUrl, 0.85);
        fd.append("refImage", refBlob, "reference.jpg");
      }

      const safetySuffix =
        modelType === "pro"
          ? "\n\nSafety constraints:\nThis is a wholesome, family-friendly image. No nudity, no sexual content, no fetish content, and no suggestive focus. Keep attire appropriate and non-revealing."
          : "";

      const faceStrictSuffix = `
### MANDATORY: 
- THE PERSON'S FACE FROM IMAGE 1 IS SACROSANCT. 
- KEEP THE EYES, NOSE, MOUTH, AND IDENTITY 100% IDENTICAL TO IMAGE 1. 
- DO NOT APPLY ANY FEATURES FROM IMAGE 2 TO THE PERSON'S FACE.
`.trim();

      const finalPrompt = `${DEFAULT_SYSTEM_PROMPT}

${faceStrictSuffix}
${safetySuffix}

User request:
${combinePrompt}`;

      fd.append("prompt", finalPrompt);
      fd.append("modelType", modelType);

      // ✅ 关键：Gemini aspect_ratio 必须与 canvas 完全一致（且合法）
      fd.append("aspectRatio", stageAR);

      // 语义保持：后端若用这个字段也能对齐（Quick=≤1MP，Pro=≤4MP）
      fd.append("imageSize", "SAFE_4MP");

      const resp = await fetch("/api/nanobanana/advanced-combine", {
        method: "POST",
        body: fd,
      });

      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        const safety = parseGeminiSafetyBlock(txt);
        if (safety.isSafetyBlock) {
          alert(
            `Pro Generation was blocked by the model safety filter (${safety.modelUsed || "Gemini"}).\n\n` +
              `How to fix:\n` +
              `1) Try a more neutral prompt (e.g. “family-friendly vacation photo, keep everything modest, no nudity”).\n` +
              `2) Avoid revealing outfits / swimsuit-heavy scenes (Pro is stricter).\n` +
              `3) If needed, remove the reference image and test again.\n\n` +
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

      await refresh();

      // 保存 AI 输出：小图 localStorage；大图 IndexedDB
      try {
        if (outDataUrl.length < 1_500_000) {
          safeSetLocalStorageDataUrl("lastAIOutputDataUrl", outDataUrl);
          localStorage.setItem("lastAIOutputWhere", "ls");
          await idbDel("lastAIOutputBlob");
        } else {
          const blob = await dataUrlToBlob(outDataUrl);
          await idbSet("lastAIOutputBlob", blob);
          localStorage.setItem("lastAIOutputWhere", "idb");
          localStorage.removeItem("lastAIOutputDataUrl");
        }
      } catch {}
    } catch (e: any) {
      console.error(e);
      const msg = typeof e?.message === "string" && e.message.trim() ? e.message : "AI Comp 失败：请看 Console / Network";
      alert(msg);
    } finally {
      setIsCombining(false);
    }
  }

  function downloadAI() {
    if (!aiOutputDataUrl) return;
    const ext = dataUrlExt(aiOutputDataUrl);
    downloadDataUrl(aiOutputDataUrl, `ai_output.${ext}`);
  }

  // 背景 crop（cover）
  const bgCrop = useMemo(() => {
    if (!bgImg) return null;
    const w = bgImg.naturalWidth || bgImg.width;
    const h = bgImg.naturalHeight || bgImg.height;
    if (!w || !h) return null;
    return computeCoverCrop(w, h, stageSize.w, stageSize.h);
  }, [bgImg, stageSize.w, stageSize.h]);

  // ✅ 预览尺寸（用于“固定预览框 + 居中”）
  const scaledStage = useMemo(() => {
    const w = Math.round(stageSize.w * previewScale);
    const h = Math.round(stageSize.h * previewScale);
    return { w, h };
  }, [stageSize.w, stageSize.h, previewScale]);

  // ✅ 预览框固定高度：不随缩放撑大（你想要的效果）
  const PREVIEW_BOX_H = 520;

  return (
    <div className="space-y-6">
      <div className="rounded-3xl border bg-white p-6 shadow-sm">
        <AppHeader title="合成 Honolulu 照片" />
<p className="mt-2 text-sm text-neutral-600">
          ✅ Canvas / Regular Comp / Nano Banana Image 1 完全一致（无留白：背景自动居中裁切）。
          <br />
          ✅ 画布尺寸采用「安全版表」：控制在 ≤4MP（吃满 Pro 档但不超 4MP）。
          <br />
          ✅ Gemini aspect_ratio 与画布严格一致（允许列表：{ALLOWED_ASPECTS.join(", ")}）。
          <br />
          ✅ 导出/发送：除抠图 PNG 外，其余一律 JPG（Quality 100）。
        </p>

        <div className="mt-4 flex flex-col gap-4 lg:flex-row">
          {/* 左侧控制面板 */}
          <div className="space-y-4 lg:w-[360px] lg:shrink-0">
            {/* ✅ Basic Comp：背景 + Regular comp + 人物1 合并 */}
            <details open className="rounded-2xl border p-4">
              <summary className="cursor-pointer select-none text-sm font-semibold">Basic Comp</summary>

              {/* 背景 */}
              <details open className="mt-3 rounded-2xl border p-4">
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
                      上传背景会自动压到 ≤4MP，并保存 1 张（刷新后还在）。比例会匹配 Gemini 允许列表，背景无留白铺满（居中裁切）。

                    <div className="mt-3 rounded-2xl border p-3">
                      <div className="text-sm font-medium">AI 背景</div>
                      <div className="mt-1 text-xs text-neutral-500">在独立页面里生成背景，生成后会自动带回本页并保存。</div>
                      <Link
                        href="/bg"
                        className="mt-2 block w-full rounded-xl bg-neutral-900 px-4 py-2 text-center text-sm text-white hover:opacity-90"
                      >
                        Go to AI BG Studio
                      </Link>
                    </div>
                    </div>

                    <div className="mt-2 text-xs text-neutral-600">
                      当前画布：<span className="font-medium">{stageSize.w}×{stageSize.h}</span>（{mpText(stageSize.w, stageSize.h)}） · Gemini
                      aspect_ratio：<span className="font-medium"> {stageAR}</span>
                    </div>
                  </div>
                </div>
              </details>

              {/* 人物1 */}
              <div className="mt-4">
                <SubjectSection
                  title="人物 1"
                  subjectChoice={subjectChoice}
                  storedPersonDataUrl={storedPersonDataUrl}
                  isCutting={isCutting}
                  tokenCostCutout={TOKEN_COSTS.CUTOUT}
                  hasTokens={hasTokens}
                  canCutout={!!originalFile && !isCutting}
                  cutoutDataUrl={cutoutDataUrl}
                  shadow={shadow}
                  setShadow={setShadow}
                  grade={grade}
                  setGrade={setGrade}
                  onChangeChoice={(v) => {
                    setSubjectChoice(v);
                    if (v === "none") setPersonImg(null);
                  }}
                  onSelectFile={onSelectPersonFile}
                  onCutout={doRemoveBg}
                  onDownloadCutout={downloadCutout}
                />
              </div>

              {/* Regular Comp download */}
              <div className="mt-4 rounded-2xl border p-4">
                <div className="text-sm font-medium">输出（手动合成）</div>
                <div className="mt-1 text-xs text-neutral-500">导出当前画布合成图（JPG q=1）</div>
                <button
                  onClick={downloadCustomer}
                  className="mt-3 w-full rounded-xl border px-4 py-2.5 text-sm hover:bg-neutral-50"
                >
                  Regular Comp - download
                </button>
              </div>
            </details>

            {/* AI Comp */}
            <details open className="rounded-2xl border bg-white p-4">
              <summary className="cursor-pointer select-none text-sm font-medium">AI Comp</summary>

              <div className="mt-2 text-base font-semibold text-neutral-900">AI Comp 不需要抠图也可以用！</div>
              <div className="mt-1 text-xs text-neutral-600">Cutout（抠图）是可选项：直接用原图也能跑 AI Comp。</div>

              <div className="mt-3 space-y-3">
                <div className="text-xs text-neutral-600">(Integrate char into the scene)</div>

                <div className="text-xs text-neutral-500">
                  reference 是可选的：没有 reference 也可以运行 AI Comp；如果上传了 reference，则会参考 clothing/object/pose。
                  <div className="mt-2 text-red-600">
                    Quick Generation（{TOKEN_COSTS.QUICK} Token） uses Nano Banana.
                    <br />
                    Pro Generation（{TOKEN_COSTS.PRO} Tokens） uses Nano Banana Pro.
                    <br />
                    Pro costs more and is slower however with better result.
                  </div>
                </div>

                {/* ✅ reference 预览块 */}
                {activeReferenceDataUrl && (
                  <div className="mt-3 rounded-2xl border-4 border-black bg-white p-4 overflow-hidden">
                    <div className="text-center text-sm font-semibold">Selected for Clothing Reference</div>

                    <div className="mt-3 h-[360px] rounded-xl border bg-neutral-50 p-3 flex flex-col items-center justify-center overflow-hidden">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={activeReferenceDataUrl}
                        alt="reference"
                        className="max-h-[300px] max-w-[220px] w-auto rounded-lg object-contain"
                      />
                    </div>

                    <button
                      onClick={() => setReferenceChoice("none")}
                      className="mt-3 w-full rounded-xl border px-4 py-2 text-sm hover:bg-neutral-50"
                      disabled={isCombining}
                    >
                      Remove reference
                    </button>
                  </div>
                )}

                <div className="text-sm font-medium">Prompt</div>
                <textarea
                  value={combinePrompt}
                  onChange={(e) => setCombinePrompt(e.target.value)}
                  rows={5}
                  className="w-full resize-none rounded-xl border px-3 py-2 text-sm"
                />

                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-sm font-medium">Reference</div>
                    <select
                      className="flex-1 rounded-xl border px-3 py-2 text-sm"
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

                  <button
                    onClick={() => runAdvancedCombine("nano")}
                    className="w-full rounded-xl bg-neutral-900 px-4 py-2 text-sm text-white hover:opacity-90 disabled:opacity-40"
                    disabled={isCombining || !hasTokens(TOKEN_COSTS.QUICK)}
                    title={!hasTokens(TOKEN_COSTS.QUICK) ? `Not enough tokens (requires ${TOKEN_COSTS.QUICK})` : ""}
                  >
                    {isCombining ? "AI 合成中..." : `Quick Generation · ${TOKEN_COSTS.QUICK} Token`}
                  </button>

                  <button
                    onClick={() => runAdvancedCombine("pro")}
                    className="w-full rounded-xl border px-4 py-2 text-sm hover:bg-neutral-50 disabled:opacity-40"
                    disabled={isCombining || !hasTokens(TOKEN_COSTS.PRO)}
                    title={!hasTokens(TOKEN_COSTS.PRO) ? `Not enough tokens (requires ${TOKEN_COSTS.PRO})` : ""}
                  >
                    {isCombining ? "AI 合成中..." : `Pro Generation · ${TOKEN_COSTS.PRO} Tokens`}
                  </button>

                  <div className="pt-1 text-xs text-neutral-600">
                    发送给 Gemini：aspect_ratio=<span className="font-medium">{stageAR}</span>（与画布严格一致） · Canvas=
                    <span className="font-medium">
                      {" "}
                      {stageSize.w}×{stageSize.h}
                    </span>{" "}
                    ({mpText(stageSize.w, stageSize.h)})
                  </div>
                </div>
              </div>
            </details>
          </div>

          {/* 右侧：画布 + AI输出 */}
          <div className="flex-1 space-y-4">
            <div className="flex gap-4 items-end">
              <div className="flex-1 min-w-0">
                {/* 预览缩放 */}
                <div className="mb-2 flex items-center gap-3 text-xs text-neutral-600">
                  <span className="shrink-0">预览缩放</span>
                  <input
                    type="range"
                    min={0.1}
                    max={1}
                    step={0.05}
                    value={previewScale}
                    onChange={(e) => setPreviewScale(Number(e.target.value))}
                    className="w-full"
                  />
                  <span className="shrink-0">{Math.round(previewScale * 100)}%</span>
                  <span className="ml-2 shrink-0 text-neutral-400">（默认 30%）</span>
                </div>

                {/* ✅ 预览容器：固定高度，不会被缩放撑大；内容居中 */}
                <div
                  className="rounded-2xl border bg-neutral-100 overflow-hidden flex items-center justify-center"
                  style={{ height: PREVIEW_BOX_H }}
                >
                  <div style={{ width: scaledStage.w, height: scaledStage.h }}>
                    <div
                      style={{
                        transform: `scale(${previewScale})`,
                        transformOrigin: "top left",
                        width: stageSize.w,
                        height: stageSize.h,
                      }}
                    >
                      <Stage width={stageSize.w} height={stageSize.h} ref={stageRef}>
                        <Layer>
                          {bgImg && bgCrop && (
                            <KonvaImage
                              image={bgImg}
                              x={0}
                              y={0}
                              width={stageSize.w}
                              height={stageSize.h}
                              listening={false}
                              cropX={bgCrop.cropX}
                              cropY={bgCrop.cropY}
                              cropWidth={bgCrop.cropWidth}
                              cropHeight={bgCrop.cropHeight}
                            />
                          )}

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
                              onClick={() => {
                                trRef.current?.nodes([personNodeRef.current]);
                              }}
                              onTap={() => {
                                trRef.current?.nodes([personNodeRef.current]);
                              }}
                            />
                          )}

                          {personImg && (
                            <Transformer
                              ref={trRef}
                              rotateEnabled
                              enabledAnchors={["top-left", "top-right", "bottom-left", "bottom-right"]}
                              boundBoxFunc={(oldBox, newBox) => {
                                if (newBox.width < 30 || newBox.height < 30) return oldBox;
                                return newBox;
                              }}
                            />
                          )}
                        </Layer>
                      </Stage>
                    </div>
                  </div>
                </div>

                <div className="mt-2 text-xs text-neutral-500">
                  说明：这里只是“显示缩放”，导出 / AI 输入仍然是 {stageSize.w}×{stageSize.h}（{mpText(stageSize.w, stageSize.h)}）。
                </div>
              </div>
            </div>

            {/* AI 输出 */}
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
                  <img src={aiOutputDataUrl} alt="ai output" className="h-[520px] w-full object-contain" />
                ) : (
                  <div className="flex h-[520px] items-center justify-center text-sm text-neutral-500">
                    还没有 AI 输出（左侧运行 AI Comp；reference 可选）
                  </div>
                )}
              </div>

              {aiOutputDataUrl && (
                <button
                  className="mt-3 w-full rounded-xl border px-3 py-2 text-sm hover:bg-neutral-50"
                  onClick={() => {
                    setAiOutputDataUrl(null);
                    localStorage.removeItem("lastAIOutputDataUrl");
                    localStorage.removeItem("lastAIOutputWhere");
                    (async () => {
                      try {
                        await idbDel("lastAIOutputBlob");
                      } catch {}
                    })();
                  }}
                >
                  清空 AI 输出
                </button>
              )}
            </details>
          </div>
        </div>
      </div>

      <div className="rounded-3xl border bg-white p-6 shadow-sm">
        <h3 className="font-semibold">说明</h3>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-neutral-700">
          <li>没有 reference：你只需要下载“Regular Comp”。</li>
          <li>
            有 reference：AI Comp 会分开发送：Image 1=画布导出（无留白、比例=Gemini、尺寸=安全版表），Image 2=Reference（≤512）。
          </li>
          <li>AI Comp 输出会单独显示在右侧大块区域，并可单独下载。</li>
        </ul>
      </div>
    </div>
  );
}