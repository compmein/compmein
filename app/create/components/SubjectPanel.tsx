"use client";

import React from "react";

type Props = {
  // dropdown
  subjectChoice: "uploaded" | "none";
  storedPersonDataUrl: string | null;

  // upload status
  isCutting: boolean;

  // token
  tokenCostCutout: number;
  hasTokens: (n: number) => boolean;
  canCutout: boolean; // page.tsx 里传：!!originalFile && !isCutting

  // cutout download
  cutoutDataUrl: string | null;

  // handlers
  onChangeChoice: (v: "uploaded" | "none") => void;
  onSelectFile: (file: File) => void;
  onCutout: () => void;
  onDownloadCutout: () => void;
};

export function SubjectPanel({
  subjectChoice,
  storedPersonDataUrl,
  isCutting,
  tokenCostCutout,
  hasTokens,
  canCutout,
  cutoutDataUrl,
  onChangeChoice,
  onSelectFile,
  onCutout,
  onDownloadCutout,
}: Props) {
  return (
    <div className="mt-2 space-y-2">
      <select
        className="w-full rounded-xl border px-3 py-2 text-sm"
        value={subjectChoice}
        onChange={(e) => onChangeChoice(e.target.value as "uploaded" | "none")}
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
            if (f) onSelectFile(f);
          }}
          className="w-full text-sm"
        />
        <div className="mt-1 text-xs text-neutral-500">
          上传人物会自动压缩到长边 1080p。选择“暂无人物”可让 AI 仅基于背景生成。
        </div>
      </div>

      <div className="flex gap-2">
        <button
          onClick={onCutout}
          className="w-1/2 rounded-xl bg-neutral-900 px-4 py-2.5 text-sm text-white hover:opacity-90 disabled:opacity-40"
          disabled={!canCutout || !hasTokens(tokenCostCutout)}
          title={!hasTokens(tokenCostCutout) ? `Not enough tokens (requires ${tokenCostCutout})` : ""}
        >
          {isCutting ? "正在抠图..." : `抠图 · ${tokenCostCutout} Tokens`}
        </button>

        <button
          onClick={onDownloadCutout}
          className="w-1/2 rounded-xl border px-4 py-2.5 text-sm hover:bg-neutral-50 disabled:opacity-40"
          disabled={!cutoutDataUrl}
          title={!cutoutDataUrl ? "请先点一次“抠图”生成透明 PNG" : ""}
        >
          下载抠图
        </button>
      </div>


      <div className="text-xs text-neutral-500">提示：点击人物后可用角点缩放/旋转；也可以直接拖动位置。</div>
    </div>
  );
}
