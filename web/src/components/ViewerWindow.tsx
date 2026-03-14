import { useRef, useCallback, type PointerEvent as ReactPointerEvent } from "react";
import { WindowChrome } from "./WindowChrome";

interface Props {
  title: string;
  path: string;
  defaultX: number;
  defaultY: number;
  zIndex: number;
  fullscreen: boolean;
  onFocus?: () => void;
  onClose: () => void;
  onToggleFullscreen: () => void;
  onNavigate?: (direction: -1 | 1) => void;
  hasPrev?: boolean;
  hasNext?: boolean;
}

export function ViewerWindow({
  title,
  path,
  defaultX,
  defaultY,
  zIndex,
  fullscreen,
  onFocus,
  onClose,
  onToggleFullscreen,
  onNavigate,
  hasPrev = false,
  hasNext = false,
}: Props) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const dragOffset = useRef({ x: 0, y: 0 });

  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    // Only drag from the toolbar background / title, not from buttons
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();

    const el = toolbarRef.current!;
    const rect = el.getBoundingClientRect();
    dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    el.setPointerCapture(e.pointerId);

    // Reset centered transform so absolute positioning works
    el.style.transform = "none";
    el.style.left = `${rect.left}px`;
    el.style.top = `${rect.top}px`;
  }, []);

  const onPointerMove = useCallback((e: ReactPointerEvent) => {
    const el = toolbarRef.current!;
    if (!el.hasPointerCapture(e.pointerId)) return;

    const x = e.clientX - dragOffset.current.x;
    const y = e.clientY - dragOffset.current.y;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, []);

  const onPointerUp = useCallback((e: ReactPointerEvent) => {
    const el = toolbarRef.current!;
    if (el.hasPointerCapture(e.pointerId)) {
      el.releasePointerCapture(e.pointerId);
    }
  }, []);

  return (
    <WindowChrome
      title={fullscreen ? "" : title}
      onFocus={onFocus}
      onClose={onClose}
      defaultX={defaultX}
      defaultY={defaultY}
      defaultW={640}
      defaultH={480}
      zIndex={zIndex}
      fullscreen={fullscreen}
      onToggleFullscreen={onToggleFullscreen}
    >
      {fullscreen && (
        <div
          ref={toolbarRef}
          className="fullscreen-toolbar"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          <button
            className="fullscreen-toolbar-btn"
            disabled={!hasPrev}
            onClick={() => onNavigate?.(-1)}
            title="Previous doc"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <span className="fullscreen-toolbar-title">{title}</span>
          <button
            className="fullscreen-toolbar-btn"
            disabled={!hasNext}
            onClick={() => onNavigate?.(1)}
            title="Next doc"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>
          <div className="fullscreen-toolbar-sep" />
          <button
            className="fullscreen-toolbar-btn"
            onClick={onToggleFullscreen}
            title="Exit fullscreen"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 14 10 14 10 20" />
              <polyline points="20 10 14 10 14 4" />
              <line x1="14" y1="10" x2="21" y2="3" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          </button>
          <button
            className="fullscreen-toolbar-btn fullscreen-toolbar-close"
            onClick={onClose}
            title="Close"
          >
            ×
          </button>
        </div>
      )}
      <iframe
        src={`${path}?t=${Date.now()}`}
        className="viewer-iframe"
        title={title}
      />
    </WindowChrome>
  );
}
