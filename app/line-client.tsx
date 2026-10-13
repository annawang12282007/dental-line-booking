"use client";

import { useEffect, useRef, useState } from "react";
import { classifyLineFailure, performLineRecovery, safeLineDiagnostic } from "./line-recovery.mjs";

type Liff = {
  init: (options: { liffId: string }) => Promise<void>;
  isLoggedIn: () => boolean;
  isInClient: () => boolean;
  logout: () => void;
  login: (options: { redirectUri: string }) => void;
  getIDToken: () => string | null;
};

declare global {
  interface Window { liff?: Liff }
}

type ConnectionConfig = { configured: boolean; liffId: string | null; accountId: string };
type ConfigState = "loading" | "loaded" | "error";
type ActionState = "idle" | "connecting" | "verified" | "error";
let sdkPromise: Promise<Liff> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadLiff(): Promise<Liff> {
  if (window.liff) return Promise.resolve(window.liff);
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<Liff>((resolve, reject) => {
    const script = document.createElement("script");
    const fail = () => {
      window.clearTimeout(timer);
      script.remove();
      sdkPromise = null;
      reject(new Error("SDK_UNAVAILABLE"));
    };
    const timer = window.setTimeout(fail, 15000);
    script.src = "https://static.line-scdn.net/liff/edge/2/sdk.js";
    script.async = true;
    script.onload = () => {
      if (!window.liff) return fail();
      window.clearTimeout(timer);
      resolve(window.liff);
    };
    script.onerror = fail;
    document.head.appendChild(script);
  });
  return sdkPromise;
}

