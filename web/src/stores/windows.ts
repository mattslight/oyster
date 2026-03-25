export type WindowType = "chat" | "viewer" | "terminal";

export interface WindowState {
  id: string;
  type: WindowType;
  title: string;
  statusText: string;
  artifactPath?: string;
  zIndex: number;
  fullscreen: boolean;
}

export type WindowAction =
  | { type: "OPEN_CHAT" }
  | { type: "OPEN_VIEWER"; title: string; path: string; fullscreen?: boolean }
  | { type: "CLOSE"; id: string }
  | { type: "CLOSE_ALL_VIEWERS" }
  | { type: "UPDATE_STATUS"; id: string; statusText: string }
  | { type: "OPEN_TERMINAL" }
  | { type: "FOCUS"; id: string }
  | { type: "TOGGLE_FULLSCREEN"; id: string }
  | { type: "NAVIGATE_VIEWER"; id: string; title: string; artifactPath: string };

let nextId = 1;
let topZ = 100;

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
      return [
        ...state,
        {
          id: "viewer-" + nextId++,
          type: "viewer",
          title: action.title,
          statusText: "",
          artifactPath: action.path,
          zIndex: topZ,
          fullscreen: action.fullscreen ?? false,
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
    case "FOCUS": {
      topZ++;
      return state.map((w) =>
        w.id === action.id ? { ...w, zIndex: topZ } : w
      );
    }
    case "TOGGLE_FULLSCREEN": {
      return state.map((w) =>
        w.id === action.id ? { ...w, fullscreen: !w.fullscreen } : w
      );
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
