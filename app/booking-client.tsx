"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, ArrowUpRight, CalendarDays, Check, CheckCircle2, ChevronLeft, ChevronRight, Clock3, LogOut, MapPin, RefreshCw, ShieldCheck, Stethoscope, X } from "lucide-react";
import LineClient from "./line-client";
import { bookingBrand } from "../lib/booking-brand.mjs";

type Session = { authenticated: boolean; isAdmin: boolean; adminClinicIds: string[]; csrfToken?: string; notificationsConfigured?: boolean };
type Clinic = { id: string; name: string; timeZone: string; doctors: { id: string; name: string }[] };
type Slot = { id: string; clinicId: string; doctorId: string; startAt: string | number; endAt: string | number };
type Appointment = { id: string; clinicId: string; clinicName: string; doctorName: string; slotId: string; startAt: string | number; endAt: string | number; name: string; phone: string; status: "pending" | "confirmed" | "cancelled"; revision: number; notificationConsent: boolean; notificationStatus: string; createdAt: string | number };
type Dispatch = { sent: number; pending: number; failed: number; skipped: number; configured: boolean };
type View = "book" | "appointments";

class RequestError extends Error {
  constructor(message: string, public status: number, public code: string) { super(message); }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = window.setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(path, { cache: "no-store", credentials: "same-origin", ...options, signal: controller.signal });
    const result = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new RequestError(typeof result.message === "string" ? result.message : response.status === 401 ? "登入已逾時，請重新使用 LINE 登入。" : "暫時無法完成操作，請稍後重試。", response.status, typeof result.code === "string" ? result.code : "UNAVAILABLE");
    return result as T;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError("連線暫時未完成，請確認網路後重試。", 0, "NETWORK_ERROR");
  } finally { window.clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort); }
}

