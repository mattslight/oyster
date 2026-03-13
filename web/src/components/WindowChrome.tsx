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
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const offset = useRef({ x: 0, y: 0 });
  const pos = useRef({ x: defaultX, y: defaultY });

  const onPointerDown = useCallback((e: PointerEvent) => {
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
  }, []);

  return (
    <div
      ref={ref}
      className="window-chrome window-enter"
      onMouseDown={onFocus}
      style={{
        position: "absolute",
        left: pos.current.x,
        top: pos.current.y,
        width: defaultW,
        height: defaultH,
        zIndex,
      }}
    >
      <div className="window-titlebar" onPointerDown={onPointerDown}>
        <span className="window-title">{title}</span>
        <div className="window-controls" onMouseDown={(e) => e.stopPropagation()}>
          <button className="window-btn close" onClick={onClose}>
            ×
          </button>
        </div>
      </div>
      <div className="window-body">{children}</div>
    </div>
  );
}
