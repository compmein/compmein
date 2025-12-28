"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Konva from "konva";
import {
  Stage,
  Layer,
  Image as KonvaImage,
  Transformer,
  Ellipse,
} from "react-konva";

type BgOption = { id: string; name: string; src: string };

function useHtmlImage(src?: string) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    if (!src) return;

    const image = new window.Image();
    image.crossOrigin = "anonymous";
    image.onload = () => setImg(image);
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

/** 上传图太大时：前端缩到长边 <= maxLongSide，避免抠图 API 因文件过大失败 */
async function resizeImageFile(
  file: File,
  maxLongSide = 1600,
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

/** Blob -> DataURL（用于 localStorage 保存上一次抠图） */
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

/** 用 ColorMatrix 做“gain/色偏/明暗/冷暖”这类线性变换 */
function buildColorMatrix(opts: {
  gain: number; // 0.5~2
  gamma: number; // 0.5~2 (gamma 用自定义 filter，矩阵这里只放 gain)
  exposure: number; // -1~1 (线性亮度偏移)
  temp: number; // -1~1 (蓝<->黄)
  tint: number; // -1~1 (绿<->洋红)
}) {
  const { gain, exposure, temp, tint } = opts;

  // 基础：RGB gain (乘法)
  // temp：+R -B；tint：+G - (R+B)/2（非常简化，但手感像“绿/洋红”）
  const t = temp * 0.15;
  const ti = tint * 0.15;

  const rGain = gain * (1 + t - ti * 0.5);
  const gGain = gain * (1 + ti);
  const bGain = gain * (1 - t - ti * 0.5);

  // exposure：加法偏移（-1~1 映射到 -35~35）
  const add = exposure * 35;

  // Konva ColorMatrix: 4x5（20个数）
  // [ r1 g1 b1 a1 o1,
  //   r2 g2 b2 a2 o2,
  //   r3 g3 b3 a3 o3,
  //   r4 g4 b4 a4 o4 ]
  return [
    rGain, 0, 0, 0, add,
    0, gGain, 0, 0, add,
    0, 0, bGain, 0, add,
    0, 0, 0, 1, 0,
  ];
}

/** ✅ 自定义 Gamma Filter（非线性，ColorMatrix 做不了） */
function applyGammaFilter(node: Konva.Node, gamma: number) {
  // 只给 Konva.Image 用
  // @ts-ignore
  Konva.Filters ??= {};
  // @ts-ignore
  if (!Konva.Filters.__gamma) {
    // @ts-ignore
    Konva.Filters.__gamma = function (imageData: ImageData) {
      // @ts-ignore
      const g = this.__gammaValue ?? 1;
      const inv = 1 / clamp(g, 0.1, 10);

      const d = imageData.data;
      for (let i = 0; i < d.length; i += 4) {
        d[i] = 255 * Math.pow(d[i] / 255, inv);     // R
        d[i + 1] = 255 * Math.pow(d[i + 1] / 255, inv); // G
        d[i + 2] = 255 * Math.pow(d[i + 2] / 255, inv); // B
      }
    };
  }

  // @ts-ignore
  node.__gammaValue = gamma;
}

export default function CreatePage() {
  const bgOptions: BgOption[] = useMemo(
    () => [
      { id: "waikiki", name: "Waikiki Beach", src: "/bg/waikiki.jpg" },
      { id: "diamond", name: "Diamond Head", src: "/bg/diamondhead.jpg" },
      { id: "night", name: "Honolulu Night", src: "/bg/night.jpg" },
    ],
    []
  );

  const STAGE_W = 900;
  const STAGE_H = 520;

  const [bgSrc, setBgSrc] = useState(bgOptions[0].src);
  const bgImg = useHtmlImage(bgSrc);

  // 人物图片（用于画到Konva）
  const [personImg, setPersonImg] = useState<HTMLImageElement | null>(null);

  // 保存原始上传文件（用于用户点“抠图”按钮时再请求 API）
  const [originalFile, setOriginalFile] = useState<File | null>(null);

  const [isCutting, setIsCutting] = useState(false);

  // 人物变换
  const [person, setPerson] = useState({
    x: 260,
    y: 180,
    scale: 0.75,
    rotation: 0,
  });

  // ✅ 后期调色：像 Nuke 的 gain / gamma + 冷暖 / 绿洋红 + 曝光
  const [grade, setGrade] = useState({
    gain: 1.0,       // 0.5~2
    gamma: 1.0,      // 0.5~2
    exposure: 0.0,   // -1~1
    temp: 0.0,       // -1~1
    tint: 0.0,       // -1~1
  });

  // ✅ 阴影：双层 + 太阳方向(左右)
  const [shadow, setShadow] = useState({
    enabled: true,
    sunX: 0,        // -120~120：太阳方向（左右）
    contactOpacity: 0.28,
    contactBlur: 18,
    contactW: 1.2,
    contactH: 0.35,

    castOpacity: 0.18,
    castBlur: 38,
    castW: 1.9,
    castH: 0.45,

    yOffset: 0,     // 阴影上下微调
  });

  const stageRef = useRef<any>(null);
  const personNodeRef = useRef<any>(null);
  const trRef = useRef<any>(null);

  // 背景绘制参数
  const bgDraw = bgImg ? fitImage(bgImg, STAGE_W, STAGE_H) : null;

  // 初次加载：尝试恢复上一次抠图结果
  useEffect(() => {
    const saved = localStorage.getItem("lastCutPngDataUrl");
    if (!saved) return;

    const img = new window.Image();
    img.onload = () => setPersonImg(img);
    img.src = saved;
  }, []);

  // 初次加载：恢复上次调色/阴影参数（可选）
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
  }, [personImg]);

  /** ✅ 上传：先显示原图（不自动抠图），并记录 originalFile */
  async function onSelectFile(file: File) {
    setOriginalFile(file);

    // 直接把原图显示出来（可能带背景；用户可先看看是否需要抠图）
    const url = URL.createObjectURL(file);
    const img = new window.Image();
    img.onload = () => setPersonImg(img);
    img.src = url;
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

      // ✅ 先缩小，避免 API 因文件太大失败
      const resized = await resizeImageFile(originalFile, 1600, 0.9);
      fd.append("image", resized);

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

      // ✅ 保存“上一次抠图”（localStorage 有大小限制，太大就不存）
      try {
        const dataUrl = await blobToDataURL(blob);
        if (dataUrl.length < 4_000_000) {
          localStorage.setItem("lastCutPngDataUrl", dataUrl);
        } else {
          // 太大就不存，避免 localStorage 爆掉
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
    if (!node) return;

    // 缓存后 filter 才会生效
    node.cache({ pixelRatio: 2 });

    // 组合：ColorMatrix + 自定义 Gamma
    const cm = buildColorMatrix(grade);

    // @ts-ignore
    const gammaFilter = Konva.Filters.__gamma;

    node.filters([Konva.Filters.ColorMatrix, gammaFilter]);
    node.colorMatrix(cm);
    applyGammaFilter(node, grade.gamma);

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

  // ✅ 阴影参数：基于人物位置/缩放 + 太阳方向
  // 这里用“人物左上角 + 偏移”方式估算脚下位置（MVP）
  // 你后面想做更准：可以用 personNodeRef.current.getClientRect() 动态算“脚底”
  const baseFootX = person.x + 180 * person.scale;
  const baseFootY = person.y + 430 * person.scale + shadow.yOffset;

  const sunShift = shadow.sunX * person.scale; // 跟缩放一致的偏移

  // 双层阴影：接触阴影（小、黑、贴地） + 投影（大、淡、有方向）
  const contact = {
    x: baseFootX,
    y: baseFootY,
    radiusX: 95 * person.scale * shadow.contactW,
    radiusY: 26 * person.scale * shadow.contactH,
    opacity: shadow.contactOpacity,
    blur: shadow.contactBlur,
  };

  const cast = {
    x: baseFootX + sunShift,
    y: baseFootY + 6 * person.scale,
    radiusX: 120 * person.scale * shadow.castW,
    radiusY: 30 * person.scale * shadow.castH,
    opacity: shadow.castOpacity,
    blur: shadow.castBlur,
  };

  return (
    <div className="space-y-6">
      <div className="rounded-3xl border bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold">合成 Honolulu 照片</h2>
        <p className="mt-2 text-sm text-neutral-600">
          MVP：上传人物 JPG/PNG（不需要透明）。你可以先看原图，再点击 <strong>“抠图”</strong> 生成透明 PNG，
          然后拖拽/缩放/旋转，调阴影和调色，最后下载 PNG。
        </p>

        <div className="mt-4 grid gap-4 md:grid-cols-3">
          {/* 左侧控制面板 */}
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="text-sm font-medium">选择背景</div>
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
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium">上传人物</div>
              <input
                type="file"
                accept="image/png,image/jpeg"
                disabled={isCutting}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onSelectFile(f);
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
                小提示：点击人物后可用角点缩放/旋转；也可以直接拖动位置。
              </div>
            </div>

            {/* 阴影控制 */}
            <div className="rounded-2xl border p-4">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">阴影</div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={shadow.enabled}
                    onChange={(e) =>
                      setShadow((p) => ({ ...p, enabled: e.target.checked }))
                    }
                  />
                  开启
                </label>
              </div>

              <div className="mt-3 space-y-3 text-sm">
                <div>
                  <div className="flex justify-between text-xs text-neutral-600">
                    <span>太阳方向（左右）</span>
                    <span>{shadow.sunX}</span>
                  </div>
                  <input
                    type="range"
                    min={-120}
                    max={120}
                    value={shadow.sunX}
                    onChange={(e) =>
                      setShadow((p) => ({ ...p, sunX: Number(e.target.value) }))
                    }
                    className="w-full"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-xs text-neutral-600">
                    <span>接触阴影强度</span>
                    <span>{shadow.contactOpacity.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={0.6}
                    step={0.01}
                    value={shadow.contactOpacity}
                    onChange={(e) =>
                      setShadow((p) => ({
                        ...p,
                        contactOpacity: Number(e.target.value),
                      }))
                    }
                    className="w-full"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-xs text-neutral-600">
                    <span>接触阴影柔和（Blur）</span>
                    <span>{shadow.contactBlur}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={80}
                    value={shadow.contactBlur}
                    onChange={(e) =>
                      setShadow((p) => ({
                        ...p,
                        contactBlur: Number(e.target.value),
                      }))
                    }
                    className="w-full"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-xs text-neutral-600">
                    <span>投影强度</span>
                    <span>{shadow.castOpacity.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={0.5}
                    step={0.01}
                    value={shadow.castOpacity}
                    onChange={(e) =>
                      setShadow((p) => ({
                        ...p,
                        castOpacity: Number(e.target.value),
                      }))
                    }
                    className="w-full"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-xs text-neutral-600">
                    <span>投影柔和（Blur）</span>
                    <span>{shadow.castBlur}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={120}
                    value={shadow.castBlur}
                    onChange={(e) =>
                      setShadow((p) => ({ ...p, castBlur: Number(e.target.value) }))
                    }
                    className="w-full"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-xs text-neutral-600">
                    <span>阴影上下</span>
                    <span>{shadow.yOffset}</span>
                  </div>
                  <input
                    type="range"
                    min={-80}
                    max={80}
                    value={shadow.yOffset}
                    onChange={(e) =>
                      setShadow((p) => ({
                        ...p,
                        yOffset: Number(e.target.value),
                      }))
                    }
                    className="w-full"
                  />
                </div>

                <div className="text-xs text-neutral-500">
                  说明：你说 “blur 拉满还是 sharp”，主要是之前用错属性了（Ellipse 没有 blurRadius）。
                  这里改成 <strong>Blur Filter</strong> + 双层阴影，边会明显更柔。
                </div>
              </div>
            </div>

            {/* 调色控制 */}
            <div className="rounded-2xl border p-4">
              <div className="text-sm font-medium">调色（像 Nuke）</div>

              <div className="mt-3 space-y-3 text-sm">
                <div>
                  <div className="flex justify-between text-xs text-neutral-600">
                    <span>Gain（明暗/强度）</span>
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
                    <span>Gamma</span>
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
                    <span>偏色（Green ⇄ Magenta）</span>
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
                      {/* ✅ 双层阴影（先画阴影，再画人物） */}
                      {shadow.enabled && (
                        <>
                          {/* 投影（大、淡、有方向） */}
                          <Ellipse
                            x={cast.x}
                            y={cast.y}
                            radiusX={cast.radiusX}
                            radiusY={cast.radiusY}
                            fill="black"
                            opacity={cast.opacity}
                            listening={false}
                            // blur：必须 cache + Filters.Blur 才会非常柔
                            ref={(node) => {
                              if (!node) return;
                              node.cache();
                              node.filters([Konva.Filters.Blur]);
                              // @ts-ignore
                              node.blurRadius(cast.blur);
                            }}
                          />
                          {/* 接触阴影（小、黑、贴地） */}
                          <Ellipse
                            x={contact.x}
                            y={contact.y}
                            radiusX={contact.radiusX}
                            radiusY={contact.radiusY}
                            fill="black"
                            opacity={contact.opacity}
                            listening={false}
                            ref={(node) => {
                              if (!node) return;
                              node.cache();
                              node.filters([Konva.Filters.Blur]);
                              // @ts-ignore
                              node.blurRadius(contact.blur);
                            }}
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
                        rotation={person.rotation}
                        scaleX={person.scale}
                        scaleY={person.scale}
                        onDragEnd={(e) =>
                          setPerson((p) => ({
                            ...p,
                            x: e.target.x(),
                            y: e.target.y(),
                          }))
                        }
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
                        }}
                        onClick={() =>
                          trRef.current?.nodes([personNodeRef.current])
                        }
                        onTap={() =>
                          trRef.current?.nodes([personNodeRef.current])
                        }
                      />

                      <Transformer
                        ref={trRef}
                        rotateEnabled
                        enabledAnchors={[
                          "top-left",
                          "top-right",
                          "bottom-left",
                          "bottom-right",
                        ]}
                        boundBoxFunc={(oldBox, newBox) => {
                          if (newBox.width < 30 || newBox.height < 30)
                            return oldBox;
                          return newBox;
                        }}
                      />
                    </>
                  )}
                </Layer>
              </Stage>
            </div>

            <div className="mt-2 text-xs text-neutral-500">
              说明：背景等比缩放不拉伸；人物调色只作用于人物层。下载会自动去掉蓝色框。
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-3xl border bg-white p-6 shadow-sm">
        <h3 className="font-semibold">下一步（明天做）</h3>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-neutral-700">
          <li>更精准的“脚底”定位（用 getClientRect 算人物底边）</li>
          <li>接入 Nano Banana / Nano Banana Pro：生成场景、换衣服、补全阴影等</li>
        </ul>
      </div>
    </div>
  );
}
