import { FormEvent, TouchEvent, useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { registerOrLoginBackend, saveBackendToken } from "../../services/backend";
import {
  changeCloudPassword,
  loginOrRegisterCloudAccount,
  logoutCloudAccount,
  recoverSignedInCloudAccount,
  restoreAllCloudData,
  restoreCloudBootstrapData,
  saveCloudProfile,
  syncAllLocalData,
} from "../../services/supabase";
import { sha256 } from "../../services/sha256";

const ACCOUNT_KEYS = new Set([
  "4ta:account-name",
  "4ta:account-password-hash",
  "4ta:onboarding-complete",
]);

const LOCAL_RECOVERY_KEY = "4ta:local-recovery-mode";
const FORCED_LEGACY_RECOVERY_ACCOUNTS = new Set(["wen304"]);

function hasMeaningfulLocalData() {
  return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).some((key) =>
    key === "4ta:ta-profiles" || key === "4ta:chat-messages" || Boolean(key?.startsWith("4ta:chat-messages:")) || key === "4ta:onboarding-complete");
}

function hasRecoveredTaProfiles() {
  try {
    const profiles = JSON.parse(localStorage.getItem("4ta:ta-profiles") || "[]");
    return Array.isArray(profiles) && profiles.some((profile) =>
      profile && typeof profile.id === "string" && typeof profile.name === "string");
  } catch {
    return false;
  }
}

function hasCompletedExistingAccount() {
  return localStorage.getItem("4ta:onboarding-complete") === "1" || hasRecoveredTaProfiles();
}

function clearPreviousAccountData() {
  const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
  keys.forEach((key) => {
    if (key?.startsWith("4ta:") && !ACCOUNT_KEYS.has(key)) {
      localStorage.removeItem(key);
    }
  });
  ACCOUNT_KEYS.forEach((key) => localStorage.removeItem(key));
}

async function hashPassword(password: string) {
  return sha256(password);
}

function isCloudNetworkFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /load failed|failed to fetch|networkerror|network request failed|connection.*(?:closed|reset)|无法连接|网络连接/i.test(message);
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string) {
  return Promise.race<T>([
    promise,
    new Promise<T>((_, reject) => window.setTimeout(() => reject(new Error(message)), milliseconds)),
  ]);
}

export function AccountEntryPage() {
  if (
    localStorage.getItem(LOCAL_RECOVERY_KEY) !== "1" &&
    localStorage.getItem("4ta:account-name") &&
    localStorage.getItem("4ta:onboarding-complete") === "1"
  ) {
    return <Navigate to="/home" replace />;
  }
  return <AccountPage />;
}

