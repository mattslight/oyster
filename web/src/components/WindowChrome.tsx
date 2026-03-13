import { useRef, useCallback, type ReactNode, type PointerEvent } from "react";

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
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const offset = useRef({ x: 0, y: 0 });
  const pos = useRef({ x: defaultX, y: defaultY });

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

  const handleTitleBarDoubleClick = useCallback(() => {
    onToggleFullscreen?.();
  }, [onToggleFullscreen]);

  const className = `window-chrome window-enter${fullscreen ? " fullscreen" : ""}`;

  return (
    <div
      ref={ref}
      className={className}
      onMouseDown={onFocus}
      style={
        fullscreen
          ? { position: "fixed", inset: 0, zIndex: 9999 }
          : {
              position: "absolute",
              left: pos.current.x,
              top: pos.current.y,
              width: defaultW,
              height: defaultH,
              zIndex,
            }
      }
    >
      <div
        className="window-titlebar"
        onPointerDown={onPointerDown}
        onDoubleClick={handleTitleBarDoubleClick}
      >
        <span className="window-title">{title}</span>
        <div className="window-controls" onMouseDown={(e) => e.stopPropagation()}>
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
