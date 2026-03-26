import { useMemo, useRef, useState, useCallback, useEffect, type PointerEvent } from "react";
import type { Artifact } from "../data/artifacts-api";
import { ArtifactIcon } from "./ArtifactIcon";
import { GroupIcon } from "./GroupIcon";
import Grainient from "./reactbits/Grainient";

interface Props {
  space: string;
  artifacts: Artifact[];
  onArtifactClick: (artifact: Artifact) => void;
  onArtifactStop?: (artifact: Artifact) => void;
  onGroupClick: (groupName: string) => void;
}

type DesktopItem =
  | { type: "group"; key: string; name: string; artifacts: Artifact[] }
  | { type: "artifact"; key: string; artifact: Artifact };

const DRAG_THRESHOLD = 6;
const STORAGE_KEY_PREFIX = "oyster-icon-order:";

function getStoredOrder(space: string): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PREFIX + space);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function setStoredOrder(space: string, keys: string[]) {
  localStorage.setItem(STORAGE_KEY_PREFIX + space, JSON.stringify(keys));
}

function applyOrder(items: DesktopItem[], order: string[]): DesktopItem[] {
  if (order.length === 0) return items;
  const map = new Map(items.map((it) => [it.key, it]));
  const ordered: DesktopItem[] = [];
  for (const key of order) {
    const item = map.get(key);
    if (item) {
      ordered.push(item);
      map.delete(key);
    }
  }
  // Append any items not in the stored order
  for (const item of map.values()) {
    ordered.push(item);
  }
  return ordered;
}

