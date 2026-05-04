// This component drives window drag + resize by mutating position/size refs
// directly and matching them to CSS transforms imperatively — avoiding the
// per-pixel re-renders that reactive state would trigger. Reading ref.current
// during render is load-bearing here, so disable react-hooks/refs file-wide.
/* eslint-disable react-hooks/refs */
import { useRef, useCallback, type ReactNode, type PointerEvent } from "react";

type ResizeEdge = "e" | "w" | "s" | "n" | "se" | "sw" | "ne" | "nw";

const MIN_W = 320;
const MIN_H = 200;

interface Props {
  title: string;
  children: ReactNode;
  onFocus?: () => void;
  onClose: () => void;
  defaultX: number;
  defaultY: number;
  defaultW: number;
  defaultH: number;
  zIndex: number;
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
  extraHeader?: ReactNode;
}

export function WindowChrome({
  title,
  children,
  onFocus,
  onClose,
  defaultX,
  defaultY,
  defaultW,
  defaultH,
  zIndex,
  fullscreen = false,
  onToggleFullscreen,
  extraHeader,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const offset = useRef({ x: 0, y: 0 });
  const pos = useRef({ x: defaultX, y: defaultY });
  const size = useRef({ w: defaultW, h: defaultH });

  // ── Drag (title bar) ──

  const onPointerDown = useCallback((e: PointerEvent) => {
    if (fullscreen) return;
    if ((e.target as HTMLElement).closest(".window-controls")) return;
    e.preventDefault();

    const el = ref.current!;
    const rect = el.getBoundingClientRect();
    offset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };

    document.body.style.userSelect = "none";
    document.querySelectorAll("iframe").forEach((f) => {
      (f as HTMLElement).style.pointerEvents = "none";
    });

    function onMove(ev: globalThis.PointerEvent) {
      const x = ev.clientX - offset.current.x;
      const y = ev.clientY - offset.current.y;
      pos.current = { x, y };
      el.style.left = x + "px";
      el.style.top = y + "px";
    }

    function onUp() {
      document.body.style.userSelect = "";
      document.querySelectorAll("iframe").forEach((f) => {
        (f as HTMLElement).style.pointerEvents = "";
      });
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [fullscreen]);

  // ── Resize (edges & corners) ──

  const onResizePointerDown = useCallback((edge: ResizeEdge, e: PointerEvent) => {
    if (fullscreen) return;
    e.preventDefault();
    e.stopPropagation();

    const el = ref.current!;
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = size.current.w;
    const startH = size.current.h;
    const startLeft = pos.current.x;
    const startTop = pos.current.y;

    document.body.style.userSelect = "none";
    document.querySelectorAll("iframe").forEach((f) => {
      (f as HTMLElement).style.pointerEvents = "none";
    });

    function onMove(ev: globalThis.PointerEvent) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;

      let newW = startW;
      let newH = startH;
      let newX = startLeft;
      let newY = startTop;

      if (edge.includes("e")) newW = Math.max(MIN_W, startW + dx);
      if (edge.includes("s")) newH = Math.max(MIN_H, startH + dy);
      if (edge.includes("w")) {
        newW = Math.max(MIN_W, startW - dx);
        newX = startLeft + startW - newW;
      }
      if (edge.includes("n")) {
        newH = Math.max(MIN_H, startH - dy);
        newY = startTop + startH - newH;
      }

      size.current = { w: newW, h: newH };
      pos.current = { x: newX, y: newY };
      el.style.width = newW + "px";
      el.style.height = newH + "px";
      el.style.left = newX + "px";
      el.style.top = newY + "px";
    }

    function onUp() {
      document.body.style.userSelect = "";
      document.querySelectorAll("iframe").forEach((f) => {
        (f as HTMLElement).style.pointerEvents = "";
      });
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [fullscreen]);

  const handleTitleBarDoubleClick = useCallback(() => {
    onToggleFullscreen?.();
  }, [onToggleFullscreen]);

  const className = `window-chrome window-enter${fullscreen ? " fullscreen" : ""}`;

  const style: React.CSSProperties = fullscreen
    ? { position: "fixed", inset: 0, zIndex: 9999 }
    : {
        position: "absolute",
        left: pos.current.x,
        top: pos.current.y,
        width: size.current.w,
        height: size.current.h,
        zIndex,
      };

  return (
    <div
      ref={ref}
      className={className}
      onMouseDown={onFocus}
      style={style}
    >
      {!fullscreen && (
        <>
          <div className="resize-edge resize-n" onPointerDown={(e) => onResizePointerDown("n", e)} />
          <div className="resize-edge resize-s" onPointerDown={(e) => onResizePointerDown("s", e)} />
          <div className="resize-edge resize-e" onPointerDown={(e) => onResizePointerDown("e", e)} />
          <div className="resize-edge resize-w" onPointerDown={(e) => onResizePointerDown("w", e)} />
          <div className="resize-corner resize-nw" onPointerDown={(e) => onResizePointerDown("nw", e)} />
          <div className="resize-corner resize-ne" onPointerDown={(e) => onResizePointerDown("ne", e)} />
          <div className="resize-corner resize-sw" onPointerDown={(e) => onResizePointerDown("sw", e)} />
          <div className="resize-corner resize-se" onPointerDown={(e) => onResizePointerDown("se", e)} />
        </>
      )}
      <div
        className="window-titlebar"
        onPointerDown={onPointerDown}
        onDoubleClick={handleTitleBarDoubleClick}
      >
        <span className="window-title">{title}</span>
        <div className="window-controls" onMouseDown={(e) => e.stopPropagation()}>
          {extraHeader}
          {onToggleFullscreen && (
            <button
              className="window-btn window-expand-btn"
              onClick={onToggleFullscreen}
              title={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            >
              {fullscreen ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="4 14 10 14 10 20" />
                  <polyline points="20 10 14 10 14 4" />
                  <line x1="14" y1="10" x2="21" y2="3" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 3 21 3 21 9" />
                  <polyline points="9 21 3 21 3 15" />
                  <line x1="21" y1="3" x2="14" y2="10" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
              )}
            </button>
          )}
          <button className="window-btn close" onClick={onClose}>
            ×
          </button>
        </div>
      </div>
      <div className="window-body">{children}</div>
    </div>
  );
}
