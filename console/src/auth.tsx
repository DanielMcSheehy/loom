// Auth state for the shell. The server decides everything (LOOM_PASSWORD +
// the HttpOnly session cookie); this just mirrors `GET /api/auth/status`.
import { createContext, useContext } from "react";

export interface AuthContext {
  /** The server has a password set. False ⇒ everything is open, no login UI. */
  enabled: boolean;
  logout: () => void;
}

export const AuthCtx = createContext<AuthContext>({ enabled: false, logout: () => {} });
export const useAuth = () => useContext(AuthCtx);

/** The link a published notebook is shared by — the same route the editor uses. */
export const publicNotebookUrl = (id: string) => `${window.location.origin}/notebooks/${id}`;
