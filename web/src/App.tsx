import { useReducer, useState } from "react";
import { Desktop } from "./components/Desktop";
import { ChatBar } from "./components/ChatBar";
import { Clock } from "./components/Clock";
import { ViewerWindow } from "./components/ViewerWindow";
import { TerminalWindow } from "./components/TerminalWindow";
import { windowsReducer } from "./stores/windows";
import { type Artifact } from "./data/mock-artifacts";
import "./App.css";

export default function App() {
  const [windows, dispatch] = useReducer(windowsReducer, []);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);

  const viewers = windows.filter((w) => w.type === "viewer");
  const terminalWindow = windows.find((w) => w.type === "terminal");

  function handleArtifactGenerated(artifact: Artifact) {
    setArtifacts((prev) => [...prev, artifact]);
  }

  return (
    <div className="oyster-shell">
      <Clock />

      <Desktop
        artifacts={artifacts}
        onArtifactClick={(a) =>
          dispatch({ type: "OPEN_VIEWER", title: a.name, path: a.path })
        }
      />

      <div className="windows-layer">
        {viewers.map((w, i) => (
          <ViewerWindow
            key={w.id}
            title={w.title}
            path={w.artifactPath!}
            defaultX={200 + i * 20}
            defaultY={40 + i * 20}
            zIndex={w.zIndex}
            onFocus={() => dispatch({ type: "FOCUS", id: w.id })}
            onClose={() => dispatch({ type: "CLOSE", id: w.id })}
          />
        ))}
        {terminalWindow && (
          <TerminalWindow
            key={terminalWindow.id}
            defaultX={120}
            defaultY={60}
            zIndex={terminalWindow.zIndex}
            onFocus={() => dispatch({ type: "FOCUS", id: terminalWindow.id })}
            onClose={() => dispatch({ type: "CLOSE", id: terminalWindow.id })}
          />
        )}
      </div>

      <ChatBar
        onArtifactGenerated={handleArtifactGenerated}
        onOpenTerminal={() => dispatch({ type: "OPEN_TERMINAL" })}
      />
    </div>
  );
}
