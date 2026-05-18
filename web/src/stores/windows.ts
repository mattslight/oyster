export type WindowType = "chat" | "viewer" | "terminal" | "claude_terminal";

export interface WindowState {
  id: string;
  type: WindowType;
  title: string;
  statusText: string;
  artifactPath?: string;
  zIndex: number;
  fullscreen: boolean;
  /** Claude terminal: identifier passed back to /ws/terminal?id=…. */
  terminalId?: string;
  /** Claude terminal: cwd shown in the title bar. */
  cwd?: string;
  /** Claude terminal: kind drives the title prefix ("claude" vs "resume"). */
  terminalKind?: "claude_new" | "claude_resume";
  /** Claude terminal: session id once auto-link succeeds; turns the title
   *  into a link to the Session Inspector. */
  linkedSessionId?: string;
}

export type WindowAction =
  | { type: "OPEN_CHAT" }
  | { type: "OPEN_VIEWER"; title: string; path: string; fullscreen?: boolean }
  | { type: "CLOSE"; id: string }
  | { type: "CLOSE_ALL_VIEWERS" }
  | { type: "UPDATE_STATUS"; id: string; statusText: string }
  | { type: "OPEN_TERMINAL" }
  | {
      type: "OPEN_CLAUDE_TERMINAL";
      terminalId: string;
      title: string;
      cwd: string;
      kind: "claude_new" | "claude_resume";
      linkedSessionId?: string;
    }
  | { type: "LINK_TERMINAL_SESSION"; terminalId: string; sessionId: string }
  | { type: "FOCUS"; id: string }
  | { type: "TOGGLE_FULLSCREEN"; id: string }
  | { type: "NAVIGATE_VIEWER"; id: string; title: string; artifactPath: string };

let nextId = 1;
let topZ = 100;

const FS_KEY = "oyster-fullscreen-pref";

function getFsPref(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(FS_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveFsPref(path: string, fs: boolean) {
  const prefs = getFsPref();
  prefs[path] = fs;
  localStorage.setItem(FS_KEY, JSON.stringify(prefs));
}

export function windowsReducer(
  state: WindowState[],
  action: WindowAction
): WindowState[] {
  switch (action.type) {
    case "OPEN_CHAT": {
      const existing = state.find((w) => w.type === "chat");
      if (existing) {
        topZ++;
        return state.map((w) =>
          w.id === existing.id ? { ...w, zIndex: topZ } : w
        );
      }
      topZ++;
      return [
        ...state,
        {
          id: "chat-" + nextId++,
          type: "chat",
          title: "Chat",
          statusText: "",
          zIndex: topZ,
          fullscreen: false,
        },
      ];
    }
    case "OPEN_VIEWER": {
      const existing = state.find(
        (w) => w.type === "viewer" && w.artifactPath === action.path
      );
      if (existing) {
        topZ++;
        return state.map((w) =>
          w.id === existing.id ? { ...w, zIndex: topZ } : w
        );
      }
      topZ++;
      const savedFs = getFsPref()[action.path];
      const fs = savedFs !== undefined ? savedFs : (action.fullscreen ?? false);
      return [
        ...state,
        {
          id: "viewer-" + nextId++,
          type: "viewer",
          title: action.title,
          statusText: "",
          artifactPath: action.path,
          zIndex: topZ,
          fullscreen: fs,
        },
      ];
    }
    case "CLOSE":
      return state.filter((w) => w.id !== action.id);
    case "CLOSE_ALL_VIEWERS":
      return state.filter((w) => w.type !== "viewer");
    case "UPDATE_STATUS":
      return state.map((w) =>
        w.id === action.id ? { ...w, statusText: action.statusText } : w
      );
    case "OPEN_TERMINAL": {
      const existing = state.find((w) => w.type === "terminal");
      if (existing) {
        topZ++;
        return state.map((w) =>
          w.id === existing.id ? { ...w, zIndex: topZ } : w
        );
      }
      topZ++;
      return [
        ...state,
        {
          id: "terminal-" + nextId++,
          type: "terminal",
          title: "opencode",
          statusText: "",
          zIndex: topZ,
          fullscreen: false,
        },
      ];
    }
    case "OPEN_CLAUDE_TERMINAL": {
      // Always appends — multiple Claude terminals can coexist.
      topZ++;
      return [
        ...state,
        {
          id: "claude-term-" + nextId++,
          type: "claude_terminal",
          title: action.title,
          statusText: "",
          zIndex: topZ,
          fullscreen: false,
          terminalId: action.terminalId,
          cwd: action.cwd,
          terminalKind: action.kind,
          linkedSessionId: action.linkedSessionId,
        },
      ];
    }
    case "LINK_TERMINAL_SESSION": {
      return state.map((w) =>
        w.type === "claude_terminal" && w.terminalId === action.terminalId
          ? { ...w, linkedSessionId: action.sessionId }
          : w
      );
    }
    case "FOCUS": {
      topZ++;
      return state.map((w) =>
        w.id === action.id ? { ...w, zIndex: topZ } : w
      );
    }
    case "TOGGLE_FULLSCREEN": {
      return state.map((w) => {
        if (w.id !== action.id) return w;
        const newFs = !w.fullscreen;
        if (w.artifactPath) saveFsPref(w.artifactPath, newFs);
        return { ...w, fullscreen: newFs };
      });
    }
    case "NAVIGATE_VIEWER": {
      return state.map((w) =>
        w.id === action.id
          ? { ...w, title: action.title, artifactPath: action.artifactPath }
          : w
      );
    }
    default:
      return state;
  }
}
