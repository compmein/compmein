"use client";

import React from "react";
import { SubjectPanel } from "./SubjectPanel";
import { ShadowPanel } from "./ShadowPanel";
import { GradePanel } from "./GradePanel";

type Grade = {
  gain: number;
  gamma: number;
  exposure: number;
  temp: number;
  tint: number;
};

type Shadow = {
  enabled: boolean;
  opacity: number;
  blur: number;
  widthFactor: number;
  height: number;
  yOffset: number;
  squashY: number;
  xOffset: number;
};

type Props = {
  title?: string;

  // subject
  subjectChoice: "uploaded" | "none";
  storedPersonDataUrl: string | null;
  isCutting: boolean;

  // token
  tokenCostCutout: number;
  hasTokens: (n: number) => boolean;
  canCutout: boolean;

  // cutout
  cutoutDataUrl: string | null;

  // shadow / grade
  shadow: Shadow;
  setShadow: React.Dispatch<React.SetStateAction<Shadow>>;
  grade: Grade;
  setGrade: React.Dispatch<React.SetStateAction<Grade>>;

  // handlers
  onChangeChoice: (v: "uploaded" | "none") => void;
  onSelectFile: (file: File) => void;
  onCutout: () => void;
  onDownloadCutout: () => void;
};

export function SubjectSection({
  title = "人物 1",
  subjectChoice,
  storedPersonDataUrl,
  isCutting,
  tokenCostCutout,
  hasTokens,
  canCutout,
  cutoutDataUrl,
  shadow,
  setShadow,
  grade,
  setGrade,
  onChangeChoice,
  onSelectFile,
  onCutout,
  onDownloadCutout,
}: Props) {
  return (
    <details open className="rounded-2xl border p-4">
      <summary className="cursor-pointer select-none text-sm font-medium">
        {title}
      </summary>

      <div className="mt-3 space-y-4">
        {/* 人物（默认展开） */}
        <details open className="rounded-2xl border p-3">
          <summary className="cursor-pointer select-none text-sm font-medium">
            人物
          </summary>

          <SubjectPanel
            subjectChoice={subjectChoice}
            storedPersonDataUrl={storedPersonDataUrl}
            isCutting={isCutting}
            tokenCostCutout={tokenCostCutout}
            hasTokens={hasTokens}
            canCutout={canCutout}
            cutoutDataUrl={cutoutDataUrl}
            onChangeChoice={onChangeChoice}
            onSelectFile={onSelectFile}
            onCutout={onCutout}
            onDownloadCutout={onDownloadCutout}
          />
        </details>

        {/* 阴影（默认折叠） */}
        <details className="rounded-2xl border p-3">
          <summary className="cursor-pointer select-none text-sm font-medium">
            阴影
          </summary>
          <ShadowPanel shadow={shadow} setShadow={setShadow} />
        </details>

        {/* 调色（默认折叠） */}
        <details className="rounded-2xl border p-3">
          <summary className="cursor-pointer select-none text-sm font-medium">
            调色
          </summary>
          <GradePanel grade={grade} setGrade={setGrade} />
        </details>
      </div>
    </details>
  );
}
