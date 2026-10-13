# 安全問題與部署界線

本專案目前是使用示範資料的預約流程。請勿把正式病患、病歷、健康資訊或公司內部 ERP 資料放入公開 Issue、測試 fixture 或此版本庫。

## 回報問題

若版本庫的 GitHub Security 頁面提供 **Report a vulnerability**，請使用該私人回報入口。若未提供，請先開一則不含敏感細節的 Issue，僅請維護者安排私人聯絡方式；不要在公開 Issue 貼出可利用步驟、有效 token、個資、資料庫備份或完整請求 headers。此專案目前未承諾固定回應時限或長期支援版本。

一般缺陷可附上版本／commit、作業系統、重現步驟及去識別化錯誤代碼。登入診斷若需要日誌，僅擷取 `BOOKING_LOGIN_FAILED` 的 `stage`、`code`、`status`、`reason`；先確認周邊平台日誌未包含 cookie、IP 或請求憑證。

## 憑證與資料

- 實際 `.env*`、`.dev.vars*`、本機 D1／Wrangler state、備份與 runtime 目錄均不應提交；只含占位值的 `.dev.vars.example` 為例外。
- LINE Channel Secret、Channel Access Token、管理員 LINE ID 及 `BOOKING_SECURITY_KEY` 只能放在受保護的伺服器設定。
- 前端解碼 token 不能替代伺服器驗證；不要開放任意指定使用者／管理員身分的測試後門。
- `BOOKING_SECURITY_KEY` 影響資料識別與加密。密鑰輪替需備份與遷移設計，不能任意換值後期待既存預約及通知仍可用。
- 如憑證外洩，先在對應服務撤銷／更新受影響憑證，再處理 Git 歷史、部署產物、日誌與備份中的暴露範圍。刪除單一檔案或 commit 不會使已外洩秘密失效。

## 已知範圍

程式包含 session、Origin／CSRF、擁有權、交易一致性及通知額度等保護，但自動化測試通過不等於安全稽核、法規適用性判定或正式診所營運驗收。多租戶開通、完整職務權限、資料生命周期管理、正式稽核追蹤與營運監控仍需另行實作。