function AccountPage() {
  const navigate = useNavigate();
  const [account, setAccount] = useState(() => localStorage.getItem("4ta:account-name") || "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [recovering, setRecovering] = useState(true);

  useEffect(() => {
    let active = true;
    void recoverSignedInCloudAccount()
      .then((recoveredAccount) => {
        if (!active || !recoveredAccount) return;
        localStorage.setItem("4ta:account-name", recoveredAccount);
        navigate(hasCompletedExistingAccount() ? "/home" : "/welcome", { replace: true });
      })
      .catch(() => undefined)
      .finally(() => { if (active) setRecovering(false); });
    return () => { active = false; };
  }, [navigate]);

  // iOS standalone PWAs can fail to transfer focus to controlled inputs when
  // they live inside a fixed, scrollable root. Keep the focus call inside the
  // trusted touch event so the system keyboard is allowed to open.
  function focusInput(event: TouchEvent<HTMLInputElement>) {
    event.stopPropagation();
    if (document.activeElement !== event.currentTarget) {
      event.currentTarget.focus({ preventScroll: true });
    }
  }

  async function register(event: FormEvent) {
    event.preventDefault();
    const cleanAccount = account.trim();
    if (!cleanAccount || password.length < 6) {
      setError(!cleanAccount ? "请输入账号" : "密码至少需要 6 位");
      return;
    }
    setSaving(true);
    try {
      const backendAccount = await withTimeout(registerOrLoginBackend(cleanAccount, password), 8_000, "账号服务响应超时，请重试");
      const cloudAccount = await withTimeout(loginOrRegisterCloudAccount(cleanAccount, password), 20_000, "登录服务响应超时，请检查网络后重试");
      const passwordHash = await hashPassword(password);
      // Never erase existing characters or chats merely because the account
      // service classified this credential pair as a new account.
      if (cloudAccount.isNew && !hasMeaningfulLocalData()) clearPreviousAccountData();
      localStorage.setItem("4ta:account-name", cleanAccount);
      localStorage.setItem("4ta:account-password-hash", passwordHash);
      localStorage.removeItem(LOCAL_RECOVERY_KEY);
      if (backendAccount) saveBackendToken(backendAccount.token);
      await withTimeout(saveCloudProfile(cleanAccount), 15_000, "账号已登录，但云端资料保存超时");
      const restored = cloudAccount.isNew
        ? false
        : await withTimeout(restoreCloudBootstrapData(), 15_000, "账号已登录，但基础资料恢复超时");
      let existingAccountRecovered = restored && hasCompletedExistingAccount();
      if (FORCED_LEGACY_RECOVERY_ACCOUNTS.has(cleanAccount.toLocaleLowerCase())) {
        // Bootstrap recovery already fetched the profile list and individual
        // identity snapshots. Never fetch chats/media here: this legacy
        // account has a large history and that would block login again.
        if (!hasRecoveredTaProfiles()) {
          throw new Error("已登录旧账号，但没有读取到角色资料。系统已停止创建新角色，请稍后重试");
        }
        localStorage.setItem("4ta:onboarding-complete", "1");
        localStorage.removeItem(LOCAL_RECOVERY_KEY);
        existingAccountRecovered = true;
      }
      localStorage.setItem("4ta:account-name", cleanAccount);
      navigate(existingAccountRecovered ? "/home" : "/welcome", { replace: true });
      if (!cloudAccount.isNew) {
        // Full history/media restoration is intentionally detached from login.
        // It can be large on iOS and continues after the user enters the app.
        void restoreAllCloudData().then(() => {
          window.dispatchEvent(new CustomEvent("4ta:characters-recovered"));
          window.dispatchEvent(new CustomEvent("4ta:cloud-chat-restored"));
        }).catch(() => undefined);
      }
    } catch (saveError) {
      if (isCloudNetworkFailure(saveError)) {
        // The user's credentials cannot be verified while the Supabase project
        // domain is blocked by the current network. Keep all existing device
        // data intact and allow a reversible local session instead of trapping
        // the user on the account page or misclassifying this as a new account.
        localStorage.setItem("4ta:account-name", cleanAccount);
        localStorage.setItem("4ta:account-password-hash", await hashPassword(password));
        localStorage.setItem(LOCAL_RECOVERY_KEY, "1");
        if (hasMeaningfulLocalData()) {
          localStorage.setItem("4ta:onboarding-complete", "1");
          navigate("/home", { replace: true });
        } else {
          navigate("/welcome", { replace: true });
        }
        return;
      }
      setError(saveError instanceof Error ? saveError.message : "账号保存失败，请重试");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="account-page">
      <section className="account-card">
        <header>
          <span className="account-mark" aria-hidden="true">♡</span>
          <h1>登录或创建账号</h1>
          <p>登录后，找回只属于你的 Ta</p>
        </header>
        <form onSubmit={register}>
          <label htmlFor="account-name-input">
            <span>账号</span>
            <input
              id="account-name-input"
              name="account"
              type="text"
              value={account}
              inputMode="text"
              enterKeyHint="next"
              onChange={(event) => {
                setAccount(event.target.value);
                setError("");
              }}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              onTouchStart={focusInput}
              maxLength={30}
              placeholder="请输入账号"
            />
          </label>
          <label htmlFor="account-password-input">
            <span>密码</span>
            <input
              id="account-password-input"
              name="password"
              type="password"
              value={password}
              enterKeyHint="done"
              onChange={(event) => {
                setPassword(event.target.value);
                setError("");
              }}
              autoComplete="current-password"
              onTouchStart={focusInput}
              maxLength={64}
              placeholder="至少 6 位"
            />
          </label>
          {error && <p className="account-error" role="alert">{error}</p>}
          <button type="submit" disabled={saving || recovering}>
            {saving ? "保存中…" : recovering ? "正在查找原账号…" : "保存并继续"}
          </button>
        </form>
        {hasMeaningfulLocalData() && (
          <button
            className="account-local-recovery"
            type="button"
            onClick={() => {
              localStorage.setItem(LOCAL_RECOVERY_KEY, "1");
              navigate("/home", { replace: true });
            }}
          >
            先进入本机已有数据
          </button>
        )}
        <small>账号资料与文件会安全保存在云端</small>
      </section>
    </main>
  );
}

function AccountHeader({ title }: { title: string }) {
  const navigate = useNavigate();
  return (
    <header className="personal-header">
      <button type="button" aria-label="返回" onClick={() => navigate("/home?tab=profile")}>‹</button>
      <h1>{title}</h1>
    </header>
  );
}

export function AccountManagementPage() {
  const navigate = useNavigate();
  const account = localStorage.getItem("4ta:account-name") || "未设置";
  const [error, setError] = useState("");
  const [leaving, setLeaving] = useState(false);

  async function logout() {
    setLeaving(true);
    setError("");
    try {
      await logoutCloudAccount();
      clearPreviousAccountData();
      navigate("/", { replace: true });
    } catch (logoutError) {
      setError(logoutError instanceof Error ? logoutError.message : "退出失败，请重试");
      setLeaving(false);
    }
  }

  return (
    <main className="personal-page account-management-page">
      <AccountHeader title="账号管理" />
      <section className="account-settings-list">
        <div><span>账号</span><strong>{account}</strong></div>
        <button type="button" onClick={() => navigate("/settings/account/password")}>
          <span>修改密码</span><b>›</b>
        </button>
      </section>
      {error && <p className="account-manage-error">{error}</p>}
      <button className="account-logout-button" type="button" disabled={leaving} onClick={logout}>
        {leaving ? "正在保存数据…" : "退出登录"}
      </button>
    </main>
  );
}

export function ChangePasswordPage() {
  const navigate = useNavigate();
  const account = localStorage.getItem("4ta:account-name") || "";
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password.length < 6 || password !== confirmPassword) {
      setError(password.length < 6 ? "新密码至少需要 6 位" : "两次输入的密码不一致");
      return;
    }
    setSaving(true);
    try {
      await changeCloudPassword(account, password);
      localStorage.setItem("4ta:account-password-hash", await hashPassword(password));
      await syncAllLocalData();
      navigate("/settings/account", { replace: true });
    } catch (passwordError) {
      setError(passwordError instanceof Error ? passwordError.message : "密码修改失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="personal-page account-management-page">
      <AccountHeader title="修改密码" />
      <form className="change-password-form" onSubmit={submit}>
        <label><span>新密码</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 6 位" /></label>
        <label><span>确认新密码</span><input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="再次输入新密码" /></label>
        {error && <p className="account-manage-error">{error}</p>}
        <button type="submit" disabled={saving}>{saving ? "保存中…" : "保存新密码"}</button>
      </form>
    </main>
  );
}
