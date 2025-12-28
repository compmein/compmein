"use client";

import React from "react";

type Grade = { gain: number; gamma: number; exposure: number; temp: number; tint: number };

type Props = {
  grade: Grade;
  setGrade: React.Dispatch<React.SetStateAction<Grade>>;
};

export function GradePanel({ grade, setGrade }: Props) {
  return (
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
          onChange={(e) => setGrade((p) => ({ ...p, gain: Number(e.target.value) }))}
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
          onChange={(e) => setGrade((p) => ({ ...p, gamma: Number(e.target.value) }))}
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
          onChange={(e) => setGrade((p) => ({ ...p, exposure: Number(e.target.value) }))}
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
          onChange={(e) => setGrade((p) => ({ ...p, temp: Number(e.target.value) }))}
          className="w-full"
        />
      </div>

      <div>
        <div className="flex justify-between text-xs text-neutral-600">
          <span>紫绿（Magenta ⇄ Green）</span>
          <span>{grade.tint.toFixed(2)}</span>
        </div>
        <input
          type="range"
          min={-1}
          max={1}
          step={0.01}
          value={grade.tint}
          onChange={(e) => setGrade((p) => ({ ...p, tint: Number(e.target.value) }))}
          className="w-full"
        />
      </div>

      <button
        className="w-full rounded-xl border px-3 py-2 text-sm hover:bg-neutral-50"
        onClick={() => setGrade({ gain: 1, gamma: 1, exposure: 0, temp: 0, tint: 0 })}
      >
        重置调色
      </button>
    </div>
  );
}
