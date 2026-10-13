# LINE 與環境設定

請使用自己擁有管理權限的測試帳號及獨立資料庫。以下設定服務於本版本的示範流程，不會建立多租戶開通機制。

## 1. 建立自己的 LINE 配置

1. 準備 LINE 官方帳號，啟用 Messaging API，並建立 LINE Login channel。
2. 將兩個 channels 放在**同一個 Provider**。同一人的 LINE user ID 依 Provider 區分；跨 Provider 的識別值不能直接互換。[官方 user ID 說明](https://developers.line.biz/en/docs/messaging-api/getting-user-ids/)
3. 在 LINE Login channel 新增 LIFF，尺寸可用 `Full`，Endpoint URL 指向自己的 HTTPS 網站根目錄，例如 `https://booking.example.com/`。
4. 此版本只需要 `openid` scope 取得 ID token，不要求 email 或 profile。記錄 LIFF ID 與 LINE Login Channel ID；它們屬於不同設定，不可混用。[官方 LIFF 設定](https://developers.line.biz/en/docs/liff/registering-liff-apps/)
5. 設定要使用的官方帳號連結及登入測試人員。正式公開 Login channel 前，應先用自己的測試身分完成驗收；發布方式與可用狀態以 LINE Developers 畫面及官方文件為準。

本系統透過 LIFF SDK 處理登入導向，再將原始 ID token 交給伺服器向 LINE 驗證。它沒有另行實作自訂 OAuth callback route；不要把 `/api/line/verify` 當成瀏覽器授權 callback。

## 2. 設定伺服器環境

依 `.dev.vars.example` 建立忽略的本機 `.dev.vars`；部署時在平台的受保護設定填入自己的值。以下值均由 Worker runtime 讀取，不應使用 `NEXT_PUBLIC_`、`VITE_` 等方式把秘密打包至瀏覽器。

| 名稱 | 用途／格式 | 處理方式 |
| --- | --- | --- |
| `PUBLIC_ORIGIN` | HTTPS origin，例如 `https://booking.example.com`；不含路徑或結尾斜線 | 與實際入口一致；寫入 API 比對 `Origin` |
| `LINE_PROVIDER_ID` | Login 與 Messaging 共用的數字 Provider ID | 建立身分與 webhook 綁定界線 |
| `LINE_LOGIN_CHANNEL_ID` | **LINE Login** 的數字 Channel ID | 驗證 ID token 的 audience；不要填 Messaging Channel ID |
| `LINE_LIFF_ID` | 自己的 LIFF ID | 前端公開配置僅取得此 ID 等非秘密資訊 |
| `BOOKING_SECURITY_KEY` | 至少 43 字元的高熵秘密 | 用於 session、識別代碼與 LINE ID 加密；需穩定保存 |
| `BOOKING_ADMIN_LINE_ID` | 管理員在同一 Provider 下的 `U` 加 32 個十六進位字元的 user ID | 限伺服器保管；決定兩間示範診所的管理員 |
| `LINE_CHANNEL_ACCESS_TOKEN` | Messaging API channel access token | 通知發送憑證；未設時不發送 LINE 通知 |
| `LINE_CONNECTION_KEY` | 自訂 webhook 路徑 key，只含英數、`-`、`_` | 例如 `demo-booking`；不是 Channel Secret |
| `LINE_CHANNEL_SECRET` | **Messaging API** channel secret | 原始 webhook 內容驗章 |
| `LINE_INBOX_HASH_SECRET` | 至少 32 字元的獨立高熵秘密 | 將 webhook 來源識別值代碼化；不得與 Channel Secret 共用 |
| `LINE_WEBHOOK_ENABLED` | 字串 `true` 才會啟用 webhook | 未啟用時 webhook route 拒絕接收 |
| `DB` | Cloudflare D1 binding | 不是環境檔中的字串；由部署平台配置 |

可在受控終端分別執行以下命令產生兩組獨立秘密。不要把輸出貼入 Issue、commit 或截圖；直接保存至自己的秘密管理工具。

```sh
node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url'))"
```

**不要任意替換既有部署的 `BOOKING_SECURITY_KEY` 或 Provider。** 既存資料中的患者識別代碼與加密通知收件者依賴這些設定；變更需要另行設計遷移與金鑰輪替程序，本版本沒有自動處理。

官方帳號的名稱與公開 ID 放在 `lib/booking-brand.mjs`。這些資料會出現在瀏覽器，與伺服器秘密分開設定；修改顯示資料不會自動建立或切換 LINE channel。

## 3. 安全設定第一位管理員

`BOOKING_ADMIN_LINE_ID` 不是官方帳號的 `@` 帳號、電話、顯示名稱、LIFF ID 或 Channel ID。

若管理員就是開發者本人，可在**同一 Provider** 下的 LINE channel「Basic settings → Your user ID」取得自己的值；LINE Business ID 必須先連結自己的 LINE 帳號。將該值直接放入伺服器受保護設定，不要發到公開 Issue。[官方取得方式](https://developers.line.biz/en/docs/messaging-api/getting-user-ids/)

若需要指定另一人，必須先以受信任的程序核實其同 Provider 身分，例如已完成 LINE 官方驗證的 ID token `sub`，再由部署管理者設定。不要直接信任瀏覽器解碼出的 token、網址參數、使用者自行填寫的 ID 或未驗章 webhook。此版本刻意沒有公開的「設成管理員」API，也沒有員工邀請流程。

管理員以 LINE 成功登入後，伺服器會建立兩間示範診所、四位醫師及未來 14 天時段。一般登入者不會觸發初始化，也不能操作管理員 API。若資料庫是空的，先完成一次管理員登入再測試一般使用者。

## 4. 啟用 webhook

部署資料庫遷移及上述設定後，在 Messaging API channel 將 webhook URL 設為：

```text
https://booking.example.com/api/line/webhook/demo-booking
```

末段需與 `LINE_CONNECTION_KEY` 完全一致。啟用 webhook 並執行 LINE 的 Verify。第一次正確驗章且 `events` 為空的 Verify 請求，會將帳號的 destination 綁定到 D1；後續收到的 destination 必須一致。一般事件不能自行建立或改寫綁定。更換官方帳號／Provider 時應建立新的連線配置與遷移計畫，勿覆蓋現有綁定。

收件表只保留事件識別、類型、時間與經代碼化的來源，不保存訊息內文或 reply token；webhook 不會自動回覆或觸發預約。預約通知由預約 API 的交易成功後派送。

## 5. 驗收登入及通知

1. 用指定管理員登入，確認工作台與示範時段可用。
2. 使用獨立的一般使用者測試只能查看自己的預約，且無法使用管理員 API。
3. 一般瀏覽器與 LINE 內的 LIFF 入口各測試一次登入。過期憑證在一般瀏覽器可按「重新登入 LINE」；LINE 內依畫面提示關閉並重新開啟入口。
4. 確認願意收測試訊息的人已符合官方帳號發送條件，再勾選通知、建立申請、管理員確認、本人取消。各步檢查網站狀態與手機收件。
5. `sent` 僅表示 LINE 已受理；請區分平台接受、手機送達及使用者已讀。未勾選通知仍應能正常預約。

LINE 的發送資格、帳號方案與可用額度由 LINE 控制；本專案的每日 30 次上限只是額外的展示保護。請依 [官方 Messaging API 文件](https://developers.line.biz/en/docs/messaging-api/sending-messages/)確認自己的帳號條件。
