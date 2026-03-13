import { useReducer, useState } from "react";
import { Desktop } from "./components/Desktop";
import { Taskbar } from "./components/Taskbar";
import { ChatWindow } from "./components/ChatWindow";
import { ViewerWindow } from "./components/ViewerWindow";
import { windowsReducer } from "./stores/windows";
import { mockArtifacts, type Artifact } from "./data/mock-artifacts";
import "./App.css";

export default function App() {
  const [windows, dispatch] = useReducer(windowsReducer, []);
  const [artifacts, setArtifacts] = useState<Artifact[]>(mockArtifacts);

  const visibleWindows = windows.filter((w) => !w.minimized);

  function handleArtifactGenerated(artifact: Artifact) {
    setArtifacts((prev) => [...prev, artifact]);
  }

  return (
    <div className="oyster-shell">
      <Desktop
        artifacts={artifacts}
        onArtifactClick={(a) =>
          dispatch({ type: "OPEN_VIEWER", title: a.name, path: a.path })
        }
      />

      <div className="windows-layer">
        {visibleWindows.map((w, i) => {
          if (w.type === "chat") {
            return (
              <ChatWindow
                key={w.id}
                defaultX={window.innerWidth - 460 - i * 20}
                defaultY={window.innerHeight - 48 - 520 - i * 20}
                zIndex={100 + i}
                onMinimize={() => dispatch({ type: "MINIMIZE", id: w.id })}
                onClose={() => dispatch({ type: "CLOSE", id: w.id })}
                onStatusUpdate={(text) =>
                  dispatch({ type: "UPDATE_STATUS", id: w.id, statusText: text })
                }
                onArtifactGenerated={handleArtifactGenerated}
              />
            );
          }
          if (w.type === "viewer" && w.artifactPath) {
            return (
              <ViewerWindow
                key={w.id}
                title={w.title}
                path={w.artifactPath}
                defaultX={200 + i * 20}
                defaultY={40 + i * 20}
                zIndex={100 + i}
                onMinimize={() => dispatch({ type: "MINIMIZE", id: w.id })}
                onClose={() => dispatch({ type: "CLOSE", id: w.id })}
              />
            );
          }
          return null;
        })}
      </div>

      <Taskbar
        windows={windows}
        onOysterClick={() => dispatch({ type: "OPEN_CHAT" })}
        onChipClick={(id) => dispatch({ type: "RESTORE", id })}
      />
    </div>
  );
}
