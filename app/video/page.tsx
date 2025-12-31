"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import AppHeader from "../components/AppHeader";

type RunwayStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "UNKNOWN";

const RATIO_PRESETS = [
  { label: "Landscape (1280×720)", value: "1280:720" },
  { label: "Portrait (720×1280)", value: "720:1280" },
  { label: "Square (960×960)", value: "960:960" },
] as const;

const DURATION_PRESETS = [
  { label: "5s", value: 5 },
  { label: "10s", value: 10 },
] as const;

function safeNowId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function fileToDataUrl(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

// 仍然保留轻量压缩：减少上传时间、减少存储、提高成功率（但不再卡 5MB）
async function compressToJpeg(file: File, maxLongEdge = 2048, quality = 0.92): Promise<File> {
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
    const longEdge = Math.max(w0, h0);
    const scale = longEdge > maxLongEdge ? maxLongEdge / longEdge : 1;

    const w = Math.max(1, Math.round(w0 * scale));
    const h = Math.max(1, Math.round(h0 * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No canvas context");
    ctx.drawImage(img, 0, 0, w, h);

    const blob: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b as Blob), "image/jpeg", quality));
    return new File([blob], `runway_input_${safeNowId()}.jpg`, { type: "image/jpeg" });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function VideoPage() {
  const [uiMsg, setUiMsg] = useState<string>("");

  const [promptText, setPromptText] = useState<string>(
    "Subtle camera push-in, gentle motion, natural lighting, cinematic, stable details."
  );
  const [duration, setDuration] = useState<number>(5);
  const [ratio, setRatio] = useState<string>("1280:720");

  const [rawFile, setRawFile] = useState<File | null>(null);
  const [previewImageUrl, setPreviewImageUrl] = useState<string>("");

  const [isPreparing, setIsPreparing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [taskId, setTaskId] = useState<string>("");
  const [status, setStatus] = useState<RunwayStatus>("UNKNOWN");
  const [outputUrl, setOutputUrl] = useState<string>("");
  const [error, setError] = useState<string>("");

  const pollTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!uiMsg) return;
    const t = setTimeout(() => setUiMsg(""), 3200);
    return () => clearTimeout(t);
  }, [uiMsg]);

  useEffect(() => {
    return () => {
      if (pollTimer.current) window.clearInterval(pollTimer.current);
    };
  }, []);

  const canGenerate = useMemo(() => {
    return !!rawFile && !!promptText.trim() && !isPreparing && !isSubmitting;
  }, [rawFile, promptText, isPreparing, isSubmitting]);

  async function onPickFile(f: File) {
    setRawFile(f);
    setTaskId("");
    setStatus("UNKNOWN");
    setOutputUrl("");
    setError("");

    try {
      const d = await fileToDataUrl(f);
      setPreviewImageUrl(d);
    } catch {
      setPreviewImageUrl("");
    }
  }

  async function startPoll(id: string) {
    if (!id) return;
    if (pollTimer.current) window.clearInterval(pollTimer.current);

    pollTimer.current = window.setInterval(async () => {
      try {
        const r = await fetch(`/api/video/runway?taskId=${encodeURIComponent(id)}`, { method: "GET" });
        const j = await r.json().catch(() => ({}));

        if (!r.ok) {
          setStatus("FAILED");
          setError(j?.error || `Status check failed (HTTP ${r.status})`);
          if (pollTimer.current) window.clearInterval(pollTimer.current);
          return;
        }

        const st = (j?.status as RunwayStatus) || "UNKNOWN";
        setStatus(st);

        if (st === "SUCCEEDED") {
          const url = String(j?.outputUrl || "");
          if (url) setOutputUrl(url);
          if (pollTimer.current) window.clearInterval(pollTimer.current);
        } else if (st === "FAILED" || st === "CANCELLED") {
          setError(String(j?.error || "Task failed"));
          if (pollTimer.current) window.clearInterval(pollTimer.current);
        }
      } catch (e: any) {
        setStatus("FAILED");
        setError(e?.message || "Polling failed");
        if (pollTimer.current) window.clearInterval(pollTimer.current);
      }
    }, 2500);
  }

  async function generate() {
    setError("");
    setOutputUrl("");
    setStatus("UNKNOWN");
    setTaskId("");

    if (!rawFile) return setUiMsg("Please upload an image.");
    if (!promptText.trim()) return setUiMsg("Please enter a prompt.");

    setIsPreparing(true);
    let inputFile: File;
    try {
      inputFile = await compressToJpeg(rawFile, 2048, 0.92);
    } catch (e: any) {
      setIsPreparing(false);
      setError(e?.message || "Failed to prepare image");
      return;
    } finally {
      setIsPreparing(false);
    }

    setIsSubmitting(true);
    try {
      // 1) Upload to Supabase via our API (returns signedUrl)
      const fd = new FormData();
      fd.append("image", inputFile, inputFile.name);

      const up = await fetch("/api/video/runway/upload", { method: "POST", body: fd });
      const upj = await up.json().catch(() => ({}));

      if (!up.ok) {
        setError(upj?.error || `Upload failed (HTTP ${up.status})`);
        return;
      }

      const assetUrl = String(upj?.assetUrl || "");
      if (!assetUrl) {
        setError("Upload succeeded but got no assetUrl");
        return;
      }

      // 2) Create Runway task using imageUrl (assetUrl)
      const r = await fetch("/api/video/runway", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageUrl: assetUrl,
          promptText: promptText.trim(),
          duration,
          ratio,
        }),
      });

      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(j?.error || `Generate failed (HTTP ${r.status})`);
        return;
      }

      const id = String(j?.taskId || "");
      if (!id) {
        setError("No taskId returned from server");
        return;
      }

      setTaskId(id);
      setStatus("PENDING");
      setUiMsg("✅ Task submitted. Generating…");
      await startPoll(id);
    } catch (e: any) {
      setError(e?.message || "Generate failed");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function downloadVideo() {
    if (!outputUrl) return;
    try {
      const r = await fetch(outputUrl);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `video_${safeNowId()}.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setUiMsg("Download failed. You can open the URL and save from browser.");
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <AppHeader title="Video Studio" backHref="/" />

      {uiMsg ? <div className="mt-3 rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm">{uiMsg}</div> : null}
      {error ? <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div> : null}

      <div className="mt-4 rounded-2xl border p-4">
        <div className="text-sm font-medium">Upload Image</div>
        <div className="mt-1 text-xs text-neutral-500">We’ll animate this photo into a short video.</div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            type="file"
            accept="image/*"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onPickFile(f);
            }}
            className="text-sm"
          />
          {rawFile ? (
            <button
              className="rounded-xl border px-3 py-2 text-sm hover:bg-neutral-50"
              onClick={() => {
                setRawFile(null);
                setPreviewImageUrl("");
                setTaskId("");
                setStatus("UNKNOWN");
                setOutputUrl("");
                setError("");
              }}
            >
              Clear
            </button>
          ) : null}
        </div>

        {previewImageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={previewImageUrl} alt="input" className="mt-3 w-full rounded-xl border object-contain" />
        ) : (
          <div className="mt-3 rounded-xl border border-dashed p-6 text-center text-sm text-neutral-500">No image selected</div>
        )}
      </div>

      <div className="mt-4 rounded-2xl border p-4">
        <div className="text-sm font-medium">Prompt</div>
        <textarea
          value={promptText}
          onChange={(e) => setPromptText(e.target.value)}
          rows={4}
          className="mt-2 w-full resize-none rounded-xl border px-3 py-2 text-sm"
          placeholder="Describe the motion/camera/style…"
        />

        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div>
            <div className="text-xs font-medium text-neutral-700">Duration</div>
            <select className="mt-1 w-full rounded-xl border px-3 py-2 text-sm" value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
              {DURATION_PRESETS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>

            <div className="mt-3 text-xs font-medium text-neutral-700">Output Ratio</div>
            <select className="mt-1 w-full rounded-xl border px-3 py-2 text-sm" value={ratio} onChange={(e) => setRatio(e.target.value)}>
              {RATIO_PRESETS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>

            <div className="mt-2 text-xs text-neutral-500">
              Tip: subtle motion tends to look best (camera push-in, gentle wind, waves, etc).
            </div>
          </div>

          <div className="flex flex-col justify-end gap-2">
            <button
              onClick={generate}
              disabled={!canGenerate}
              className="w-full rounded-xl bg-neutral-900 px-4 py-2.5 text-sm text-white hover:opacity-90 disabled:opacity-40"
            >
              {isPreparing ? "Preparing image..." : isSubmitting ? "Submitting..." : "Generate Video"}
            </button>

            <div className="rounded-xl border bg-neutral-50 px-3 py-2 text-xs text-neutral-600">
              Status: <span className="font-medium">{taskId ? status : "—"}</span>
              {taskId ? <div className="mt-1 break-all text-[11px] text-neutral-500">Task ID: {taskId}</div> : null}
            </div>

            {outputUrl ? (
              <button onClick={downloadVideo} className="w-full rounded-xl border px-4 py-2.5 text-sm hover:bg-neutral-50">
                Download Video
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-2xl border p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-medium">Preview</div>
          {outputUrl ? (
            <a href={outputUrl} target="_blank" rel="noreferrer" className="rounded-xl border px-3 py-2 text-sm hover:bg-neutral-50">
              Open URL
            </a>
          ) : null}
        </div>

        {outputUrl ? (
          <video className="mt-3 w-full rounded-xl border" controls playsInline src={outputUrl} />
        ) : (
          <div className="mt-3 rounded-xl border border-dashed p-6 text-center text-sm text-neutral-500">Generate a video to preview here</div>
        )}
      </div>
    </div>
  );
}
