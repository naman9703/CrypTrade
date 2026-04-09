import { createContext, useContext } from "react";

export type AuthActions = {
  /** True when APP_UI_AUTH_ENABLED is on — show Sign out in the header. */
  gated: boolean;
  logout: () => Promise<void>;
};

export const AuthActionsContext = createContext<AuthActions | null>(null);

export function useAuthActions(): AuthActions | null {
  return useContext(AuthActionsContext);
}
