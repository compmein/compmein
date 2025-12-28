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
async function resizeImageFile(
  file: File,
  maxLongSide = 1080,
  quality = 0.9
): Promise<File> {
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

/** Blob -> DataURL（用于 localStorage 保存上一次抠图 / 背景） */
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

        // linear-ish
        r = r * rGain + add;
        gg = gg * gGain + add;
        b = b * bGain + add;

        // clamp
        r = Math.max(0, Math.min(255, r));
        gg = Math.max(0, Math.min(255, gg));
        b = Math.max(0, Math.min(255, b));

        // gamma
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

  // 组合背景选项：预置 + 用户上传（如果存在）
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

  // 人物变换
  const [person, setPerson] = useState({
    x: 260,
    y: 180,
    scale: 0.75,
    rotation: 0,
  });


  // ✅ 昨天的阴影定位逻辑：用人物真实包围盒定位“脚底”
  const [personRect, setPersonRect] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);

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

  // ✅ 调色：明暗/伽马 + 冷暖 / 绿紫 + 曝光
  const [grade, setGrade] = useState({
    gain: 1.0, // 0.5~2
    gamma: 1.0, // 0.5~2
    exposure: 0.0, // -1~1
    temp: 0.0, // -1~1
    tint: 0.0, // -1~1
  });

  // ✅ 阴影（昨天那套）：双层 + “左右移动”
  const [shadow, setShadow] = useState({
    enabled: true,
    opacity: 0.23,
    blur: 28, // 外层模糊
    widthFactor: 1.8,
    height: 20,
    yOffset: 10,
    squashY: 0.75,

    // 左右移动（x 偏移）
    xOffset: 0, // -80 ~ 80
  });

  const stageRef = useRef<any>(null);
  const personNodeRef = useRef<any>(null);
  const trRef = useRef<any>(null);

  // ✅ 阴影 refs（昨天那套：双层椭圆）
  const outerShadowRef = useRef<any>(null);
  const innerShadowRef = useRef<any>(null);

  // 背景绘制参数
  const bgDraw = bgImg ? fitImage(bgImg, STAGE_W, STAGE_H) : null;

  // ✅ 初次加载：恢复上一次抠图结果（至少 1 张）
  useEffect(() => {
    const saved = localStorage.getItem("lastCutPngDataUrl");
    if (!saved) return;

    const img = new window.Image();
    img.onload = () => setPersonImg(img);
    img.src = saved;
  }, []);

  // ✅ 初次加载：恢复上一次上传背景（至少 1 张）
  useEffect(() => {
    const savedBg = localStorage.getItem("lastBgDataUrl");
    if (!savedBg) return;
    setUserBgDataUrl(savedBg);

    // 如果用户背景存在，默认让用户背景排在第一，但不强制切换
    // 你也可以把下面这行打开：让页面一进来就用上次背景
    // setBgSrc(savedBg);
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

    // ✅ 同步更新脚底定位
    setTimeout(() => updatePersonRect(), 0);
  }, [personImg]);

  /** ✅ 上传人物：只预览（不自动抠图），并按 1080p 压缩后保存 originalFile */
  async function onSelectPersonFile(file: File) {
    // 所有上传图统一压缩到 1080p 长边
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

    // 用 DataURL 保存“至少一张背景”
    const dataUrl = await blobToDataURL(resized);
    setUserBgDataUrl(dataUrl);
    localStorage.setItem("lastBgDataUrl", dataUrl);

    // 自动切换到用户背景
    setBgSrc(dataUrl);
  }

  /** ✅ 用户点“抠图”按钮才请求 API（避免每次上传都抠） */
  async function doRemoveBg() {
    if (!originalFile) {
      alert("请先上传一张人物 JPG/PNG，然后再点“抠图”");
      return;
    }

    setIsCutting(true);
    try {
      const fd = new FormData();
      fd.append("image", originalFile); // 已经按 1080p 压过

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

      // ✅ 保存“上一次抠图”（至少 1 张）
      try {
        const dataUrl = await blobToDataURL(blob);
        // localStorage 有大小限制，太大就不存
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

    // 缓存后 filter 才会生效
    node.cache({ pixelRatio: 2 });

    // @ts-ignore
    const gradeFilter = Konva.Filters.__grade;

    // @ts-ignore
    node.__gradeValue = grade;

    node.filters([gradeFilter]);

    node.getLayer()?.batchDraw();
  }, [grade, personImg]);

  /** ✅ 下载：临时隐藏 Transformer（不把蓝框导出） */
  function download() {
    const stage = stageRef.current;
    if (!stage) return;

    const tr = trRef.current;
    const prevNodes = tr?.nodes?.() ?? [];

    // 先取消选中（不画蓝框）
    tr?.nodes([]);
    tr?.getLayer()?.batchDraw();

    const uri = stage.toDataURL({ pixelRatio: 2 });

    // 恢复选中
    tr?.nodes(prevNodes);
    tr?.getLayer()?.batchDraw();

    const a = document.createElement("a");
    a.download = "honolulu.png";
    a.href = uri;
    a.click();
  }

  // ✅ 昨天的阴影：根据人物包围盒算“脚底”，生成双层椭圆参数
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
  }, [
    shadow.enabled,
    shadow.opacity,
    shadow.blur,
    shadow.widthFactor,
    shadow.height,
    shadow.yOffset,
    shadow.squashY,
    shadow.xOffset,
    personRect,
  ]);

  // ✅ Blur 生效关键：cache + filters
  useEffect(() => {
    if (!shadowDraw) return;
    outerShadowRef.current?.cache();
    innerShadowRef.current?.cache();
    stageRef.current?.getStage?.()?.batchDraw?.();
  }, [shadowDraw]);

  return (
    <div className="space-y-6">
      <div className="rounded-3xl border bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold">合成 Honolulu 照片</h2>
        <p className="mt-2 text-sm text-neutral-600">
          上传人物和背景会<strong>自动压缩到长边 1080p</strong>（更快、更稳定）。
          人物不会自动抠图，点 <strong>“抠图”</strong> 才会请求 API。系统会保留你上一次抠过的人物和上一次上传的背景（各 1 张）。
        </p>

        <div className="mt-4 grid gap-4 md:grid-cols-3">
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
                <div className="mt-1 text-xs text-neutral-500">
                  上传背景会自动保存 1 张（刷新后还在）。如果不满意预置背景，可直接上传自己的。
                </div>
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
                  disabled={!originalFile || isCutting}
                >
                  {isCutting ? "正在抠图..." : "抠图"}
                </button>

                <button
                  onClick={download}
                  className="w-1/2 rounded-xl border px-4 py-2.5 text-sm hover:bg-neutral-50 disabled:opacity-40"
                  disabled={!bgImg}
                >
                  下载 PNG
                </button>
              </div>

              <div className="text-xs text-neutral-500">
                提示：点击人物后可用角点缩放/旋转；也可以直接拖动位置。
              </div>
            </div>

            {/* 阴影控制（恢复到昨天那套：更容易看到，且一定在人物下面） */}
            <div className="rounded-2xl border p-4">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">阴影</div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={shadow.enabled}
                    onChange={(e) =>
                      setShadow((s) => ({ ...s, enabled: e.target.checked }))
                    }
                  />
                  开启
                </label>
              </div>

              <div className="mt-3 space-y-3 text-sm">
                <div>
                  <div className="flex justify-between text-xs text-neutral-600">
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
                  <div className="flex justify-between text-xs text-neutral-600">
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
                  <div className="flex justify-between text-xs text-neutral-600">
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
                  <div className="mt-1 text-[11px] text-neutral-500">
                    这是“真模糊”（filters+cache）。外层建议 25~60。
                  </div>
                </div>

                <div>
                  <div className="flex justify-between text-xs text-neutral-600">
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
                  <div className="flex justify-between text-xs text-neutral-600">
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
                  <div className="flex justify-between text-xs text-neutral-600">
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
                  <div className="flex justify-between text-xs text-neutral-600">
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

                <div className="text-[11px] text-neutral-500">
                  半身照没脚时：优先调 <b>上下位置</b> + <b>透明度</b> + <b>模糊</b>。
                </div>
              </div>
            </div>

            {/* 调色控制 */}
            <div className="rounded-2xl border p-4">
              <div className="text-sm font-medium">调色（明暗 / 冷暖 / 绿紫）</div>

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
                    onChange={(e) =>
                      setGrade((p) => ({ ...p, gain: Number(e.target.value) }))
                    }
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
                    onChange={(e) =>
                      setGrade((p) => ({ ...p, gamma: Number(e.target.value) }))
                    }
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
                    onChange={(e) =>
                      setGrade((p) => ({
                        ...p,
                        exposure: Number(e.target.value),
                      }))
                    }
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
                    onChange={(e) =>
                      setGrade((p) => ({ ...p, temp: Number(e.target.value) }))
                    }
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
                    onChange={(e) =>
                      setGrade((p) => ({ ...p, tint: Number(e.target.value) }))
                    }
                    className="w-full"
                  />
                </div>

                <button
                  className="w-full rounded-xl border px-3 py-2 text-sm hover:bg-neutral-50"
                  onClick={() =>
                    setGrade({ gain: 1, gamma: 1, exposure: 0, temp: 0, tint: 0 })
                  }
                >
                  重置调色
                </button>
              </div>
            </div>
          </div>

          {/* 右侧画布 */}
          <div className="md:col-span-2">
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

                  {personImg && (
                    <>
                      {/* ✅ 双层阴影（昨天那套：一定在人物下面） */}
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

                      {/* ✅ 人物 */}
                      <KonvaImage
                        ref={personNodeRef}
                        image={personImg}
                        x={person.x}
                        y={person.y}
                        draggable
                        onDragMove={() => updatePersonRect()}
                        rotation={person.rotation}
                        scaleX={person.scale}
                        scaleY={person.scale}
                        onDragEnd={(e) => {
                          setPerson((p) => ({
                            ...p,
                            x: e.target.x(),
                            y: e.target.y(),
                          }));
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

            <div className="mt-2 text-xs text-neutral-500">
              说明：背景等比缩放不拉伸；调色只作用于人物层；下载会自动去掉蓝色框。
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-3xl border bg-white p-6 shadow-sm">
        <h3 className="font-semibold">已实现（按你刚才列的功能）</h3>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-neutral-700">
          <li>人物调色：明暗（Gain/Exposure/Gamma）、冷暖、绿紫</li>
          <li>抠图改为“按键触发”，不再一上传就抠</li>
          <li>保留上一次抠图人物（至少 1 张，刷新后可直接继续用）</li>
          <li>支持用户上传背景，并保留上一次上传背景（至少 1 张）</li>
          <li>所有上传图片自动压缩：长边 1080p（upscale 后续可接 API）</li>
        </ul>
      </div>
    </div>
  );
}
