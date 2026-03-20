export type ArtifactKind =
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
  label: string;
  artifactKind: ArtifactKind;
  spaceId: string;
  status: ArtifactStatus;
  runtimeKind: string;
  runtimeConfig: Record<string, unknown>;
  url: string;
  icon?: string;
  iconStatus?: IconStatus;
  createdAt: string;
}
