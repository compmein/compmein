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

/** 背景图等比缩放+居中 */
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

/** 将 File 转为 DataURL */
function blobToDataURL(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = () => res(reader.result as string);
    reader.onerror = rej;
    reader.readAsDataURL(file);
  });
}

/** 拼接画布截图与 Reference 图 */
async function buildNanobananaInput({
  stageDataUrl,
  stageW,
  stageH,
  referenceDataUrl,
}: {
  stageDataUrl: string;
  stageW: number;
  stageH: number;
  referenceDataUrl: string;
}) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return stageDataUrl;

  const REF_W = 400; 
  canvas.width = stageW + REF_W;
  canvas.height = stageH;

  const [imgStage, imgRef] = await Promise.all([
    new Promise<HTMLImageElement>((res) => {
      const i = new window.Image();
      i.onload = () => res(i);
      i.src = stageDataUrl;
    }),
    new Promise<HTMLImageElement>((res) => {
      const i = new window.Image();
      i.crossOrigin = "anonymous";
      i.onload = () => res(i);
      i.src = referenceDataUrl;
    }),
  ]);

  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(imgStage, 0, 0, stageW, stageH);

  const fit = fitImage(imgRef, REF_W, stageH);
  ctx.drawImage(imgRef, stageW + fit.x, fit.y, fit.width, fit.height);

  return canvas.toDataURL("image/png");
}

const STAGE_W = 800;
const STAGE_H = 600;

