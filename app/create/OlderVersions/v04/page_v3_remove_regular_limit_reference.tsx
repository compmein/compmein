"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Konva from "konva";
import { Stage, Layer, Image as KonvaImage, Transformer, Ellipse } from "react-konva";

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

/** Blob -> DataURL（用于 localStorage 保存） */
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

/**
 * ✅ 生成 NanoBanana 输入图（只发“一张图”）
 * 左侧：Konva stage 导出
 * 右侧：reference 面板（可选）
 */
async function buildNanobananaInput(opts: {
  stageDataUrl: string;
  stageW: number;
  stageH: number;
  referenceDataUrl: string;
}) {
  const PADDING = 18;
  const PANEL_W = 280;
  const PANEL_H = opts.stageH;
  const OUT_W = opts.stageW + PADDING + PANEL_W;
  const OUT_H = opts.stageH;

  const canvas = document.createElement("canvas");
  canvas.width = OUT_W;
  canvas.height = OUT_H;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No 2D context");

  // background white
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, OUT_W, OUT_H);

  // left: stage
  const stageImg = await loadImageFromDataUrl(opts.stageDataUrl);
  ctx.drawImage(stageImg, 0, 0, opts.stageW, opts.stageH);

  // right panel bg
  const panelX = opts.stageW + PADDING;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(panelX, 0, PANEL_W, PANEL_H);

  // panel border
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = 6;
  ctx.strokeRect(panelX + 3, 3, PANEL_W - 6, PANEL_H - 6);

  // title
  ctx.fillStyle = "#000000";
  ctx.font = "20px Arial";
  ctx.textAlign = "center";
  ctx.fillText("Reference Clothing/Object/Pose", panelX + PANEL_W / 2, 44);

  // inner frame
  const innerPad = 26;
  const frameX = panelX + innerPad;
  const frameY = 70;
  const frameW = PANEL_W - innerPad * 2;
  const frameH = PANEL_H - 100;

  ctx.lineWidth = 5;
  ctx.strokeRect(frameX, frameY, frameW, frameH);

  // label
  ctx.font = "22px Arial";
  ctx.fillText("Uploaded pic", panelX + PANEL_W / 2, frameY + 50);

  // place reference image (contain)
  const refImg = await loadImageFromDataUrl(opts.referenceDataUrl);
  const maxW = frameW - 24;
  const maxH = frameH - 110;
  const rx = frameX + 12;
  const ry = frameY + 78;

  const rRatio = refImg.width / refImg.height;
  const boxRatio = maxW / maxH;
  let dw = maxW,
    dh = maxH;
  if (rRatio > boxRatio) {
    dw = maxW;
    dh = maxW / rRatio;
  } else {
    dh = maxH;
    dw = maxH * rRatio;
  }
  const dx = rx + (maxW - dw) / 2;
  const dy = ry + (maxH - dh) / 2;
  ctx.drawImage(refImg, dx, dy, dw, dh);

  return canvas.toDataURL("image/png");
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

  // 人物图片（用于画到Konva）
  const [personImg, setPersonImg] = useState<HTMLImageElement | null>(null);

  // ✅ 保存“压缩后的原始人物文件”（用于点“抠图”时请求 API）
  const [originalFile, setOriginalFile] = useState<File | null>(null);
  const [isCutting, setIsCutting] = useState(false);

  // ✅ reference（右侧面板）— 可选，保留 1 张
  const [referenceDataUrl, setReferenceDataUrl] = useState<string | null>(null);

  // ✅ Advanced Combine
  const [combinePrompt, setCombinePrompt] = useState<string>(
    "Integrate the character naturally into the scene. Match lighting, shadow contact, and style. If reference is provided, follow it for clothing/object/pose."
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

  // 初次加载：恢复上一次抠图人物（至少 1 张）
  useEffect(() => {
    const saved = localStorage.getItem("lastCutPngDataUrl");
    if (!saved) return;

    const img = new window.Image();
    img.onload = () => setPersonImg(img);
    img.src = saved;
  }, []);

  // 初次加载：恢复上一次上传背景（至少 1 张）
  useEffect(() => {
    const savedBg = localStorage.getItem("lastBgDataUrl");
    if (savedBg) setUserBgDataUrl(savedBg);

    const savedRef = localStorage.getItem("lastReferenceDataUrl");
    if (savedRef) setReferenceDataUrl(savedRef);

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
    localStorage.setItem("lastBgDataUrl", dataUrl);
    setBgSrc(dataUrl);
  }

  /** ✅ 上传 reference：按 1080p 压缩，并保留 1 张（localStorage） */
  async function onSelectReferenceFile(file: File) {
    const resized = await resizeImageFile(file, 1080, 0.9);
    const dataUrl = await blobToDataURL(resized);
    setReferenceDataUrl(dataUrl);
    localStorage.setItem("lastReferenceDataUrl", dataUrl);
  }

  /** ✅ 抠图按键触发 */
  async function doRemoveBg() {
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

      const blob = await resp.blob(); // 透明 PNG
      const url = URL.createObjectURL(blob);

      const img = new window.Image();
      img.onload = () => setPersonImg(img);
      img.src = url;

      // 保存“上一次抠图”
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

  /** ✅ 导出“客户手动合成图”（不带 reference 面板） */
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

  /** ✅ 下载客户手动合成图 */
  function downloadCustomer() {
    const uri = exportCustomerDataUrl();
    if (!uri) return;
    downloadDataUrl(uri, "customer_output.png");
  }

  /** ✅ Advanced Combine：只有在有 reference 时才可用（按你的规则） */
  async function runAdvancedCombine() {

    const stage = stageRef.current;
    if (!stage) return;

    setIsCombining(true);
    try {
      // 1) 导出“客户合成图”（左侧 stage）
      const stageDataUrl = exportCustomerDataUrl();
      if (!stageDataUrl) throw new Error("Failed to export stage image");

      // 2) 生成 NanoBanana 输入图（只发“一张图”）
      // - 没 reference：直接用左侧画布导出图
      // - 有 reference：把右侧 reference 面板拼进一张图
      const inputDataUrl = referenceDataUrl
        ? await buildNanobananaInput({
            stageDataUrl,
            stageW: STAGE_W,
            stageH: STAGE_H,
            referenceDataUrl,
          })
        : stageDataUrl;

      // 3) dataURL -> Blob
      const inputBlob = await (await fetch(inputDataUrl)).blob();
// 4) 调后端
      const fd = new FormData();
      fd.append("image", inputBlob, "nanobanana_input.png");
      fd.append("prompt", combinePrompt);
      fd.append("aspectRatio", "16:9");
      fd.append("imageSize", "2K");

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

      // 保存 AI 输出（至少 1 张）
      if (outDataUrl.length < 4_000_000) {
        localStorage.setItem("lastAIOutputDataUrl", outDataUrl);
      } else {
        localStorage.removeItem("lastAIOutputDataUrl");
      }
    } catch (e: any) {
      console.error(e);
      alert("Advanced Combine 失败：请看 Console / Network");
    } finally {
      setIsCombining(false);
    }
  }

  /** ✅ 下载 AI 输出 */
  function downloadAI() {
    if (!aiOutputDataUrl) return;
    downloadDataUrl(aiOutputDataUrl, "ai_output.png");
  }

  const hasReference = !!referenceDataUrl;

  return (
    <div className="space-y-6">
      <div className="rounded-3xl border bg-white p-6 shadow-sm">
        <h3 className="font-semibold">说明</h3>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-neutral-700">
          <li>Regular Combine：直接下载你在画布里摆好的版本（上方按钮）。</li>
          <li>Advance Combine：把“客户合成截图”发送给 Nano Banana Pro；如果上传了 reference，则会参考 clothing/object/pose。</li>
          <li>AI 输出会显示在下方，可单独下载与清空。</li>
        </ul>
      </div>
    </div>
  );
}
}