export default function LineClient({ onVerified }: { onVerified?: () => void | Promise<void> }) {
  const [config, setConfig] = useState<ConnectionConfig | null>(null);
  const [configState, setConfigState] = useState<ConfigState>("loading");
  const [attempt, setAttempt] = useState(0);
  const [action, setAction] = useState<ActionState>("idle");
  const [error, setError] = useState("");
  const [recovery, setRecovery] = useState("none");
  const [diagnostic, setDiagnostic] = useState("");
  const resumed = useRef(false);
  const inFlight = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timer = window.setTimeout(() => controller.abort(), 10000);
    fetch("/api/line/config", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("CONFIG_UNAVAILABLE");
        const data = await response.json();
        if (!isRecord(data) || typeof data.configured !== "boolean" || typeof data.accountId !== "string") {
          throw new Error("CONFIG_UNAVAILABLE");
        }
        if (data.configured && (typeof data.liffId !== "string" || !data.liffId.trim())) {
          throw new Error("CONFIG_UNAVAILABLE");
        }
        if (active) {
          setConfig({ configured: data.configured, liffId: typeof data.liffId === "string" ? data.liffId : null, accountId: data.accountId });
          setConfigState("loaded");
        }
      })
      .catch(() => { if (active) setConfigState("error"); })
      .finally(() => window.clearTimeout(timer));
    return () => { active = false; window.clearTimeout(timer); controller.abort(); };
  }, [attempt]);

  useEffect(() => {
    if (resumed.current || configState !== "loaded" || !config?.configured) return;
    const query = new URL(window.location.href).searchParams;
    if (query.has("liff.state") || (query.has("code") && query.has("state"))) {
      resumed.current = true;
      void connect();
    }
  }, [configState, config]);

  async function connect() {
    if (!config?.configured || !config.liffId || inFlight.current || recovery === "configuration" || recovery === "reopen") return;
    inFlight.current = true;
    setAction("connecting");
    setError("");
    setDiagnostic("");
    let phase = "sdk";
    try {
      const liff = await loadLiff();
      phase = "initialization";
      let initTimer: number | undefined;
      try {
        await Promise.race([
          liff.init({ liffId: config.liffId }),
          new Promise<never>((_, reject) => {
            initTimer = window.setTimeout(() => reject(new Error("INIT_TIMEOUT")), 20000);
          }),
        ]);
      } finally {
        if (initTimer !== undefined) window.clearTimeout(initTimer);
      }
      phase = "login_redirect";
      const nextAction = performLineRecovery(liff, { needsFreshLogin: recovery === "fresh", redirectUri: `${window.location.origin}/` });
      if (nextAction === "reopen") {
        setRecovery("reopen");
        setError("請先關閉 LINE 裡的這個頁面，再從原本的預約連結重新開啟，以取得新的登入確認。");
        setDiagnostic(safeLineDiagnostic("ID_TOKEN_UNAVAILABLE").label);
        setAction("error");
        return;
      }
      if (nextAction === "login" || nextAction === "refresh_login") {
        return;
      }
      phase = "identity";
      const idToken = liff.getIDToken();
      if (!idToken) {
        const inClient = liff.isInClient();
        setRecovery(inClient ? "reopen" : "fresh");
        setError(inClient ? "尚未取得 LINE 的登入確認。請關閉此頁，再從原本的預約連結重新開啟。" : "尚未取得 LINE 的登入確認。請按「重新登入 LINE」後繼續。");
        setDiagnostic(safeLineDiagnostic("ID_TOKEN_UNAVAILABLE").label);
        setAction("error");
        return;
      }
      const controller = new AbortController();
      phase = "server_verification";
      const timer = window.setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch("/api/line/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken }),
          cache: "no-store",
          signal: controller.signal,
        });
        const result = await response.json();
        // The public account ID is a same-origin configuration consistency check,
        // not an identity credential. The server verifies LINE claims and session access.
        if (!response.ok || !isRecord(result) || result.verified !== true || result.accountId !== config.accountId) {
          const failure = classifyLineFailure({ status: response.status, code: isRecord(result) ? result.code : undefined, reason: isRecord(result) ? result.reason : undefined, inClient: liff.isInClient() });
          console.warn("LINE_SERVER_VERIFICATION_FAILED", { status: response.status, code: failure.code, reason: failure.reason });
          setRecovery(failure.recovery);
          setDiagnostic(failure.label);
          setError(failure.message);
          setAction("error");
          return;
        }
        setRecovery("none");
        setAction("verified");
        phase = "session";
        await onVerified?.();
      } finally {
        window.clearTimeout(timer);
      }
    } catch (cause) {
      const candidate = phase === "session" ? "SESSION_UNAVAILABLE"
        : cause instanceof Error && ["INIT_TIMEOUT", "SDK_UNAVAILABLE"].includes(cause.message) ? cause.message
        : phase === "login_redirect" ? "LOGIN_REDIRECT_FAILED"
        : phase === "server_verification" ? "NETWORK_ERROR"
        : phase === "initialization" ? "INIT_UNAVAILABLE" : "UNAVAILABLE";
      const { code, label } = safeLineDiagnostic(candidate);
      // Never log provider messages, tokens, profiles, URLs or exception objects.
      console.warn("LINE_CONNECTION_FAILED", { phase, code });
      setDiagnostic(label);
      setError(phase === "session" ? "LINE 身分已驗證，但網站登入狀態尚未建立。請確認瀏覽器允許此網站的 Cookie，再按下方按鈕重試。"
        : phase === "initialization" ? "LINE 連線確認暫未完成，請稍後重試，或從手機 LINE 開啟原本的預約連結。"
        : "連線暫時未完成。請確認網路，並稍後重試。");
      setAction("error");
    } finally {
      inFlight.current = false;
    }
  }

  const ready = configState === "loaded" && config?.configured;
  return (
    <div className="connection-controls">
      <div className={`connection-status ${action === "verified" ? "status-success" : ""}`} role="status" aria-live="polite" aria-atomic="true">
        {configState === "loading" && <><span className="status-dot" /><span>正在確認連線狀態…</span></>}
        {configState === "error" && <><span className="status-dot dot-muted" /><span>暫時無法確認狀態，請重新整理。</span></>}
        {configState === "loaded" && !config?.configured && <><span className="status-dot dot-muted" /><span>LINE 連線設定中，暫未開放驗證。</span></>}
        {ready && action === "idle" && <><span className="status-dot" /><span>安全連線已就緒</span></>}
        {ready && action === "connecting" && <><span className="status-dot" /><span>正在與 LINE 確認登入身分…</span></>}
        {ready && action === "verified" && <><span className="success-check" aria-hidden="true">✓</span><span><strong>LINE 身分驗證完成</strong><br />正在開啟示範預約…</span></>}
        {ready && action === "error" && <><span className="status-dot dot-error" /><span>{error}</span></>}
      </div>
      {configState === "error" ? (
        <button className="primary-button button-secondary" onClick={() => { setConfigState("loading"); setAttempt((value) => value + 1); }}>重新確認連線狀態<span aria-hidden="true">↻</span></button>
      ) : recovery === "reopen" && config?.liffId ? (
        <a className="primary-button" href={`https://liff.line.me/${encodeURIComponent(config.liffId)}`} style={{ textDecoration: "none" }}>原本的 LINE 預約入口<span className="button-arrow" aria-hidden="true">↗</span></a>
      ) : (
        <button className="primary-button" onClick={connect} disabled={!ready || action === "connecting" || recovery === "configuration"}>
          <span>{action === "connecting" ? "確認中，請稍候…" : recovery === "configuration" ? "等待登入設定修復" : recovery === "fresh" ? "重新登入 LINE" : diagnostic === "SESSION_UNAVAILABLE" ? "重試開啟預約" : action === "verified" ? "重新驗證 LINE 身分" : action === "error" ? "重新連結 LINE" : "使用 LINE 繼續"}</span>
          {action !== "connecting" && <span className="button-arrow" aria-hidden="true">↗</span>}
        </button>
      )}
      <p className="button-caption">{recovery === "reopen" ? "請先關閉此 LINE 頁面，再重新開啟原本的預約連結。" : "點選後將進行 LINE 登入驗證。"}</p>
      {diagnostic && <p className="button-caption" style={{ overflowWrap: "anywhere" }}>錯誤代碼：{diagnostic}</p>}
    </div>
  );
}
