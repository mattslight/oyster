export type ArtifactType =
  | "app"
  | "deck"
  | "diagram"
  | "map"
  | "notes"
  | "table"
  | "wireframe";

export type ArtifactStatus =
  | "generating"
  | "offline"
  | "online"
  | "ready"
  | "starting";

export type IconStatus = "pending" | "generating" | "ready" | "failed";

export interface Artifact {
  id: string;
  name: string;
  type: ArtifactType;
  status: ArtifactStatus;
  path: string;
  port?: number;
  space: string;
  createdAt: string;
  icon?: string;
  iconStatus?: IconStatus;
}