export function Desktop({ space, artifacts, onArtifactClick, onArtifactStop, onGroupClick }: Props) {
  const { groups, ungrouped } = useMemo(() => {
    const groups: Record<string, Artifact[]> = {};
    const ungrouped: Artifact[] = [];
    for (const a of artifacts) {
      if (a.groupName) {
        (groups[a.groupName] ??= []).push(a);
      } else {
        ungrouped.push(a);
      }
    }
    return { groups, ungrouped };
  }, [artifacts]);

  const baseItems = useMemo<DesktopItem[]>(() => {
    const sortedGroupNames = Object.keys(groups).sort();
    const items: DesktopItem[] = [];
    for (const name of sortedGroupNames) {
      items.push({ type: "group", key: `group:${name}`, name, artifacts: groups[name] });
    }
    for (const artifact of ungrouped) {
      items.push({ type: "artifact", key: artifact.id, artifact });
    }
    return items;
  }, [groups, ungrouped]);

  const orderedItems = useMemo(
    () => applyOrder(baseItems, getStoredOrder(space)),
    [baseItems, space]
  );

  // Drag state
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
    if (!dragState.current?.isDragging) {
      setDisplayItems(orderedItems);
    }
  }, [orderedItems]);

  const getGridSlotFromPoint = useCallback((clientX: number, clientY: number): number => {
    const grid = gridRef.current;
    if (!grid) return -1;
    const rect = grid.getBoundingClientRect();
    const style = getComputedStyle(grid);
    const padLeft = parseFloat(style.paddingLeft);
    const padTop = parseFloat(style.paddingTop);
    const gap = parseFloat(style.gap) || 12;
    const colWidth = 130;

    const innerWidth = rect.width - padLeft - parseFloat(style.paddingRight);
    const cols = Math.max(1, Math.floor((innerWidth + gap) / (colWidth + gap)));

    const x = clientX - rect.left - padLeft;
    const y = clientY - rect.top - padTop + grid.scrollTop;

    // Get actual item height from first child
    const firstChild = grid.firstElementChild as HTMLElement | null;
    const itemH = firstChild ? firstChild.offsetHeight : 120;

    const col = Math.max(0, Math.min(cols - 1, Math.floor((x + gap / 2) / (colWidth + gap))));
    const row = Math.max(0, Math.floor((y + gap / 2) / (itemH + gap)));
    return row * cols + col;
  }, []);

  const onPointerDown = useCallback((e: PointerEvent, key: string) => {
    // Only left click
    if (e.button !== 0) return;
    const target = e.currentTarget as HTMLElement;
    dragState.current = {
      key,
      startX: e.clientX,
      startY: e.clientY,
      isDragging: false,
      clone: null,
      sourceRect: target.getBoundingClientRect(),
      currentOrder: displayItems,
    };
  }, [displayItems]);

  useEffect(() => {
    function onMove(e: globalThis.PointerEvent) {
      const ds = dragState.current;
      if (!ds) return;

      if (!ds.isDragging) {
        const dx = e.clientX - ds.startX;
        const dy = e.clientY - ds.startY;
        if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;

        // Start dragging — create floating clone
        ds.isDragging = true;
        setDragKey(ds.key);

        const grid = gridRef.current;
        if (!grid) return;

        // Find the source element
        const items = grid.querySelectorAll<HTMLElement>("[data-drag-key]");
        let sourceEl: HTMLElement | null = null;
        items.forEach((el) => {
          if (el.dataset.dragKey === ds.key) sourceEl = el;
        });
        if (!sourceEl) return;

        const rect = sourceEl.getBoundingClientRect();
        ds.sourceRect = rect;

        const clone = sourceEl.cloneNode(true) as HTMLElement;
        clone.className = sourceEl.className + " drag-clone";
        clone.style.position = "fixed";
        clone.style.left = rect.left + "px";
        clone.style.top = rect.top + "px";
        clone.style.width = rect.width + "px";
        clone.style.height = rect.height + "px";
        clone.style.zIndex = "10000";
        clone.style.pointerEvents = "none";
        clone.style.opacity = "1";
        clone.style.transition = "transform 0.05s ease";
        document.body.appendChild(clone);
        ds.clone = clone;

        document.body.style.userSelect = "none";
      }

      // Move clone
      if (ds.clone && ds.sourceRect) {
        const dx = e.clientX - ds.startX;
        const dy = e.clientY - ds.startY;
        ds.clone.style.transform = `translate(${dx}px, ${dy}px) scale(1.08)`;
      }

      // Calculate which slot cursor is over and reorder
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
        // Save order
        setStoredOrder(space, ds.currentOrder.map((it) => it.key));
        setDisplayItems(ds.currentOrder);

        // Cleanup clone
        if (ds.clone) {
          ds.clone.remove();
        }
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

  return (
    <div className="desktop">
      <div className="desktop-bg">
        <Grainient
          color1="#07060f"
          color2="#7c6bff"
          color3="#5227FF"
          timeSpeed={0.15}
          colorBalance={0}
          warpStrength={2}
          warpFrequency={6.5}
          warpSpeed={2}
          warpAmplitude={20}
          blendAngle={0}
          blendSoftness={0.05}
          rotationAmount={500}
          noiseScale={2}
          grainAmount={0.15}
          grainScale={2}
          grainAnimated={false}
          contrast={1.2}
          gamma={0.8}
          saturation={0.7}
          centerX={0}
          centerY={0}
          zoom={1}
        />
      </div>
      <div className="icon-grid" ref={gridRef}>
        {displayItems.map((item, i) => {
          const isDragged = item.key === dragKey;
          if (item.type === "group") {
            return (
              <div
                key={item.key}
                data-drag-key={item.key}
                className={isDragged ? "drag-placeholder" : ""}
                onPointerDown={(e) => onPointerDown(e, item.key)}
                style={isDragged ? undefined : { transition: "transform 0.25s ease" }}
              >
                <GroupIcon
                  name={item.name}
                  artifacts={item.artifacts}
                  index={i}
                  onClick={() => onGroupClick(item.name)}
                />
              </div>
            );
          }
          return (
            <div
              key={item.key}
              data-drag-key={item.key}
              className={isDragged ? "drag-placeholder" : ""}
              onPointerDown={(e) => onPointerDown(e, item.key)}
              style={isDragged ? undefined : { transition: "transform 0.25s ease" }}
            >
              <ArtifactIcon
                artifact={item.artifact}
                index={i}
                onClick={() => onArtifactClick(item.artifact)}
                onStop={onArtifactStop ? () => onArtifactStop(item.artifact) : undefined}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
