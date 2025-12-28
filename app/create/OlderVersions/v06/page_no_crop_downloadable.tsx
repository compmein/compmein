"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Konva from "konva";
import {
  Stage,
  Layer,
  Image as KonvaImage,
  Transformer,
  Ellipse,
} from "react-konva";

const SYSTEM_COMBINE_PROMPT = `
The primary subject is the subject already placed in the scene.
Do NOT replace, redesign, or reimagine the subject.

The input image may contain only a partial view of the subject.
If parts of the subject are missing, extend the subject naturally and conservatively.

Preserve the subject’s identity, form, scale, and overall appearance.
Do not change the subject into a different character or species.

When extending missing parts:
- Use anatomically and structurally plausible proportions for the subject.
- Follow the subject’s visible form, posture, and species characteristics.
- Keep appearance consistent with the visible part.
- If details are unknown, use neutral and realistic continuation.

Match lighting direction, exposure, white balance, and contrast to the background.
Create realistic contact with the ground or environment (contact shadow or contact area).
Fix cutout artifacts (no halos, no outlines).

If a reference panel is visible:
Use it only as guidance for clothing, accessories, objects, or pose.
Ignore reference identity and character design.
Do not include the reference panel or any UI elements in the final image.

Photorealistic result where applicable.
`.trim();

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

// 前端缩小上传图片（按长边压缩到 1080p）
async function resizeImageFile(
  file: File,
  maxLongSide = 1080,
  quality = 0.9
): Promise<File> {
  if (!/image\/(jpeg|png|webp)/.test(file.type)) return file;

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

  const outType =
    file.type === "image/png"
      ? "image/png"
      : file.type === "image/webp"
        ? "image/webp"
        : "image/jpeg";

  const blob: Blob = await new Promise((resolve) => {
    canvas.toBlob(
      (b) => resolve(b as Blob),
      outType,
      outType === "image/jpeg" ? quality : undefined
    );
  });

  URL.revokeObjectURL(objectUrl);

  const newName =
    file.name.replace(/\.\w+$/, "") +
    (outType === "image/png" ? ".png" : outType === "image/webp" ? ".webp" : ".jpg");

  return new File([blob], newName, { type: outType });
}

