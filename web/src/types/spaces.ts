export type SpaceRole = "viewer" | "contributor" | "editor" | "creator";

/** Roles assignable to a member (everyone except the implicit "creator"). */
export type MemberRole = Exclude<SpaceRole, "creator">;

export interface SpaceSummary {
  id: string;
  name: string;
  visibility: string;
  creatorId: string;
  createdAt: string;
  role: SpaceRole;
  memberCount: number;
  itemCount: number;
}

export interface SpaceMember {
  userId: string;
  email: string | null;
  role: SpaceRole;
  addedBy: string | null;
  addedAt: string;
}

export type SpaceItemType = "file" | "folder" | "memory";

export interface SpaceItemDisplay {
  id: string;
  itemType: SpaceItemType;
  itemRef: string;
  name: string | null;
  contributedBy: string;
  addedAt: string;
}

export interface SpaceMemoryHit {
  id: string;
  key: string | null;
  content: string;
  tags: string[];
  source: string | null;
  createdAt: string;
  updatedAt: string;
}
