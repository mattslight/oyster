export interface Artifact {
  id: string;
  name: string;
  type: "wireframe" | "deck" | "map" | "notes" | "app" | "diagram";
  status: "ready" | "generating";
  path: string;
  createdAt: string;
}

export const mockArtifacts: Artifact[] = [
  {
    id: "1",
    name: "Homepage Wireframe",
    type: "wireframe",
    status: "ready",
    path: "/demo/wireframe.html",
    createdAt: "2026-03-13T10:00:00Z",
  },
  {
    id: "2",
    name: "Audit Presentation",
    type: "deck",
    status: "ready",
    path: "/demo/deck.html",
    createdAt: "2026-03-13T10:30:00Z",
  },
  {
    id: "3",
    name: "Product Surface Map",
    type: "map",
    status: "ready",
    path: "/demo/map.html",
    createdAt: "2026-03-13T11:00:00Z",
  },
  {
    id: "4",
    name: "Discussion Notes",
    type: "notes",
    status: "ready",
    path: "/demo/notes.html",
    createdAt: "2026-03-13T11:30:00Z",
  },
];
