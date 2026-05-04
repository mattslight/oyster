// web/src/hooks/useCopyLink.ts

import { useCallback, useEffect, useRef, useState } from "react";

interface UseCopyLink {
  /** True for ~1.2 s after a successful copy. Drives the green-✓ render branch. */
  copied: boolean;
  /** True after a copy that errored (clipboard access denied / no clipboard API). */
  failed: boolean;
  /** Trigger the copy. Returns the promise so callers can await if needed. */
  copy: () => Promise<void>;
}

const FLASH_MS = 1200;

export function useCopyLink(url: string): UseCopyLink {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, []);

  const copy = useCallback(async () => {
    setFailed(false);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        // Fallback for environments without the async clipboard API.
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        if (!ok) throw new Error("execCommand copy failed");
      }
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), FLASH_MS);
    } catch (err) {
      console.error("[publish] copy failed:", err);
      setFailed(true);
    }
  }, [url]);

  return { copied, failed, copy };
}
