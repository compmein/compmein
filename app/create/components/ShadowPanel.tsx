"use client";

import React from "react";

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
  shadow: Shadow;
  setShadow: React.Dispatch<React.SetStateAction<Shadow>>;
};

export function ShadowPanel({ shadow, setShadow }: Props) {
  return (
    <div className="mt-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium" />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={shadow.enabled}
            onChange={(e) => setShadow((s) => ({ ...s, enabled: e.target.checked }))}
          />
          开启
        </label>
      </div>

      <div className="mt-3 space-y-3">
        <div>
          <div className="flex items-center justify-between text-xs text-neutral-600">
            <span>左右移动</span>
            <span>{shadow.xOffset}</span>
          </div>
          <input
            type="range"
            min={-80}
            max={80}
            step={1}
            value={shadow.xOffset}
            onChange={(e) => setShadow((s) => ({ ...s, xOffset: parseInt(e.target.value, 10) }))}
            className="w-full"
            disabled={!shadow.enabled}
          />
        </div>

        <div>
          <div className="flex items-center justify-between text-xs text-neutral-600">
            <span>上下位置</span>
            <span>{shadow.yOffset}</span>
          </div>
          <input
            type="range"
            min={-100}
            max={100}
            step={1}
            value={shadow.yOffset}
            onChange={(e) => setShadow((s) => ({ ...s, yOffset: parseInt(e.target.value, 10) }))}
            className="w-full"
            disabled={!shadow.enabled}
          />
        </div>

        <div>
          <div className="flex items-center justify-between text-xs text-neutral-600">
            <span>透明度</span>
            <span>{shadow.opacity.toFixed(2)}</span>
          </div>
          <input
            type="range"
            min={0}
            max={0.6}
            step={0.01}
            value={shadow.opacity}
            onChange={(e) => setShadow((s) => ({ ...s, opacity: parseFloat(e.target.value) }))}
            className="w-full"
            disabled={!shadow.enabled}
          />
        </div>

        <div>
          <div className="flex items-center justify-between text-xs text-neutral-600">
            <span>模糊（外层）</span>
            <span>{shadow.blur}</span>
          </div>
          <input
            type="range"
            min={0}
            max={80}
            step={1}
            value={shadow.blur}
            onChange={(e) => setShadow((s) => ({ ...s, blur: parseInt(e.target.value, 10) }))}
            className="w-full"
            disabled={!shadow.enabled}
          />
          <div className="mt-1 text-[11px] text-neutral-500">这是“真模糊”（filters+cache）。外层建议 25~60。</div>
        </div>

        <div>
          <div className="flex items-center justify-between text-xs text-neutral-600">
            <span>宽度（越大越窄）</span>
            <span>{shadow.widthFactor.toFixed(1)}</span>
          </div>
          <input
            type="range"
            min={0.8}
            max={3.5}
            step={0.1}
            value={shadow.widthFactor}
            onChange={(e) => setShadow((s) => ({ ...s, widthFactor: parseFloat(e.target.value) }))}
            className="w-full"
            disabled={!shadow.enabled}
          />
        </div>

        <div>
          <div className="flex items-center justify-between text-xs text-neutral-600">
            <span>高度</span>
            <span>{shadow.height}</span>
          </div>
          <input
            type="range"
            min={6}
            max={60}
            step={1}
            value={shadow.height}
            onChange={(e) => setShadow((s) => ({ ...s, height: parseInt(e.target.value, 10) }))}
            className="w-full"
            disabled={!shadow.enabled}
          />
        </div>

        <div className="mt-2 text-[11px] text-neutral-500">
          半身照没脚时：优先调 <b>上下位置</b> + <b>透明度</b> + <b>模糊</b>。
        </div>
      </div>
    </div>
  );
}
