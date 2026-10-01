// Full-page login, shown instead of the app when the server has a password
// (LOOM_PASSWORD) and this browser has no session.
import { LockSimple, Moon, Spinner, Sun } from "@phosphor-icons/react";
import { useRef, useState, type FormEvent } from "react";
import { auth } from "../api";
import { Banner } from "../components/ui";
import type { Theme } from "../theme";

export default function Login({
  onSuccess,
  theme,
  onToggleTheme,
  onBack,
}: {
  onSuccess: () => void;
  theme: Theme;
  onToggleTheme: () => void;
  /** Present when login was opened from a published notebook. */
  onBack?: () => void;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    try {
      await auth.login(password);
      onSuccess();
    } catch (err) {
      const message = (err as Error).message;
      setError(message === "invalid password" ? "Wrong password. Try again." : message);
      setPassword("");
      setBusy(false);
      input.current?.focus();
    }
  };

  return (
    <div className="login-page">
      <button className="btn icon ghost login-theme" onClick={onToggleTheme} title="Toggle theme">
        {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
      </button>
      <form className="login-card" onSubmit={submit}>
        <div className="brand" style={{ padding: 0 }}>
          <span className="brand-mark">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M3 3v10h10M6 10l3-4 3 3" />
            </svg>
          </span>
          Loom
        </div>
        <h1>Log in</h1>
        {error && <Banner kind="error">{error}</Banner>}
        {/* Lets password managers file the credential under a stable name. */}
        <input type="text" name="username" autoComplete="username" value="loom" readOnly hidden />
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            autoFocus
            ref={input}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={error !== null}
          />
        </label>
        <button className="btn primary login-submit" type="submit" disabled={busy || !password}>
          {busy ? <Spinner size={14} className="spin" /> : <LockSimple size={14} weight="bold" />} Log in
        </button>
        <p className="login-hint">
          Loom is password-protected — the password is the <code>LOOM_PASSWORD</code> set on the server.
        </p>
        {onBack && (
          <button type="button" className="btn ghost sm" onClick={onBack} style={{ alignSelf: "center" }}>
            Back to the published notebook
          </button>
        )}
      </form>
    </div>
  );
}
