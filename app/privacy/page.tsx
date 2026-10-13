import type { Metadata } from "next";
import { bookingBrand } from "../../lib/booking-brand.mjs";

export const metadata: Metadata = { title: "示範資料說明｜齒間" };

export default function Privacy() {
  return <div className="site-shell">
    <header className="site-header"><a className="brand" href="/" aria-label="齒間首頁"><span className="brand-mark" aria-hidden="true">齒</span><span>齒間<span className="brand-caption">留一點時間，照顧自己。</span></span></a><span className="test-label"><span />示範預約</span></header>
    <main className="privacy-main"><a className="back-link" href="/">← 回到示範預約</a><p className="eyebrow">YOUR INFORMATION, WITH CARE</p><h1>示範資料說明</h1><p className="privacy-lead">齒間目前提供公開產品展示，不是真實掛號。診所、醫師與排班均為示範資料；送出預約會保存紀錄，確認仍需由管理員操作，不會安排實際看診，也不提供醫療諮詢。每個 LINE 帳號任一連續 24 小時內最多建立 3 筆示範預約，取消不會重置額度。</p>
      <section className="privacy-section"><h2>由你決定是否登入</h2><p>點選「使用 LINE 繼續」後，才會載入 LINE 登入功能，並依 LINE 畫面完成授權；你可以選擇取消。完成授權返回後，頁面會自動續接驗證。</p><p>目前僅申請確認登入身分所需的權限，不要求讀取 LINE 個人檔案。登入成功後，伺服器會建立有時效的登入狀態，讓你查看與操作自己的預約。你可以隨時使用頁首的登出按鈕結束本網站的登入。</p><p>LINE 服務本身的資料處理，請參閱 <a href="https://terms.line.me/line_rules/" target="_blank" rel="noreferrer">LINE 服務條款</a>與其相關隱私說明。</p></section>
      <section className="privacy-section"><h2>示範流程會保存什麼</h2><ul><li>預約的示範姓名、電話、診所、醫師、時段、狀態、通知選擇與更新時間，會保存於伺服器，重新登入後仍可查看。</li><li>登入時會短暫處理 LINE 登入憑證；用於辨識預約擁有者的識別資料會經代碼化，用於通知的 LINE 識別資訊則經加密保存。</li><li>為避免重複預約、追蹤操作及確認通知處理狀態，會保存必要的操作與事件紀錄。</li><li>聯絡姓名固定為「示範訪客」，電話固定為「0900000000」，不可修改；本展示不收集真實姓名與電話。請勿提供真實病患資料、身分證字號、病歷或健康資訊，也不要透過本服務的 LINE 官方帳號傳送就診內容。</li></ul><p>登入者只能查看自己的預約；經授權的診所管理人員可查看及確認其可管理診所的示範預約。</p></section>
      <section className="privacy-section"><h2>LINE 通知是你的選擇</h2><p>預約表單的通知選項預設不勾選。不勾選仍可完成預約並在網站查看狀態；勾選代表同意接收該次示範預約的狀態通知。</p><p>通知需在功能啟用且符合 LINE 發送條件時才能處理，請先加入 LINE 官方帳號「{bookingBrand.lineAccountName}」{bookingBrand.lineAccountId && `（${bookingBrand.lineAccountId}）`}。網站標示「LINE 已受理通知」，僅代表 LINE 已接受發送請求，不代表訊息已送達或已讀。請以網站的最新預約狀態為準。</p><p>全站每日以台灣時間計算，最多進行 30 次 LINE 通知發送嘗試。超出展示額度的該筆通知會標示「LINE 通知未發送」，不會補發；這不影響站內預約，請以網站的最新狀態為準。</p><p>這個示範版本尚未安排背景重試。遇到暫時發送失敗時，需要管理人員使用工作台的「重試待發通知」處理；永久失敗的通知會標示未成功，不會持續重複發送。</p></section>
      <section className="privacy-section"><h2>目前服務範圍與資料問題</h2><p>取消示範預約會更新預約狀態並釋出時段，不等於刪除所有紀錄。如有資料處理、刪除需求或其他展示相關問題，請聯絡 LINE 官方帳號「{bookingBrand.lineAccountName}」{bookingBrand.lineAccountId && `（${bookingBrand.lineAccountId}）`}；聯絡時請勿傳送病歷或健康資訊。</p><p>正式服務的營運者、聯絡方式、資料保存期限與權利申請方式，將於對外提供實際預約服務前另行公布。本版本請僅使用示範資料。</p></section>
    </main><footer className="site-footer"><span>齒間 · 把時間留給好好照顧</span><a href="/">回到示範預約</a></footer>
  </div>;
}
