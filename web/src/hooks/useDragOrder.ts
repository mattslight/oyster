import { useState, useRef, useCallback, useEffect, type PointerEvent } from "react";
import type { DesktopItem } from "./useDesktopSections";
import type { SortMode } from "./useDesktopPreferences";

const DRAG_THRESHOLD = 6;
const STORAGE_KEY_PREFIX = "oyster-icon-order:";

export function setStoredOrder(space: string, keys: string[]) {
  try { localStorage.setItem(STORAGE_KEY_PREFIX + space, JSON.stringify(keys)); } catch { /* ignore */ }
}

export function useDragOrder(space: string, sortMode: SortMode, orderedItems: DesktopItem[]) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [displayItems, setDisplayItems] = useState(orderedItems);
  const dragState = useRef<{
    key: string;
    startX: number;
    startY: number;
    isDragging: boolean;
    clone: HTMLElement | null;
    sourceRect: DOMRect | null;
    currentOrder: DesktopItem[];
  } | null>(null);

  // Keep displayItems in sync when orderedItems changes (space switch, new artifacts)
  useEffect(() => {
    if (!dragState.current?.isDragging) setDisplayItems(orderedItems);
  }, [orderedItems]);

  const getGridSlotFromPoint = useCallback((clientX: number, clientY: number): number => {
    const grid = gridRef.current;
    if (!grid) return -1;
    const rect = grid.getBoundingClientRect();
    const style = getComputedStyle(grid);
    const padLeft = parseFloat(style.paddingLeft);
    const gap = parseFloat(style.gap) || 12;
    const colWidth = 130;
    const innerWidth = rect.width - padLeft - parseFloat(style.paddingRight);
    const cols = Math.max(1, Math.floor((innerWidth + gap) / (colWidth + gap)));
    const x = clientX - rect.left - padLeft;
    const y = clientY - rect.top - parseFloat(style.paddingTop) + grid.scrollTop;
    const firstChild = grid.firstElementChild as HTMLElement | null;
    const itemH = firstChild ? firstChild.offsetHeight : 120;
    const col = Math.max(0, Math.min(cols - 1, Math.floor((x + gap / 2) / (colWidth + gap))));
    const row = Math.max(0, Math.floor((y + gap / 2) / (itemH + gap)));
    return row * cols + col;
  }, []);

  const onPointerDown = useCallback((e: PointerEvent, key: string) => {
    if (e.button !== 0 || sortMode !== "alpha") return;
    dragState.current = {
      key,
      startX: e.clientX,
      startY: e.clientY,
      isDragging: false,
      clone: null,
      sourceRect: (e.currentTarget as HTMLElement).getBoundingClientRect(),
      currentOrder: displayItems,
    };
  }, [displayItems, sortMode]);

  useEffect(() => {
    function onMove(e: globalThis.PointerEvent) {
      const ds = dragState.current;
      if (!ds) return;

      if (!ds.isDragging) {
        const dx = e.clientX - ds.startX;
        const dy = e.clientY - ds.startY;
        if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;

        ds.isDragging = true;
        setDragKey(ds.key);

        const grid = gridRef.current;
        if (!grid) return;
        let sourceEl: HTMLElement | null = null;
        grid.querySelectorAll<HTMLElement>("[data-drag-key]").forEach((el) => {
          if (el.dataset.dragKey === ds.key) sourceEl = el;
        });
        if (!sourceEl) return;

        const rect = (sourceEl as HTMLElement).getBoundingClientRect();
        ds.sourceRect = rect;
        const clone = (sourceEl as HTMLElement).cloneNode(true) as HTMLElement;
        clone.className = (sourceEl as HTMLElement).className + " drag-clone";
        clone.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;z-index:10000;pointer-events:none;transition:transform 0.05s ease`;
        document.body.appendChild(clone);
        ds.clone = clone;
        document.body.style.userSelect = "none";
      }

      if (ds.clone && ds.sourceRect) {
        ds.clone.style.transform = `translate(${e.clientX - ds.startX}px, ${e.clientY - ds.startY}px) scale(1.08)`;
      }

      const slotIndex = getGridSlotFromPoint(e.clientX, e.clientY);
      if (slotIndex < 0) return;
      const order = [...ds.currentOrder];
      const fromIndex = order.findIndex((it) => it.key === ds.key);
      if (fromIndex < 0) return;
      const toIndex = Math.min(slotIndex, order.length - 1);
      if (fromIndex !== toIndex) {
        const [moved] = order.splice(fromIndex, 1);
        order.splice(toIndex, 0, moved);
        ds.currentOrder = order;
        setDisplayItems(order);
      }
    }

    function onUp() {
      const ds = dragState.current;
      if (!ds) return;
      if (ds.isDragging) {
        setStoredOrder(space, ds.currentOrder.map((it) => it.key));
        setDisplayItems(ds.currentOrder);
        ds.clone?.remove();
        document.body.style.userSelect = "";
        setDragKey(null);
      }
      dragState.current = null;
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [space, getGridSlotFromPoint]);

  return { gridRef, dragKey, displayItems, onPointerDown };
}
