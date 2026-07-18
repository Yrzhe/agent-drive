export type AccessStatus = "active" | "pending" | "suspended";

export interface AccountStatus {
  status: AccessStatus;
  email: string | null;
  isAdmin: boolean;
}

export interface WaitlistEntry {
  userId: string;
  email: string | null;
  name: string | null;
  message: string | null;
  referredBy: string | null;
  appliedAt: string;
}

export interface AllowlistEntry {
  email: string;
  addedBy: string;
  addedAt: string;
}

export interface AdminUser {
  userId: string;
  email: string | null;
  name: string | null;
  status: AccessStatus;
}
