import { useEffect, useReducer, useState } from "react";
import { Desktop } from "./components/Desktop";
import { ChatBar } from "./components/ChatBar";
import { Clock } from "./components/Clock";
import { ViewerWindow } from "./components/ViewerWindow";
import { TerminalWindow } from "./components/TerminalWindow";
import { windowsReducer } from "./stores/windows";
import {
  type Artifact,
  fetchArtifacts,
  startApp as startAppApi,
  stopApp as stopAppApi,
} from "./data/mock-artifacts";
import "./App.css";

export default function App() {
  const [windows, dispatch] = useReducer(windowsReducer, []);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);

  // Fetch artifacts on mount
  useEffect(() => {
    fetchArtifacts().then(setArtifacts);
  }, []);

  // Poll for status updates every 5 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      fetchArtifacts().then(setArtifacts);
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const viewers = windows.filter((w) => w.type === "viewer");
  const terminalWindow = windows.find((w) => w.type === "terminal");

  function handleArtifactGenerated(artifact: Artifact) {
    setArtifacts((prev) => [...prev, artifact]);
  }

  async function handleArtifactClick(artifact: Artifact) {
    if (artifact.type === "app") {
      if (artifact.status === "starting") return;

      if (artifact.status === "online") {
        window.open(artifact.path, artifact.id, "width=1280,height=900");
        return;
      }

      // offline — optimistically set to starting, then start
      setArtifacts((prev) =>
        prev.map((a) =>
          a.id === artifact.id ? { ...a, status: "starting" as const } : a
        )
      );
      const appName = artifact.id.replace("app:", "");
      await startAppApi(appName);
      window.open(artifact.path, artifact.id, "width=1280,height=900");
    } else {
      dispatch({ type: "OPEN_VIEWER", title: artifact.name, path: artifact.path });
    }
  }

  async function handleArtifactStop(artifact: Artifact) {
    const appName = artifact.id.replace("app:", "");
    await stopAppApi(appName);
  }

  return (
    <div className="oyster-shell">
      <Clock />

      <Desktop
        artifacts={artifacts}
        onArtifactClick={handleArtifactClick}
        onArtifactStop={handleArtifactStop}
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
