export type WindowType = "chat" | "viewer" | "terminal";

export interface WindowState {
  id: string;
  type: WindowType;
  title: string;
  statusText: string;
  artifactPath?: string;
  zIndex: number;
}

export type WindowAction =
  | { type: "OPEN_CHAT" }
  | { type: "OPEN_VIEWER"; title: string; path: string }
  | { type: "CLOSE"; id: string }
  | { type: "UPDATE_STATUS"; id: string; statusText: string }
  | { type: "OPEN_TERMINAL" }
  | { type: "FOCUS"; id: string };

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
        },
      ];
    }
    case "CLOSE":
      return state.filter((w) => w.id !== action.id);
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
        },
      ];
    }
    case "FOCUS": {
      topZ++;
      return state.map((w) =>
        w.id === action.id ? { ...w, zIndex: topZ } : w
      );
    }
    default:
      return state;
  }
}
