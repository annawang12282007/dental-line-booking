# 資料庫、本機預覽與部署

本專案由 Sites 的 Vinext／Cloudflare starter 發展而來，使用 Cloudflare Worker runtime 及 D1 binding。一般 Node.js 靜態託管或直接以標準 Next.js server 啟動，不能取代這些執行環境。

## 乾淨本機環境

```sh
npm ci
npm test
npm run typecheck
npm run build
```

`npm ci` 使用提交的 lockfile。若本機 npm 設定省略開發或可選套件，請保留建置所需套件，或使用 starter 提供的 `npm run install:ci`。不要平行執行多個安裝程序。

`npm run dev` 使用 portable 模式開發伺服器；`npm start` 使用 Wrangler 啟動已建置 Worker，僅供本機預覽，不會部署。兩者預設共用忽略的 `.wrangler/state`。`dist/`、`.wrangler/`、`.sites-runtime/`、本機環境檔與產生的資料庫不應提交。

LINE 完整登入需要 HTTPS LIFF endpoint。純本機 HTTP 介面不是完整登入驗收；不要為了方便測試而移除正式 cookie 的 `Secure` 屬性、Origin／CSRF 檢查或伺服器 token 驗證。以自己的獨立 HTTPS 測試部署完成串接較容易重現。

## 初始化 D1

資料庫 binding 名稱為 `DB`。遷移只建立 schema，不會匯入原部署資料或自動建立診所。正式環境的遷移應由所選部署方式追蹤已套用版本；不可重複執行已完成的 SQL。

本機先執行 `npm run build` 產生 `dist/server/wrangler.json`，再針對**空白的本機資料庫**依序執行：

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_freezing_karen_page.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0001_cynical_roulette.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0002_lush_mister_fear.sql
```

這些命令只修改本機資料庫。不要將正式資料庫下載到版本庫，也不要用 `--remote` 取代 `--local` 後盲目重播。修改 schema 後可用 `npm run db:generate` 產生新遷移；已發布的遷移保留原樣。

資料庫就緒後，依 [LINE 設定](LINE_SETUP.md) 配置自己的管理員並登入，才會建立／延伸示範排班。

## Sites 託管

使用 Sites 時，為自己建立新的 Sites 專案與 D1。`.openai/hosting.json` 在此開源副本僅宣告 `DB` 等 binding；專案 ID 應由新專案流程配置，不可複製他人的部署識別或來源憑證。依目前 Sites 工具流程匯入原始碼、設定受保護環境、建置、保存版本及部署。

保留 `vite.config.ts` 中的 `sites()` 整合、Worker 入口及 build 輔助檔。發布前確認平台為 `DB` 套用完整遷移，且環境設定屬於相同網站。LINE 登入需要公網可達的入口；部署平台私人存取層若攔截登入回程或 webhook，LINE 端將無法正常完成串接。

Sites 的專案建立、來源上傳、存取控制、正式 secrets 與發布都屬於外部平台功能。GitHub 上的原始碼本身不包含這些權限，也不會因為執行 `npm run build` 自動上線。

## 直接部署至 Cloudflare

本程式核心依賴 Cloudflare Workers／D1，但目前提供的建置配置源自 Sites。產生的 `dist/server/wrangler.json` 含建置用／本機用的 binding 宣告，**不能直接視為已連上您 Cloudflare 帳號的正式部署設定**。

若改用自己的 Cloudflare Workers，需另行配置 Worker 名稱、帳號、D1 database ID、route／domain、資產、secrets 與遷移發布流程，並確認 generated Worker 對相關服務 binding 的需求。本版本未提供已驗收的獨立 Cloudflare 一鍵部署承諾；請在自己的帳號完成端到端驗收後再開放。

## 部署後檢查

- 檢查 HTTPS origin 與 `PUBLIC_ORIGIN` 一致、LIFF ID 與 Login channel 一致。
- 檢查一般瀏覽器及 LINE 內登入、登出與重新登入。
- 使用兩個測試身分驗證預約擁有權、管理員限制，以及同時段競爭結果。
- 確認預約在重新登入及重新部署後仍存在，證明使用了持久 D1。
- 若啟用訊息，確認同意選項、通知額度、手機收件與失敗重試行為。
- 記錄可回復的原始碼版本與資料庫備份；備份及其金鑰需獨立受保護保存。

原始 starter 的執行模式及底層工具說明保留於 [STARTER.md](STARTER.md)。其中空 schema、選用 D1 與通用登入示例是 starter 背景資料，不能取代本專案的 LINE 登入與 D1 設定。
