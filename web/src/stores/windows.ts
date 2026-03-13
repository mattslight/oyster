export type WindowType = "chat" | "viewer";

export interface WindowState {
  id: string;
  type: WindowType;
  title: string;
  minimized: boolean;
  statusText: string;
  artifactPath?: string;
}

export type WindowAction =
  | { type: "OPEN_CHAT" }
  | { type: "OPEN_VIEWER"; title: string; path: string }
  | { type: "MINIMIZE"; id: string }
  | { type: "RESTORE"; id: string }
  | { type: "CLOSE"; id: string }
  | { type: "UPDATE_STATUS"; id: string; statusText: string };

let nextId = 1;

export function windowsReducer(
  state: WindowState[],
  action: WindowAction
): WindowState[] {
  switch (action.type) {
    case "OPEN_CHAT": {
      const existing = state.find((w) => w.type === "chat" && !w.minimized);
      if (existing) return state;
      const minimized = state.find((w) => w.type === "chat" && w.minimized);
      if (minimized) {
        return state.map((w) =>
          w.id === minimized.id ? { ...w, minimized: false } : w
        );
      }
      return [
        ...state,
        {
          id: "chat-" + nextId++,
          type: "chat",
          title: "Chat",
          minimized: false,
          statusText: "",
        },
      ];
    }
    case "OPEN_VIEWER": {
      const existing = state.find(
        (w) => w.type === "viewer" && w.artifactPath === action.path
      );
      if (existing) {
        return state.map((w) =>
          w.id === existing.id ? { ...w, minimized: false } : w
        );
      }
      return [
        ...state,
        {
          id: "viewer-" + nextId++,
          type: "viewer",
          title: action.title,
          minimized: false,
          statusText: "",
          artifactPath: action.path,
        },
      ];
    }
    case "MINIMIZE":
      return state.map((w) =>
        w.id === action.id ? { ...w, minimized: true } : w
      );
    case "RESTORE":
      return state.map((w) =>
        w.id === action.id ? { ...w, minimized: false } : w
      );
    case "CLOSE":
      return state.filter((w) => w.id !== action.id);
    case "UPDATE_STATUS":
      return state.map((w) =>
        w.id === action.id ? { ...w, statusText: action.statusText } : w
      );
    default:
      return state;
  }
}
