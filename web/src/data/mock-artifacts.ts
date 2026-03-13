export interface Artifact {
  id: string;
  name: string;
  type: "wireframe" | "deck" | "map" | "notes" | "app" | "diagram";
  status: "ready" | "online" | "offline" | "starting" | "generating";
  path: string;
  port?: number;
  createdAt: string;
}

export async function fetchArtifacts(): Promise<Artifact[]> {
  const res = await fetch("/api/artifacts");
  if (!res.ok) return [];
  return res.json();
}

export async function startApp(name: string): Promise<{ status: string; port?: number }> {
  const res = await fetch(`/api/apps/${name}/start`);
  return res.json();
}

export async function stopApp(name: string): Promise<{ status: string }> {
  const res = await fetch(`/api/apps/${name}/stop`);
  return res.json();
}
