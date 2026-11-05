import { useEffect, useRef, type PointerEvent } from "react";

// Dimensions are local preferences, shared by all projects on this browser.
export function ResizeHandle({
  name,
  target,
  variable,
  axis = "y",
  reverse = false,
  min,
  max,
}: {
  name: string;
  target: string;
  variable: string;
  axis?: "x" | "y";
  reverse?: boolean;
  min: number;
  max: number;
}) {
  const drag = useRef<{ start: number; size: number } | null>(null);
  useEffect(() => {
    const saved = Number(localStorage.getItem(`studio.layout.${variable}`));
    if (saved >= min && saved <= max)
      document.documentElement.style.setProperty(variable, `${saved}px`);
  }, [variable, min, max]);
  function resize(size: number) {
    const value = Math.round(Math.max(min, Math.min(max, size)));
    document.documentElement.style.setProperty(variable, `${value}px`);
    localStorage.setItem(`studio.layout.${variable}`, String(value));
  }
  function size() {
    const r = document.querySelector(target)?.getBoundingClientRect();
    return r ? (axis === "x" ? r.width : r.height) : min;
  }
  function move(e: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    resize(
      drag.current.size +
        ((axis === "x" ? e.clientX : e.clientY) - drag.current.start) *
          (reverse ? -1 : 1),
    );
  }
  return (
    <div
      role="separator"
      aria-label={name}
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      tabIndex={0}
      className={`resize-handle resize-${axis}`}
      title={`${name}：拖动或方向键调整，双击恢复`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        drag.current = {
          start: axis === "x" ? e.clientX : e.clientY,
          size: size(),
        };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={move}
      onPointerUp={(e) => {
        drag.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onDoubleClick={() => {
        document.documentElement.style.removeProperty(variable);
        localStorage.removeItem(`studio.layout.${variable}`);
      }}
      onKeyDown={(e) => {
        const positive = axis === "x" ? "ArrowRight" : "ArrowDown",
          negative = axis === "x" ? "ArrowLeft" : "ArrowUp";
        if (e.key === positive || e.key === negative) {
          e.preventDefault();
          resize(size() + (e.key === positive ? 16 : -16) * (reverse ? -1 : 1));
        }
      }}
    />
  );
}
