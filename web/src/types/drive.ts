export interface DriveFile {
  id: string;
  name: string;
  path: string;
  parentPath: string;
  isFolder: boolean;
  size: number;
  contentType: string | null;
  createdAt: string;
  updatedAt: string;
  s3Uri?: string | null;
}

export interface UploadTicket {
  fileId: string;
  uploadUrl: string;
  requiredHeaders: Record<string, string>;
  expiresAt: string;
}

export interface ShareLink {
  id: string;
  fileId: string | null;
  folderPath: string | null;
  type: "file" | "folder";
  targetName: string;
  shareUrl: string;
  hasPassword: boolean;
  maxDownloads: number | null;
  downloadCount: number;
  expiresAt: string | null;
  createdAt: string;
}

export type ShareStatus = "active" | "expired" | "depleted" | "not_found";

export interface ShareInfo {
  id: string;
  file: DriveFile | null;
  folderPath: string | null;
  requiresPassword: boolean;
  maxDownloads: number | null;
  downloadCount: number;
  expiresAt: string | null;
  status: ShareStatus;
  message?: string;
}

export interface GuideSection {
  title: string;
  content: string;
}

export interface GuideData {
  title: string;
  intro: string;
  sections: GuideSection[];
}

export interface ShareAccessResult {
  accessToken: string;
}

export interface ShareDownloadResult {
  downloadUrl: string;
  fileName: string;
  downloadCount: number;
}

export interface CreateShareInput {
  fileId?: string;
  folderPath?: string;
  password?: string;
  maxDownloads?: number | null;
  expiresAt?: string | null;
  expiresIn?: number | null;
}
