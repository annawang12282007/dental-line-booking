# 架構與資料界線

```text
一般瀏覽器／LINE LIFF
        │ ID token
        ▼
Worker API ──────► LINE token 驗證
        │ 驗證後建立網站 session
        ▼
預約 API ────────► D1：預約 + 操作紀錄 + 通知 outbox
        │ 交易完成後嘗試派送
        ▼
LINE Messaging API

LINE webhook ──► 原始 bytes 驗章 ──► destination 比對 ──► D1 收件去重
```

## 身分與權限

瀏覽器不決定使用者 ID 或管理員權限。伺服器向 LINE 驗證 ID token，檢查 audience、issuer 與期限後，使用隨機 cookie 建立網站 session。cookie 為 `__Host-dental_session`，設定 Secure、HttpOnly、SameSite=Lax 與 Path=/。session 上限為八小時，也不得超過驗證時 ID token 的有效期限。

患者擁有權使用 Provider 與 LINE subject 導出的 HMAC 識別值；需要發送通知的 subject 以 AES-GCM 加密保存。`BOOKING_ADMIN_LINE_ID` 由部署管理者在伺服器設定，僅授權兩個固定的示範診所。現有 `clinic_id` 與 webhook 租戶欄位提供資料界線，但不等於已完成可販售的多租戶管理平台。

寫入 API 驗證精確 Origin、JSON 格式及 session CSRF token，另有登入與寫入限流。公開回傳的預約資料不含患者識別代碼或加密收件者。API 不接受由前端任意指定角色或跨診所管理範圍。

## 預約交易

時段為固定半小時。狀態為 `pending → confirmed → cancelled`，也允許 `pending → cancelled`。資料庫對待處理／已確認預約使用同時段唯一限制，對相同患者與 idempotency key 使用唯一限制，狀態更新使用 revision 進行競爭檢查。

每次有效變更將預約、操作紀錄及有同意通知的 outbox 一併寫入。取消只改變狀態並釋出時段，不會刪除所有歷史資料或恢復每日示範額度。

## 通知

派送使用 D1 claim lease、固定 LINE retry key 及重試期限降低重複發送風險。暫時失敗可保留等待手動重試；永久失敗、過期、舊 revision 或展示額度已滿時，依原因停止／略過。沒有背景排程或自動就診提醒。

訊息只包含示範診所、時間、狀態、預約編號及管理入口，不包含姓名、電話或健康資訊。LINE 的接受回覆不等於送達證明。全站每日 30 次限制計算實際發送嘗試，含重試；限制以持久 D1 維持，不依賴單一 Worker 的記憶體。

## 實際保存資料

| 資料 | 保存方式 |
| --- | --- |
| 原始登入 ID token | 驗證時處理，不設計為持久保存欄位 |
| 網站 session | D1 保存雜湊 token、期限、患者代碼與加密 LINE subject |
| 示範預約 | 固定姓名電話、診所／醫師／時段、狀態、通知選擇及時間 |
| webhook | 事件 ID、類型、時間、去重及經 HMAC 處理的來源；不保存訊息內文 |
| LINE channel 憑證 | 部署環境受保護設定，不放入公開原始碼或 D1 業務表 |
| 診斷 | 登入階段及有限錯誤代碼，不輸出原始 token、資料庫參數或 LINE 原始錯誤內容 |

此展示沒有完整資料保留、刪除申請或金鑰輪替功能。正式部署者需自行制定並實作這些程序；單純刪除網站 session 或取消預約不等於刪除使用者的所有紀錄。