export default function CreatePage() {
  const stageRef = useRef<Konva.Stage>(null);
  const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);
  const [referenceDataUrl, setReferenceDataUrl] = useState<string | null>(null);
  const [combinePrompt, setCombinePrompt] = useState("A realistic photo of this product in this setting.");
  const [isCombining, setIsCombining] = useState(false);
  const [aiOutputDataUrl, setAiOutputDataUrl] = useState<string | null>(null);

  const hasReference = !!referenceDataUrl;

  useEffect(() => {
    const lastRef = localStorage.getItem("lastReferenceDataUrl");
    if (lastRef) setReferenceDataUrl(lastRef);
    const lastAi = localStorage.getItem("lastAIOutputDataUrl");
    if (lastAi) setAiOutputDataUrl(lastAi);
  }, []);

  const onSelectReferenceFile = async (file: File) => {
    try {
      const durl = await blobToDataURL(file);
      setReferenceDataUrl(durl);
      localStorage.setItem("lastReferenceDataUrl", durl);
    } catch (e) {
      console.error(e);
    }
  };

  const exportCustomerDataUrl = () => {
    const stage = stageRef.current;
    if (!stage) return null;
    return stage.toDataURL({ pixelRatio: 2 });
  };

  /** ✅ 核心逻辑：支持选择 nano 或 pro 的合成函数 */
  async function runAdvancedCombine(mode: "nano" | "pro") {
    const stage = stageRef.current;
    if (!stage) return;

    setIsCombining(true);
    try {
      const stageDataUrl = exportCustomerDataUrl();
      if (!stageDataUrl) throw new Error("导出画布失败");

      const inputDataUrl = referenceDataUrl
        ? await buildNanobananaInput({
            stageDataUrl,
            stageW: STAGE_W,
            stageH: STAGE_H,
            referenceDataUrl,
          })
        : stageDataUrl;

      const inputBlob = await (await fetch(inputDataUrl)).blob();

      const fd = new FormData();
      fd.append("image", inputBlob, "nanobanana_input.png");
      fd.append("prompt", combinePrompt);
      fd.append("aspectRatio", "16:9");
      
      // 传递模型类型给后端
      fd.append("modelType", mode);
      // 统一使用 1K，确保速度快且满足你的需求
      fd.append("imageSize", "1K");

      const resp = await fetch("/api/nanobanana/advanced-combine", {
        method: "POST",
        body: fd,
      });

      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(txt || `HTTP ${resp.status}`);
      }

      const json = await resp.json();
      const base64 = json?.imageBase64;
      const mimeType = json?.mimeType || "image/png";
      if (!base64) throw new Error("API 未返回图像。");

      const outDataUrl = `data:${mimeType};base64,${base64}`;
      setAiOutputDataUrl(outDataUrl);

      if (outDataUrl.length < 4_000_000) {
        localStorage.setItem("lastAIOutputDataUrl", outDataUrl);
      }
    } catch (e: any) {
      console.error(e);
      alert(`${mode === 'pro' ? 'Ultra' : 'Nano'} 合成失败，请检查配置。`);
    } finally {
      setIsCombining(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Nano Banana Studio</h1>
        <p className="text-neutral-500 text-sm">选择模型并运行 AI 高级合成</p>
      </div>

      <div className="grid gap-8 lg:grid-cols-2">
        {/* 左侧：画布区域 */}
        <div className="space-y-4">
          <div className="overflow-hidden rounded-3xl border bg-neutral-100 shadow-inner">
            <Stage width={STAGE_W} height={STAGE_H} ref={stageRef} scaleX={0.6} scaleY={0.6}>
              <Layer>
                {/* 你的画布图层逻辑... */}
              </Layer>
            </Stage>
          </div>
        </div>

        {/* 右侧：控制与输出区域 */}
        <div className="space-y-6">
          <div className="rounded-3xl border bg-white p-6 shadow-sm">
            <h3 className="font-semibold mb-4">AI 高级合成控制台</h3>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">提示词 (Prompt)</label>
                <textarea
                  value={combinePrompt}
                  onChange={(e) => setCombinePrompt(e.target.value)}
                  className="w-full rounded-2xl border p-3 text-sm"
                  rows={3}
                  placeholder="描述你想要生成的画面..."
                />
              </div>

              <div className="space-y-3">
                <label className="block text-sm font-medium">参考图 (Reference)</label>
                <div className="flex items-center gap-3">
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) onSelectReferenceFile(f);
                    }}
                    className="text-xs"
                  />
                  {hasReference && (
                    <button
                      onClick={() => {
                        setReferenceDataUrl(null);
                        localStorage.removeItem("lastReferenceDataUrl");
                      }}
                      className="text-xs text-red-500 underline"
                    >
                      删除参考图
                    </button>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap gap-3 pt-2">
                {/* Nano 按钮 */}
                <button
                  onClick={() => runAdvancedCombine("nano")}
                  className="flex-1 rounded-xl bg-neutral-900 px-4 py-3 text-sm text-white hover:opacity-90 disabled:opacity-40 transition"
                  disabled={isCombining}
                >
                  {isCombining ? "处理中..." : "Run Nano Combine"}
                </button>

                {/* Pro 按钮 */}
                <button
                  onClick={() => runAdvancedCombine("pro")}
                  className="flex-1 rounded-xl bg-indigo-600 px-4 py-3 text-sm text-white hover:bg-indigo-700 shadow-md disabled:opacity-40 transition"
                  disabled={isCombining}
                >
                  {isCombining ? "处理中..." : "🚀 Run Ultra Pro"}
                </button>
              </div>
            </div>
          </div>

          {/* AI 输出展示 */}
          <div className="rounded-3xl border bg-neutral-50 p-4">
            <div className="mb-2 text-sm font-medium text-neutral-500">AI 输出预览 (1K)</div>
            <div className="aspect-video w-full overflow-hidden rounded-2xl border bg-white flex items-center justify-center">
              {aiOutputDataUrl ? (
                <img src={aiOutputDataUrl} alt="AI Output" className="h-full w-full object-contain" />
              ) : (
                <span className="text-xs text-neutral-400">运行合成后在此显示结果</span>
              )}
            </div>
            {aiOutputDataUrl && (
              <button
                onClick={() => {
                  setAiOutputDataUrl(null);
                  localStorage.removeItem("lastAIOutputDataUrl");
                }}
                className="mt-3 w-full text-xs text-neutral-400 hover:text-red-500"
              >
                清空输出
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
