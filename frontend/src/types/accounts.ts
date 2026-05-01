export type AccountType = "main" | "sub" | "system";
export type AccountStatus = "active" | "inactive";

export interface CredentialsMeta {
  id: string;
  /** Masked public key, e.g. `****abcd`. */
  apiKey: string;
  isActive: boolean;
  lastVerifiedAt: string | null;
  permissions: Record<string, unknown> | null;
}

export interface Account {
  id: string;
  modeSlug: string;
  label: string;
  accountType: AccountType;
  binanceUid: string | null;
  isActive: boolean;
  /** Paper system account has `false` — no API keys. */
  requiresApi: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  credentials: CredentialsMeta | null;
}

export interface CreateAccountDto {
  label: string;
  accountType: "main" | "sub";
  binanceUid?: string;
  notes?: string;
}

export interface UpdateAccountDto {
  label?: string;
  notes?: string | null;
  binance_uid?: string | null;
}
