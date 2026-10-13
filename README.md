# 齒間｜LINE 牙醫預約展示

使用 LINE 登入、選擇診所與時段、送出預約，再由診所管理員確認的完整示範流程。介面使用繁體中文，排班與通知時間以台灣時區 `Asia/Taipei` 顯示。

**這是可自行部署的產品展示原始碼，尚非可直接承接真實病患的診所系統。** 診所、醫師、排班及聯絡資料均為示範資料；登入識別與預約紀錄則會實際保存於部署者的資料庫。

**English overview:** An MIT-licensed dental appointment demo with LINE LIFF sign-in, durable booking storage, an administrator workbench, and opt-in LINE status notifications. Built with React, TypeScript, Vinext and Cloudflare D1. It demonstrates a two-clinic workflow; self-service multi-tenant onboarding, production clinic operations and ERP integration are not implemented.

## 已實作

- LINE LIFF 登入，伺服器驗證 ID token；一般瀏覽器遇到過期憑證時，可明確操作重新登入。
- 兩間示範診所、四位示範醫師，以及管理員登入後建立／延伸的 14 天示範排班。
- 選診所、醫師、日期、時段，送出申請，查看自己的預約並取消。
- 管理員工作台：查看可管理診所的預約、確認或取消，以及手動重試待發通知。
- D1 持久化、同時段重複預約防護、重複請求防護、狀態版本檢查與操作紀錄。
- 預設不勾選的 LINE 通知選項；申請、確認、取消通知透過持久化 outbox 處理。
- LINE webhook 驗章、官方帳號 destination 綁定及事件去重。收件表不保存訊息內文或 reply token。

## 示範限制

| 項目 | 目前行為 |
| --- | --- |
| 姓名與手機 | 伺服器固定保存「示範訪客」與 `0900000000`，不接受自訂真實聯絡資料 |
| 預約數量 | 同帳號最多 3 筆待處理／已確認預約；任一連續 24 小時最多新建 3 筆，取消不退還額度 |
| LINE 通知 | 全部署每日最多 30 次發送嘗試，以台灣日期計算，包含重試；超出額度的通知不補發 |
| 通知狀態 | `sent` 代表 LINE 接受請求，不代表手機送達或已讀 |
| 排班維護 | 管理員登入延伸示範排班；未提供真實休診、假日、診療項目、椅位或人力排班編輯 |
| 管理權限 | 一個部署設定的 LINE 管理員可管理兩間固定示範診所；尚無租戶開通、員工邀請或角色管理 |
| 訊息重試 | 無背景排程；管理員需在工作台手動重試暫時失敗的待發通知 |
| ERP | 尚無 ERP 連線、同步排班、病患或帳務接口 |

不包含支付、正式簡訊、就診前提醒、病歷、醫療建議、SLA、營運者正式隱私政策或資料保留／刪除自動化。這些項目需要在商用版本中另行實作與驗證，不能僅更換名稱後視為完成上線。

## 本機開始

需要 Node.js **22.13.0 以上**與 npm。乾淨 checkout 預設使用 portable 執行模式，支援 Windows、macOS 與 Linux；以下測試不需要真實 LINE 憑證。

```sh
git clone https://github.com/annawang12282007/dental-line-booking.git
cd dental-line-booking
npm ci
npm test
npm run typecheck
npm run build
npm run dev
```

開啟開發伺服器印出的網址，預設為 `http://localhost:5173`。尚未配置時仍可啟動程式與執行自動化測試；完整入口需要必要的 booking secret、Provider 與 D1 設定，否則可能顯示設定中或無法確認登入狀態的提示。真實 LINE 登入及預約寫入另需完成下列 LINE 配置。開發工具中的通用本機登入功能不授予本系統的診所管理權限。

完整登入需要屬於您自己的 LINE Provider、LINE Login／Messaging API channels、LIFF，以及可公開存取的 HTTPS 入口。請依序閱讀：

1. [LINE 與環境設定](docs/LINE_SETUP.md)
2. [資料庫、本機預覽與部署](docs/DEPLOYMENT.md)
3. [架構與資料界線](docs/ARCHITECTURE.md)

依 `.dev.vars.example` 建立忽略的本機 `.dev.vars`，或在部署平台設定受保護環境。範本只含占位資料；不要把正式憑證改成公開前端變數，也不要把本機資料庫放進版本庫。官方帳號顯示資料可在 `lib/booking-brand.mjs` 設定；其中內容會公開，不可放入秘密。

## 專案位置

| 路徑 | 內容 |
| --- | --- |
| `app/` | 預約入口、LINE 登入、診所工作台、資料說明與 HTTP routes |
| `server/booking-*.mjs` | 驗證、預約交易、權限與通知派送 |
| `server/line*.mjs` | LINE token 驗證、push、webhook 與收件儲存 |
| `db/schema.ts`、`drizzle/` | D1 schema 與已提交的遷移檔 |
| `tests/` | 純函式及本機 Worker／資料庫整合測試 |
| `lib/booking-brand.mjs` | 官方帳號的公開顯示資料 |
| `build/`、`scripts/` | Sites／Cloudflare 建置與本機執行工具 |

自動化測試使用示範資料與受控的 LINE 回應，不證明您自己的 LINE channel、訊息額度、DNS 或正式資料庫已設定成功。部署後仍應使用自己的測試帳號驗收登入、預約、管理權限與通知。

開源副本初次發布驗證（2026-10-13）：乾淨 `npm ci`、125 項測試、TypeScript 檢查及 production build 通過。此紀錄針對本次發布，不代表後續修改版本已自動通過相同檢查。

## 授權與協作

專案採用 [MIT License](LICENSE)，允許修改、商業使用及再散布；請保留授權聲明。套件與內附第三方程式碼仍適用各自的授權，請見 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。LINE 名稱、服務及商標不隨本專案授權移轉。

提交修改請閱讀 [CONTRIBUTING.md](CONTRIBUTING.md)；敏感問題請閱讀 [SECURITY.md](SECURITY.md)。此版本庫不提供作者的 LINE 憑證、原部署資料庫、私人網站內容或公司 ERP 原始碼。