// contain fit
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

  // 背景（含“保留 1 张客户上传背景”）
  const [bgSrc, setBgSrc] = useState(bgOptions[0].src);
  const [customBgDataUrl, setCustomBgDataUrl] = useState<string | null>(null);

  useEffect(() => {
    const lastBg = localStorage.getItem("lastCustomBgDataUrl");
    if (lastBg) setCustomBgDataUrl(lastBg);
  }, []);

  useEffect(() => {
    if (customBgDataUrl) localStorage.setItem("lastCustomBgDataUrl", customBgDataUrl);
  }, [customBgDataUrl]);

  const effectiveBgSrc = customBgDataUrl ?? bgSrc;

  const bgImg = useHtmlImage(effectiveBgSrc);
  const bgDraw = bgImg ? fitImage(bgImg, STAGE_W, STAGE_H) : null;

  // 人物（抠图后图）
  const [personImg, setPersonImg] = useState<HTMLImageElement | null>(null);
  const [isCutting, setIsCutting] = useState(false);

  // reference（可选，保留 1 张）
  const [referenceDataUrl, setReferenceDataUrl] = useState<string | null>(null);
  useEffect(() => {
    const lastRef = localStorage.getItem("lastReferenceDataUrl");
    if (lastRef) setReferenceDataUrl(lastRef);
  }, []);
  useEffect(() => {
    if (referenceDataUrl) localStorage.setItem("lastReferenceDataUrl", referenceDataUrl);
  }, [referenceDataUrl]);

  // Advanced Combine prompt（用户可编辑部分）
  const [combinePrompt, setCombinePrompt] = useState<string>(
    "Integrate the subject naturally into the background."
  );
  const [isCombining, setIsCombining] = useState(false);
  const [aiOutputDataUrl, setAiOutputDataUrl] = useState<string | null>(null);

  useEffect(() => {
    const lastAI = localStorage.getItem("lastAIOutputDataUrl");
    if (lastAI) setAiOutputDataUrl(lastAI);
  }, []);
  useEffect(() => {
    if (aiOutputDataUrl) localStorage.setItem("lastAIOutputDataUrl", aiOutputDataUrl);
  }, [aiOutputDataUrl]);

  const stageRef = useRef<any>(null);
  const personNodeRef = useRef<any>(null);
  const trRef = useRef<any>(null);

  const outerShadowRef = useRef<any>(null);
  const innerShadowRef = useRef<any>(null);

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
    if (!trRef.current || !personNodeRef.current) return;
    trRef.current.nodes([personNodeRef.current]);
    trRef.current.getLayer()?.batchDraw();
    setTimeout(() => updatePersonRect(), 0);
  }, [personImg]);

  // 阴影（双层+可调）
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

  useEffect(() => {
    if (!shadowDraw) return;
    outerShadowRef.current?.cache();
    innerShadowRef.current?.cache();
    stageRef.current?.getStage?.()?.batchDraw?.();
  }, [shadowDraw]);

  async function onUploadPerson(file: File) {
    setIsCutting(true);
    try {
      const fd = new FormData();
      const resized = await resizeImageFile(file, 1080, 0.9);
      fd.append("image", resized);

      const resp = await fetch("/api/remove-bg", { method: "POST", body: fd });

      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(txt);
      }

      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);

      const image = new window.Image();
      image.onload = () => setPersonImg(image);
      image.src = url;
    } catch (err) {
      console.error(err);
      alert("抠图失败：请看 F12 → Network → /api/remove-bg 的状态码/返回内容");
    } finally {
      setIsCutting(false);
    }
  }

  async function onUploadCustomBg(file: File) {
    try {
      const resized = await resizeImageFile(file, 1080, 0.9);
      const dataUrl = await fileToDataUrl(resized);
      setCustomBgDataUrl(dataUrl);
    } catch (e) {
      console.error(e);
      alert("背景上传失败");
    }
  }

  async function onUploadReference(file: File) {
    try {
      const resized = await resizeImageFile(file, 1080, 0.9);
      const dataUrl = await fileToDataUrl(resized);
      setReferenceDataUrl(dataUrl);
    } catch (e) {
      console.error(e);
      alert("reference 上传失败");
    }
  }

  function downloadRegularCombine() {
    const uri = stageRef.current?.toDataURL({ pixelRatio: 2 });
    if (!uri) return;
    const a = document.createElement("a");
    a.download = "regular_combine.png";
    a.href = uri;
    a.click();
  }

  function downloadAI() {
    if (!aiOutputDataUrl) return;
    const a = document.createElement("a");
    a.download = "advanced_combine.png";
    a.href = aiOutputDataUrl;
    a.click();
  }

  async function runAdvancedCombine(modelType: "nano" | "pro") {
    if (!stageRef.current) return;
    setIsCombining(true);
    try {
      const stageDataUrl = stageRef.current.toDataURL({ pixelRatio: 2 });
      const imgBlob = await (await fetch(stageDataUrl)).blob();

      const fd = new FormData();
      fd.append("image", imgBlob, "scene.png");

      const finalPrompt = `${SYSTEM_COMBINE_PROMPT}\n\n${combinePrompt}`;
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
        throw new Error(txt || `HTTP ${resp.status}`);
      }

      const json = await resp.json();
      const mime = json.mimeType || "image/png";
      const dataUrl = `data:${mime};base64,${json.imageBase64}`;
      setAiOutputDataUrl(dataUrl);
    } catch (e: any) {
      console.error(e);
      alert(`Advanced Combine 失败：${String(e?.message ?? e)}`);
    } finally {
      setIsCombining(false);
    }
  }

  return (
    <div className="space-y-6 p-6">
      <div className="rounded-3xl border bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold">合成照片</h2>
        <p className="mt-2 text-sm text-neutral-600">
          上传人物 JPG/PNG（不需要透明），可拖拽、缩放、旋转，再下载。
        </p>

        <div className="mt-4 grid gap-4 md:grid-cols-3">
          {/* 左侧控制 */}
          <div className="space-y-3">
            <div className="text-sm font-medium">选择背景（内置）</div>
            <select
              className="w-full rounded-xl border px-3 py-2 text-sm"
              value={bgSrc}
              onChange={(e) => {
                setCustomBgDataUrl(null);
                setBgSrc(e.target.value);
              }}
            >
              {bgOptions.map((b) => (
                <option key={b.id} value={b.src}>
                  {b.name}
                </option>
              ))}
            </select>

            <div className="mt-2 text-sm font-medium">上传背景（客户）</div>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onUploadCustomBg(f);
              }}
              className="w-full text-sm"
            />
            {customBgDataUrl && (
              <button
                className="w-full rounded-xl border px-3 py-2 text-sm hover:bg-neutral-50"
                onClick={() => setCustomBgDataUrl(null)}
              >
                清除客户背景
              </button>
            )}

            <div className="mt-3 text-sm font-medium">上传人物（自动抠图）</div>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={isCutting}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                await onUploadPerson(f);
              }}
              className="w-full text-sm"
            />

            <button
              onClick={downloadRegularCombine}
              className="mt-2 w-full rounded-xl bg-neutral-900 px-4 py-2.5 text-sm text-white hover:opacity-90 disabled:opacity-40"
              disabled={!bgImg || isCutting}
            >
              {isCutting ? "正在抠图..." : "Regular Combine（下载 PNG）"}
            </button>

            {/* 阴影控制 */}
            <div className="mt-4 rounded-2xl border p-4">
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

              <div className="mt-3 space-y-3">
                <Slider
                  label="左右移动"
                  value={shadow.xOffset}
                  min={-80}
                  max={80}
                  step={1}
                  disabled={!shadow.enabled}
                  onChange={(v) => setShadow((s) => ({ ...s, xOffset: v }))}
                />
                <SliderFloat
                  label="透明度"
                  value={shadow.opacity}
                  min={0}
                  max={0.6}
                  step={0.01}
                  disabled={!shadow.enabled}
                  onChange={(v) => setShadow((s) => ({ ...s, opacity: v }))}
                />
                <Slider
                  label="模糊（外层）"
                  value={shadow.blur}
                  min={0}
                  max={80}
                  step={1}
                  disabled={!shadow.enabled}
                  onChange={(v) => setShadow((s) => ({ ...s, blur: v }))}
                />
                <SliderFloat
                  label="宽度（越大越窄）"
                  value={shadow.widthFactor}
                  min={0.8}
                  max={3.5}
                  step={0.1}
                  disabled={!shadow.enabled}
                  onChange={(v) => setShadow((s) => ({ ...s, widthFactor: v }))}
                />
                <Slider
                  label="高度"
                  value={shadow.height}
                  min={6}
                  max={60}
                  step={1}
                  disabled={!shadow.enabled}
                  onChange={(v) => setShadow((s) => ({ ...s, height: v }))}
                />
                <Slider
                  label="上下位置"
                  value={shadow.yOffset}
                  min={-20}
                  max={80}
                  step={1}
                  disabled={!shadow.enabled}
                  onChange={(v) => setShadow((s) => ({ ...s, yOffset: v }))}
                />
                <SliderFloat
                  label="压扁（Y）"
                  value={shadow.squashY}
                  min={0.3}
                  max={1.3}
                  step={0.01}
                  disabled={!shadow.enabled}
                  onChange={(v) => setShadow((s) => ({ ...s, squashY: v }))}
                />
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

                  {/* 阴影 */}
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
                            scale: Math.max(0.1, Math.min(3, scaleX)),
                          }));
                          updatePersonRect();
                        }}
                        onClick={() => trRef.current?.nodes([personNodeRef.current])}
                        onTap={() => trRef.current?.nodes([personNodeRef.current])}
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
                          if (newBox.width < 30 || newBox.height < 30) return oldBox;
                          return newBox;
                        }}
                      />
                    </>
                  )}
                </Layer>
              </Stage>
            </div>

            {/* Advanced Combine */}
            <div className="mt-4 rounded-3xl border bg-white p-6 shadow-sm">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-base font-semibold">Advanced Combine</div>
                  <div className="text-sm text-neutral-600">
                    Nano（便宜）/ Pro（更强更贵）— reference 可选
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => runAdvancedCombine("nano")}
                    className="rounded-xl border px-4 py-2 text-sm hover:bg-neutral-50 disabled:opacity-40"
                    disabled={isCombining}
                  >
                    {isCombining ? "处理中..." : "Nano"}
                  </button>
                  <button
                    onClick={() => runAdvancedCombine("pro")}
                    className="rounded-xl bg-neutral-900 px-4 py-2 text-sm text-white hover:opacity-90 disabled:opacity-40"
                    disabled={isCombining}
                  >
                    {isCombining ? "处理中..." : "Pro"}
                  </button>
                </div>
              </div>

              <div className="mt-4">
                <div className="text-sm font-medium">Prompt（用户可编辑部分）</div>
                <textarea
                  value={combinePrompt}
                  onChange={(e) => setCombinePrompt(e.target.value)}
                  rows={3}
                  className="mt-2 w-full rounded-xl border p-3 text-sm"
                />
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div className="rounded-2xl border p-4">
                  <div className="text-sm font-medium">Reference（可选）</div>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) onUploadReference(f);
                    }}
                    className="mt-3 w-full text-sm"
                  />
                  {referenceDataUrl && (
                    <div className="mt-3">
                      <img
                        src={referenceDataUrl}
                        alt="reference"
                        className="max-h-[260px] max-w-[200px] w-auto rounded-lg object-contain"
                      />
                      <button
                        className="mt-3 w-full rounded-xl border px-3 py-2 text-sm hover:bg-neutral-50"
                        onClick={() => {
                          setReferenceDataUrl(null);
                          localStorage.removeItem("lastReferenceDataUrl");
                        }}
                      >
                        清除 Reference
                      </button>
                    </div>
                  )}
                </div>

                <div className="rounded-2xl border p-4">
                  <div className="text-sm font-medium">AI Output</div>
                  <div className="mt-2 overflow-hidden rounded-xl border bg-neutral-50">
                    {aiOutputDataUrl ? (
                      <img
                        src={aiOutputDataUrl}
                        alt="ai output"
                        className="h-[360px] w-full object-contain"
                      />
                    ) : (
                      <div className="flex h-[360px] items-center justify-center text-sm text-neutral-500">
                        还没有 AI 输出（直接运行 Nano 或 Pro）
                      </div>
                    )}
                  </div>

                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={downloadAI}
                      className="w-full rounded-xl bg-neutral-900 px-4 py-2 text-sm text-white hover:opacity-90 disabled:opacity-40"
                      disabled={!aiOutputDataUrl}
                    >
                      下载 Advanced Combine
                    </button>
                    {aiOutputDataUrl && (
                      <button
                        className="w-full rounded-xl border px-3 py-2 text-sm hover:bg-neutral-50"
                        onClick={() => {
                          setAiOutputDataUrl(null);
                          localStorage.removeItem("lastAIOutputDataUrl");
                        }}
                      >
                        清空
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-4 rounded-3xl border bg-white p-6 shadow-sm">
              <h3 className="font-semibold">说明</h3>
              <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-neutral-700">
                <li>Regular Combine：下载你在画布里摆好的版本。</li>
                <li>Advanced Combine：把左侧画布发送给 Nano/Pro，参考图可选。</li>
                <li>背景 / reference / AI 输出都会保留最近 1 张。</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- helpers ---------- */
async function fileToDataUrl(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return `data:${file.type};base64,${btoa(binary)}`;
}

function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs text-neutral-600">
        <span>{props.label}</span>
        <span>{props.value}</span>
      </div>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(parseInt(e.target.value, 10))}
        className="w-full"
        disabled={props.disabled}
      />
    </div>
  );
}

function SliderFloat(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs text-neutral-600">
        <span>{props.label}</span>
        <span>{props.value.toFixed(2)}</span>
      </div>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(parseFloat(e.target.value))}
        className="w-full"
        disabled={props.disabled}
      />
    </div>
  );
}
