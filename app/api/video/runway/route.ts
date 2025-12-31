import { NextResponse } from "next/server";

export const runtime = "nodejs";

const RUNWAY_API_BASE = "https://api.dev.runwayml.com";
const RUNWAY_VERSION = "2024-11-06";

function j(status: number, body: any) {
  return NextResponse.json(body, { status });
}

function toInt(v: any, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

// POST: create image_to_video task (using imageUrl)
export async function POST(req: Request) {
  const apiKey = process.env.RUNWAYML_API_SECRET;
  if (!apiKey) return j(500, { error: "Missing env RUNWAYML_API_SECRET" });

  const body = await req.json().catch(() => ({}));

  const imageUrl = String(body?.imageUrl || "").trim();
  const promptText = String(body?.promptText || "").trim();
  const ratio = String(body?.ratio || "1280:720").trim();
  const duration = toInt(body?.duration ?? 5, 5);

  if (!imageUrl) return j(400, { error: "Missing imageUrl" });
  if (!promptText) return j(400, { error: "Missing promptText" });

  const safeDuration = Math.min(10, Math.max(2, duration));
  const allowedRatios = new Set(["1280:720", "720:1280", "1104:832", "832:1104", "960:960", "1584:672"]);
  const safeRatio = allowedRatios.has(ratio) ? ratio : "1280:720";

  const payload = {
    model: "gen4_turbo",
    promptImage: [{ uri: imageUrl, position: "first" }],
    promptText,
    ratio: safeRatio,
    duration: safeDuration,
  };

  const r = await fetch(`${RUNWAY_API_BASE}/v1/image_to_video`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-Runway-Version": RUNWAY_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const txt = await r.text().catch(() => "");
  let data: any = {};
  try {
    data = JSON.parse(txt);
  } catch {
    data = { raw: txt };
  }

  if (!r.ok) {
    return j(r.status, {
      error: "Runway create task failed",
      details: data,
    });
  }

  const taskId = String(data?.id || "");
  if (!taskId) return j(502, { error: "Runway returned no task id", details: data });

  return j(200, { taskId });
}

// GET: check task status
export async function GET(req: Request) {
  const apiKey = process.env.RUNWAYML_API_SECRET;
  if (!apiKey) return j(500, { error: "Missing env RUNWAYML_API_SECRET" });

  const { searchParams } = new URL(req.url);
  const taskId = String(searchParams.get("taskId") || "").trim();
  if (!taskId) return j(400, { error: "Missing taskId" });

  const r = await fetch(`${RUNWAY_API_BASE}/v1/tasks/${encodeURIComponent(taskId)}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-Runway-Version": RUNWAY_VERSION,
    },
  });

  const txt = await r.text().catch(() => "");
  let data: any = {};
  try {
    data = JSON.parse(txt);
  } catch {
    data = { raw: txt };
  }

  if (!r.ok) {
    return j(r.status, { error: "Runway task fetch failed", details: data });
  }

  const status = String(data?.status || "UNKNOWN");
  const outputArr = Array.isArray(data?.output) ? data.output : [];
  const outputUrl = outputArr.length ? String(outputArr[0] || "") : "";

  const errMsg =
    (typeof data?.error === "string" && data.error) ||
    (typeof data?.failureReason === "string" && data.failureReason) ||
    "";

  return j(200, {
    status,
    outputUrl,
    error: errMsg,
  });
}