const dateKey = (value: Date = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
function shiftDate(value: string, amount: number) { const date = new Date(`${value}T12:00:00+08:00`); date.setUTCDate(date.getUTCDate() + amount); return dateKey(date); }
const timeLabel = (value: string | number) => new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
const dateLabel = (value: string | number) => new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", month: "long", day: "numeric", weekday: "short" }).format(new Date(value));
const statusLabel = (value: Appointment["status"]) => ({ pending: "等待診所確認", confirmed: "預約已確認", cancelled: "已取消" }[value]);
function notificationLabel(value: Appointment) {
  if (!value.notificationConsent) return "未訂閱 LINE 通知";
  return ({ pending: "LINE 通知待發送", sending: "LINE 通知處理中", sent: "LINE 已受理通知", failed: "LINE 通知未成功", skipped: "LINE 通知未發送" } as Record<string, string>)[value.notificationStatus] || "LINE 通知待處理";
}

function ToothArt() {
  return <svg className="tooth-art" viewBox="0 0 410 340" fill="none" aria-hidden="true"><circle cx="202" cy="165" r="128" fill="#E8EDDF" /><circle cx="202" cy="165" r="107" stroke="#D3DDC8" /><ellipse cx="207" cy="291" rx="111" ry="13" fill="#D6DFCC" /><path d="M149 76c28-22 44 0 62 0s33-22 61 0c44 37 5 131-12 152-7 9-18 6-21-5l-13-48c-3-10-14-13-18-3l-18 51c-5 14-17 14-25 3-20-25-61-116-16-150Z" fill="#FFFEF9" stroke="#4C6B50" strokeWidth="3" /><path d="M189 94c14 5 30 5 46-1" stroke="#CAD7BE" strokeWidth="5" strokeLinecap="round" /><path d="M94 281V178m-1 53c-30 0-42-20-40-44 26 1 41 19 40 44Zm2-25c30-2 41-23 35-47-28 5-39 26-35 47Z" stroke="#869C75" strokeWidth="2" fill="#BACBAA" /><path d="M317 79v25m-12-12h25M119 48v15m-7-7h15" stroke="#8CA477" strokeWidth="3" strokeLinecap="round" /><circle cx="302" cy="240" r="7" fill="#A1B58B" /><circle cx="81" cy="122" r="4" fill="#A1B58B" /></svg>;
}

export default function BookingClient({ mode = "patient" }: { mode?: "patient" | "admin" }) {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionError, setSessionError] = useState("");
  const [clinics, setClinics] = useState<Clinic[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [dataLoading, setDataLoading] = useState(false);
  const [view, setView] = useState<View>("book");
  const [clinicId, setClinicId] = useState("");
  const [doctorId, setDoctorId] = useState("");
  const [date, setDate] = useState(() => dateKey());
  const [week, setWeek] = useState(() => dateKey());
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotId, setSlotId] = useState("");
  const [slotLoading, setSlotLoading] = useState(false);
  const [slotError, setSlotError] = useState("");
  const name = "示範訪客";
  const phone = "0900000000";
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const [adminClinicId, setAdminClinicId] = useState("");
  const [filter, setFilter] = useState("all");
  const [cancelId, setCancelId] = useState("");
  const idempotency = useRef({ draft: "", key: "" });
  const clinic = clinics.find(item => item.id === clinicId);
  const doctor = clinic?.doctors.find(item => item.id === doctorId);
  const selectedSlot = slots.find(item => item.id === slotId);
  const admin = mode === "admin";
  const today = dateKey();

  const handleError = useCallback((caught: unknown) => {
    const message = caught instanceof Error ? caught.message : "暫時無法完成操作，請稍後重試。";
    setError(message);
    if (caught instanceof RequestError && caught.status === 401) {
      setSession({ authenticated: false, isAdmin: false, adminClinicIds: [] });
      setAppointments([]);
      setNotice("登入已逾時，重新登入後即可繼續。");
    }
  }, []);

  const loadSession = useCallback(async () => {
    setSessionError("");
    try {
      const result = await request<Session>("/api/booking/session");
      setAdminClinicId(current => result.adminClinicIds?.includes(current) ? current : result.adminClinicIds?.[0] || "");
      setSession(result);
      return result;
    } catch { setSessionError("暫時無法確認登入狀態，請重新載入。"); return null; }
  }, []);

  useEffect(() => { void loadSession(); }, [loadSession]);
  useEffect(() => {
    if (!session?.authenticated || (admin && (!session.isAdmin || !adminClinicId))) return;
    let active = true;
    setDataLoading(true);
    Promise.all([
      request<{ clinics: Clinic[] }>("/api/booking/catalogue"),
      request<{ appointments: Appointment[] }>(admin ? `/api/booking/admin?clinicId=${encodeURIComponent(adminClinicId)}` : "/api/booking/appointments"),
    ]).then(([catalogue, list]) => {
      if (!active) return;
      setClinics(catalogue.clinics);
      setAppointments(list.appointments);
      setClinicId(current => catalogue.clinics.some(item => item.id === current) ? current : catalogue.clinics[0]?.id || "");
    }).catch(caught => { if (active) handleError(caught); }).finally(() => { if (active) setDataLoading(false); });
    return () => { active = false; };
  }, [session?.authenticated, session?.isAdmin, admin, adminClinicId, revision, handleError]);

  useEffect(() => {
    setDoctorId(current => clinic?.doctors.some(item => item.id === current) ? current : clinic?.doctors[0]?.id || "");
    setSlotId("");
  }, [clinic]);

  useEffect(() => {
    if (!session?.authenticated || !clinicId || !doctorId || admin) return;
    let active = true;
    const controller = new AbortController();
    setSlots([]); setSlotId(""); setSlotLoading(true); setSlotError("");
    request<{ slots: Slot[] }>(`/api/booking/slots?clinicId=${encodeURIComponent(clinicId)}&doctorId=${encodeURIComponent(doctorId)}&date=${date}`, { signal: controller.signal })
      .then(result => { if (active) setSlots(result.slots); })
      .catch(caught => { if (active) { setSlotError(caught.message); if (caught.status === 401) handleError(caught); } })
      .finally(() => { if (active) setSlotLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [session?.authenticated, clinicId, doctorId, date, revision, admin, handleError]);

  async function mutate<T>(path: string, body: unknown, method = "POST") {
    if (!session?.csrfToken) throw new RequestError("登入狀態需要更新，請重新登入。", 401, "SESSION_EXPIRED");
    return request<T>(path, { method, headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken }, body: JSON.stringify(body) });
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedSlot || busy) return;
    setError(""); setNotice(""); setBusy("booking");
    const draft = JSON.stringify({ slotId, name: name.trim(), phone: phone.trim(), consent });
    if (idempotency.current.draft !== draft) idempotency.current = { draft, key: crypto.randomUUID() };
    try {
      await mutate("/api/booking/appointments", { slotId, name: name.trim(), phone: phone.trim(), consent, idempotencyKey: idempotency.current.key });
      setNotice("示範預約已送出，正在等待診所確認。您可以在這裡查看最新狀態。");
      setView("appointments"); setSlotId(""); setRevision(value => value + 1);
      idempotency.current = { draft: "", key: "" };
    } catch (caught) { handleError(caught); if (caught instanceof RequestError && caught.status === 409) setRevision(value => value + 1); }
    finally { setBusy(""); }
  }

  async function changeAppointment(item: Appointment, status: "confirmed" | "cancelled") {
    setBusy(item.id); setError(""); setNotice("");
    try {
      await mutate(`/api/booking/${admin ? "admin" : "appointments"}/${encodeURIComponent(item.id)}`, { ...(admin ? { clinicId: item.clinicId } : {}), status, expectedRevision: item.revision }, "PATCH");
      setNotice(status === "confirmed" ? "示範預約已確認。已同意的 LINE 通知將依設定處理。" : "這筆示範預約已取消，時段已重新開放。");
      setCancelId(""); setRevision(value => value + 1);
    } catch (caught) { handleError(caught); setRevision(value => value + 1); }
    finally { setBusy(""); }
  }

  async function adminAction(action: "seed" | "dispatch") {
    setBusy(action); setError(""); setNotice("");
    try {
      const result = await mutate<{ dispatch?: Dispatch }>("/api/booking/admin", { action });
      if (action === "seed") setNotice("示範診所、醫師與排班已建立，現在可以體驗預約流程。");
      else if (result.dispatch?.configured === false) setNotice("LINE 通知尚未啟用；預約紀錄已保存，設定完成後請再按一次「重試待發通知」。");
      else setNotice(`通知處理完成：LINE 已受理 ${result.dispatch?.sent || 0} 筆，待處理 ${result.dispatch?.pending || 0} 筆，未成功 ${result.dispatch?.failed || 0} 筆。`);
      setRevision(value => value + 1);
    } catch (caught) { handleError(caught); }
    finally { setBusy(""); }
  }

  async function logout() {
    setBusy("logout"); setError("");
    try { await mutate("/api/booking/logout", {}); setSession({ authenticated: false, isAdmin: false, adminClinicIds: [] }); setAppointments([]); setNotice(""); }
    catch (caught) { handleError(caught); }
    finally { setBusy(""); }
  }

  const shownAppointments = appointments.filter(item => filter === "all" || item.status === filter).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const count = (status: string) => appointments.filter(item => item.status === status).length;

  return <div className="site-shell">
    <header className="site-header">
      <a className="brand" href="/" aria-label="齒間首頁"><span className="brand-mark" aria-hidden="true">齒</span><span>齒間<span className="brand-caption">留一點時間，照顧自己。</span></span></a>
      <div className="header-actions">
        {session?.authenticated && <nav className="header-nav" aria-label="主要導覽"><a className={!admin ? "active" : ""} href="/">線上預約</a>{session.isAdmin && <a className={admin ? "active" : ""} href="/admin">診所工作台</a>}</nav>}
        <span className="test-label"><span />示範預約</span>
        {session?.authenticated && <button className="icon-button" aria-label="登出" title="登出" onClick={logout} disabled={!!busy}><LogOut size={17} /></button>}
      </div>
    </header>
    {session === null ? <main className="session-screen"><div className="loading-leaf" aria-hidden="true">齒</div><h1>為你留一段安心的時間</h1><p role="status">{sessionError || "正在確認登入狀態…"}</p>{sessionError && <button className="secondary-button" onClick={() => void loadSession()}>重新載入<RefreshCw size={15} /></button>}</main> : !session.authenticated ? <main className="home-main">
      <section className="intro" aria-labelledby="intro-title"><p className="eyebrow">A LITTLE TIME, A BETTER SMILE</p><h1 id="intro-title">把時間留給<br /><span>好好照顧自己。</span></h1><p className="intro-copy">選一間診所、找到合適的時間。<br />從熟悉的 LINE 開始，讓預約簡單一點。</p><ToothArt /><div className="intro-caption"><span />少一點等待，多一點從容。</div></section>
      <section className="connection-card" aria-labelledby="connection-title"><div className="card-topline"><span className="step-number">01</span><span>從這裡開始</span></div><h2 id="connection-title">你好，歡迎來到齒間</h2><p className="card-description">公開產品展示，不是真實掛號。登入後可體驗選時段與送出示範預約，確認仍需由管理員操作。</p><div className="account-row"><span className="account-avatar" aria-hidden="true">L</span><div><p className="account-name">{bookingBrand.lineAccountName}<span>LINE 官方帳號</span></p>{bookingBrand.lineAccountId && <p className="account-id">{bookingBrand.lineAccountId}</p>}</div><ShieldCheck size={19} className="soft-icon" /></div>{notice && <p className="inline-notice" role="status">{notice}</p>}<LineClient onVerified={async () => { const result = await loadSession(); if (!result?.authenticated) throw new Error("SESSION_UNAVAILABLE"); setError(""); setNotice(""); }} /><div className="test-note"><ShieldCheck size={20} /><p>診所與排班均為示範資料，姓名與電話已固定。<br />每個 LINE 帳號任一連續 24 小時內最多 3 筆；取消不重置額度。</p></div><p className="privacy-link">繼續前，請閱讀<a href="/privacy">示範資料說明</a>。</p></section>
      <div className="journey-strip"><span><b>01</b> LINE 安心登入</span><span><b>02</b> 選擇喜歡的時段</span><span><b>03</b> 等待診所確認</span></div>
    </main> : admin && !session.isAdmin ? <main className="session-screen"><ShieldCheck size={40} /><h1>這裡是診所的工作空間</h1><p>目前登入的 LINE 帳號沒有診所管理權限。</p><a className="secondary-button" href="/">回到我的預約<ArrowRight size={16} /></a></main> : <main className="booking-main">
      <section className="page-heading"><div><p className="eyebrow">{admin ? "THE CLINIC DESK" : "A MOMENT FOR YOUR SMILE"}</p><h1>{admin ? "把每一份預約，安心接好。" : "下一次照顧，從這裡開始。"}</h1><p>{admin ? "查看示範排程，確認每一位訪客的預約。" : "找到適合你的診所與時間，其餘的，交給齒間。"}</p></div><div className="verified-pill"><CheckCircle2 size={16} />LINE 身分已驗證</div></section>
      <div className="demo-banner"><ShieldCheck size={18} /><p><strong>公開產品展示，不是真實掛號。</strong>診所、醫師與排班均為示範資料；操作會保存，預約確認仍需管理員處理。</p></div>
      {notice && <div className="notice-box" role="status"><CheckCircle2 size={19} /><span>{notice}</span><button aria-label="關閉提示" onClick={() => setNotice("")}><X size={17} /></button></div>}
      {error && <div className="error-box" role="alert"><span>{error}</span><button aria-label="關閉錯誤提示" onClick={() => setError("")}><X size={17} /></button></div>}
      {admin ? <>
        <section className="stat-grid" aria-label="預約摘要"><div><span>全部預約</span><strong>{appointments.length.toString().padStart(2, "0")}</strong><CalendarDays size={21} /></div><div className="stat-pending"><span>等待確認</span><strong>{count("pending").toString().padStart(2, "0")}</strong><Clock3 size={21} /></div><div><span>已確認</span><strong>{count("confirmed").toString().padStart(2, "0")}</strong><CheckCircle2 size={21} /></div><div><span>已取消</span><strong>{count("cancelled").toString().padStart(2, "0")}</strong><X size={21} /></div></section>
        <div className="admin-toolbar"><label className="select-label">診所<select value={adminClinicId} onChange={event => setAdminClinicId(event.target.value)}>{clinics.filter(item => session.adminClinicIds.includes(item.id)).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><div className="toolbar-actions"><button className="secondary-button compact" disabled={!!busy} onClick={() => adminAction("dispatch")}><RefreshCw size={15} />{busy === "dispatch" ? "處理中…" : "重試待發通知"}</button><button className="icon-button" aria-label="重新整理預約" onClick={() => { setError(""); setRevision(value => value + 1); }} disabled={dataLoading || !!busy}><RefreshCw size={18} className={dataLoading ? "spinning" : ""} /></button></div></div>
        {!dataLoading && clinics.length === 0 && <div className="empty-card"><CalendarDays size={32} /><h2>準備第一份示範排班</h2><p>建立示範診所、醫師與可預約時段後，就能開始操作。</p><button className="secondary-button" disabled={!!busy} onClick={() => adminAction("seed")}>{busy === "seed" ? "建立中…" : "建立示範診所與排班"}<ArrowRight size={16} /></button></div>}
      </> : <div className="view-tabs" role="tablist" aria-label="預約功能"><button role="tab" aria-selected={view === "book"} className={view === "book" ? "selected" : ""} onClick={() => { setView("book"); setCancelId(""); }}><CalendarDays size={17} />開始預約</button><button role="tab" aria-selected={view === "appointments"} className={view === "appointments" ? "selected" : ""} onClick={() => { setView("appointments"); setRevision(value => value + 1); }}><Clock3 size={17} />我的預約<span className="tab-count">{appointments.length}</span></button></div>}
      {!admin && view === "book" ? <div className="booking-layout"><div className="selection-stack">
        <section className="panel"><div className="section-heading"><span className="section-number">01</span><div><h2>選擇你的診所</h2><p>為這次照顧，找一個喜歡的地方。</p></div></div>{dataLoading && !clinics.length ? <p className="loading-text" role="status">正在載入診所…</p> : clinics.length === 0 ? <div className="small-empty"><p>示範排班尚未準備好。</p>{session.isAdmin ? <a href="/admin">前往診所工作台建立排班 <ArrowUpRight size={14} /></a> : <p>請稍後再來；如有問題，可聯絡 LINE 官方帳號「{bookingBrand.lineAccountName}」{bookingBrand.lineAccountId && `（${bookingBrand.lineAccountId}）`}。</p>}</div> : <div className="clinic-grid">{clinics.map((item, index) => <button key={item.id} className={`clinic-option ${item.id === clinicId ? "chosen" : ""}`} onClick={() => { setClinicId(item.id); setSlotId(""); }} aria-pressed={item.id === clinicId}><span className={`clinic-illustration clinic-tone-${index % 3}`} aria-hidden="true"><svg viewBox="0 0 180 80" fill="none"><path d="M37 72V26h105v46" stroke="currentColor" strokeWidth="1.6" /><path d="M32 26h115l-11-14H43L32 26Z" fill="currentColor" opacity=".13" /><path d="M32 26h115l-11-14H43L32 26Z" stroke="currentColor" strokeWidth="1.6" /><path d="M49 37h32v25H49zM96 37h26v35H96z" stroke="currentColor" strokeWidth="1.5" /><path d="M65 37v25M49 49h32M21 72h141" stroke="currentColor" strokeWidth="1.5" /><circle cx="115" cy="55" r="1.5" fill="currentColor" /><path d="M18 72V46m0 17c-14 0-13-13-13-13 13-1 13 13 13 13Zm1-10c14-1 13-13 13-13-13-1-13 13-13 13Z" stroke="currentColor" strokeWidth="1.2" /></svg></span><span className="clinic-option-body"><span className="clinic-name">{item.name}</span><span className="clinic-meta"><MapPin size={12} />示範診所 · 台灣</span></span><span className="radio-check" aria-hidden="true">{item.id === clinicId && <Check size={12} />}</span></button>)}</div>}</section>
        <section className="panel"><div className="section-heading"><span className="section-number">02</span><div><h2>找到合適的醫師</h2><p>每一位醫師，都值得好好認識。</p></div></div><div className="doctor-list">{clinic?.doctors.map((item, index) => <button key={item.id} className={`doctor-option ${item.id === doctorId ? "chosen" : ""}`} aria-pressed={item.id === doctorId} onClick={() => setDoctorId(item.id)}><span className={`doctor-avatar avatar-${index % 3}`} aria-hidden="true"><Stethoscope size={22} /></span><span><strong>{item.name}</strong><small>示範醫師 · 一般預約</small></span><span className="radio-check" aria-hidden="true">{item.id === doctorId && <Check size={12} />}</span></button>) || <p className="loading-text">請先選擇診所。</p>}</div></section>
        <section className="panel"><div className="section-heading"><span className="section-number">03</span><div><h2>挑一段剛好的時間</h2><p>所有時段均以台灣時間顯示。</p></div></div><div className="date-toolbar"><label className="date-picker"><CalendarDays size={16} /><input aria-label="預約日期" type="date" min={today} value={date} onChange={event => { if (event.target.value) { setDate(event.target.value); setWeek(event.target.value); } }} /></label><div className="week-navigation"><button className="icon-button" aria-label="前七天" disabled={week <= today} onClick={() => { const previous = shiftDate(week, -7); setWeek(previous < today ? today : previous); }}><ChevronLeft size={18} /></button><button className="icon-button" aria-label="後七天" onClick={() => setWeek(shiftDate(week, 7))}><ChevronRight size={18} /></button></div></div><div className="date-strip">{Array.from({ length: 7 }, (_, index) => { const value = shiftDate(week, index); const day = new Date(`${value}T12:00:00+08:00`); return <button key={value} className={date === value ? "chosen" : ""} onClick={() => setDate(value)} aria-pressed={date === value}><span>{value === today ? "今天" : new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", weekday: "short" }).format(day)}</span><strong>{day.getUTCDate()}</strong><i /></button>; })}</div><div className="slot-header"><h3>{dateLabel(`${date}T12:00:00+08:00`)}<span>可預約時段</span></h3><span className="availability-dot">即時空位</span></div>{slotLoading ? <p className="loading-text" role="status">正在確認可預約時段…</p> : slotError ? <div className="small-empty" role="alert"><p>{slotError}</p><button className="text-button" onClick={() => setRevision(value => value + 1)}>重新載入</button></div> : slots.length ? <div className="slot-grid">{slots.map(item => <button key={item.id} className={slotId === item.id ? "chosen" : ""} onClick={() => setSlotId(item.id)} aria-pressed={slotId === item.id}>{timeLabel(item.startAt)}<small>{Math.round((new Date(item.endAt).getTime() - new Date(item.startAt).getTime()) / 60000)} 分鐘</small></button>)}</div> : <div className="small-empty"><Clock3 size={23} /><p>{doctorId ? "這一天目前沒有可預約時段。" : "選擇診所與醫師後，即可查看時段。"}</p>{doctorId && <button className="text-button" onClick={() => { const next = shiftDate(date, 1); setDate(next); if (next > shiftDate(week, 6)) setWeek(next); }}>看看下一天 <ArrowRight size={14} /></button>}</div>}</section>
      </div><aside className="reservation-aside"><form className="summary-card" onSubmit={submit}><p className="eyebrow">YOUR APPOINTMENT</p><h2>為自己，留一個約定</h2><div className="summary-details"><div><MapPin size={17} /><span>{clinic?.name || "尚未選擇診所"}</span></div><div><Stethoscope size={17} /><span>{doctor?.name || "尚未選擇醫師"}</span></div><div><CalendarDays size={17} /><span>{selectedSlot ? dateLabel(selectedSlot.startAt) : "尚未選擇時段"}</span></div>{selectedSlot && <div><Clock3 size={17} /><span>{timeLabel(selectedSlot.startAt)} – {timeLabel(selectedSlot.endAt)}<small>台灣時間</small></span></div>}</div><div className="demo-form-note">姓名與電話固定使用示範資料，不收集真實聯絡資料。</div><label className="field-label" htmlFor="booking-name">預約姓名<input id="booking-name" value={name} readOnly aria-readonly="true" maxLength={60} autoComplete="off" placeholder="示範訪客" /></label><label className="field-label" htmlFor="booking-phone">手機號碼<input id="booking-phone" type="tel" inputMode="tel" value={phone} readOnly aria-readonly="true" autoComplete="off" placeholder="0900000000" /><span className="field-help">固定示範號碼，無需填入個人電話</span></label><label className="consent-label"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} /><span>我同意接收這次示範預約的 LINE 狀態通知。<small>{session.notificationsConfigured === false ? "通知尚未啟用；同意後保留待發送，設定完成後由管理員處理。" : "選填。請先加入本服務的 LINE 官方帳號；暫時發送失敗時，由管理員重試。"}</small><small>通知受每日展示額度限制，請以站內狀態為準。</small></span></label><button className="primary-button" type="submit" disabled={!selectedSlot || !!busy}><span>{busy === "booking" ? "正在送出預約…" : "送出示範預約"}</span><ArrowRight size={18} /></button><p className="summary-footnote">送出後需由管理員確認，不會自動確認。<br />每個 LINE 帳號任一連續 24 小時內最多 3 筆，取消不重置額度。<br />公開產品展示，不是真實掛號。</p></form><p className="aside-note"><ShieldCheck size={15} />資料經安全連線傳送<br /><a href="/privacy">了解示範資料如何使用</a></p></aside></div> : <section className="appointments-panel"><div className="list-heading"><div><h2>{admin ? "預約工作清單" : "我的預約"}</h2><p>{admin ? "每一筆狀態變更都會保存，僅對已同意者安排通知。" : "從送出到確認，進度都在這裡。"}</p></div>{!admin && <button className="secondary-button compact" disabled={dataLoading || !!busy} onClick={() => { setError(""); setRevision(value => value + 1); }}><RefreshCw size={15} className={dataLoading ? "spinning" : ""} />更新狀態</button>}</div><div className="filter-tabs" aria-label="依預約狀態篩選">{[{ key: "all", label: "全部", count: appointments.length }, { key: "pending", label: "待確認", count: count("pending") }, { key: "confirmed", label: "已確認", count: count("confirmed") }, { key: "cancelled", label: "已取消", count: count("cancelled") }].map(item => <button key={item.key} className={filter === item.key ? "selected" : ""} aria-pressed={filter === item.key} onClick={() => setFilter(item.key)}>{item.label}<span>{item.count}</span></button>)}</div>{dataLoading ? <p className="loading-text" role="status">正在更新預約紀錄…</p> : shownAppointments.length === 0 ? <div className="empty-card"><CalendarDays size={34} /><h3>{appointments.length ? "這裡還沒有符合的預約" : "日曆，正等著一個新的約定"}</h3><p>{admin ? "收到示範預約後，就會顯示在這裡。" : "選一段適合自己的時間，開始第一次示範預約。"}</p>{!admin && <button className="secondary-button" onClick={() => setView("book")}>開始預約<ArrowRight size={16} /></button>}</div> : <div className="appointment-list">{shownAppointments.map(item => <article className={`appointment-card ${item.status === "cancelled" ? "appointment-muted" : ""}`} key={item.id}><div className="appointment-date"><span>{new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", month: "short" }).format(new Date(item.startAt))}</span><strong>{new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", day: "numeric" }).format(new Date(item.startAt)).replace("日", "")}</strong><small>{timeLabel(item.startAt)}</small></div><div className="appointment-content"><div className="appointment-top"><h3>{item.clinicName}</h3><span className={`status-badge badge-${item.status}`}>{statusLabel(item.status)}</span></div><p className="appointment-doctor">{item.doctorName}<span>·</span>{dateLabel(item.startAt)}<span>·</span>{timeLabel(item.startAt)} – {timeLabel(item.endAt)}</p><div className="appointment-bottom"><span>{item.name}<span className="contact-divider">/</span>{item.phone}</span><span className="notification-label">{notificationLabel(item)}</span></div>{cancelId === item.id ? <div className="cancel-confirm"><p>確定取消這筆示範預約？時段將重新開放。</p><div><button className="text-button" disabled={!!busy} onClick={() => setCancelId("")}>保留預約</button><button className="danger-button" disabled={!!busy} onClick={() => changeAppointment(item, "cancelled")}>{busy === item.id ? "取消中…" : "確定取消"}</button></div></div> : item.status !== "cancelled" && <div className="appointment-actions">{admin && item.status === "pending" && <button className="confirm-button" disabled={!!busy} onClick={() => changeAppointment(item, "confirmed")}><Check size={15} />{busy === item.id ? "儲存中…" : "確認預約"}</button>}<button className="text-button muted" disabled={!!busy} onClick={() => setCancelId(item.id)}>取消預約</button></div>}</div></article>)}</div>}<p className="list-footnote">顯示時間皆為台灣時間。LINE 已受理表示通知請求已接受，並不代表訊息已送達或已讀。</p></section>}
    </main>}
    <footer className="site-footer"><span>齒間 · 把時間留給好好照顧</span><a href="/privacy">示範資料說明<ArrowUpRight size={12} /></a></footer>
  </div>;
}
