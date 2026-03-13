import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { WindowChrome } from "./WindowChrome";

interface Props {
  defaultX: number;
  defaultY: number;
  zIndex: number;
  onFocus?: () => void;
  onClose: () => void;
}

const WS_URL = "ws://localhost:4200";

export function TerminalWindow({
  defaultX,
  defaultY,
  zIndex,
  onFocus,
  onClose,
}: Props) {
  const termRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!termRef.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'IBM Plex Mono', monospace",
      theme: {
        background: "#1e1f36",
        foreground: "#e8e9f0",
        cursor: "#21b981",
        selectionBackground: "rgba(33, 185, 129, 0.3)",
        black: "#1a1b2e",
        brightBlack: "#555770",
        green: "#21b981",
        brightGreen: "#34d399",
        blue: "#6366f1",
        brightBlue: "#818cf8",
        yellow: "#f59e0b",
        brightYellow: "#fbbf24",
        red: "#ef4444",
        brightRed: "#f87171",
        magenta: "#a855f7",
        brightMagenta: "#c084fc",
        cyan: "#06b6d4",
        brightCyan: "#22d3ee",
        white: "#e8e9f0",
        brightWhite: "#ffffff",
      },
    });
    terminalRef.current = terminal;

    const fitAddon = new FitAddon();
    fitRef.current = fitAddon;
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());

    terminal.open(termRef.current);
    fitAddon.fit();

    // Connect to WebSocket PTY server
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      // Send initial size
      const dims = fitAddon.proposeDimensions();
      if (dims) {
        ws.send(`\x01resize:${dims.cols},${dims.rows}`);
      }
    };

    ws.onmessage = (event) => {
      terminal.write(typeof event.data === "string" ? event.data : "");
    };

    ws.onclose = () => {
      terminal.write("\r\n\x1b[90m[connection closed]\x1b[0m\r\n");
    };

    ws.onerror = () => {
      terminal.write(
        "\r\n\x1b[31m[connection error — is the server running?]\x1b[0m\r\n"
      );
    };

    // Terminal input → WebSocket
    terminal.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      const dims = fitAddon.proposeDimensions();
      if (dims && ws.readyState === WebSocket.OPEN) {
        ws.send(`\x01resize:${dims.cols},${dims.rows}`);
      }
    });
    resizeObserver.observe(termRef.current);

    return () => {
      resizeObserver.disconnect();
      ws.close();
      terminal.dispose();
    };
  }, []);

  return (
    <WindowChrome
      title="opencode"
      onFocus={onFocus}
      onClose={onClose}
      defaultX={defaultX}
      defaultY={defaultY}
      defaultW={720}
      defaultH={480}
      zIndex={zIndex}
    >
      <div
        ref={termRef}
        style={{ width: "100%", height: "100%", padding: "4px" }}
      />
    </WindowChrome>
  );
}
