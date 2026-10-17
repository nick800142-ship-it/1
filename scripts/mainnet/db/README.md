# 主網網站設定

兩個網站共用同一個 Git 倉庫，只靠 Vercel 環境變數 `NETWORK` 區分。
現在的 rwmt.link 專案不用改任何東西（沒設 `NETWORK` 就是測試網）。

## 1. 新的 Supabase 專案（主網資料庫）

在 Supabase SQL Editor 依序執行：

1. `01-schema.sql`：表、函式、RLS、權限（不含資料）
2. `02-seed.sql`：登入觸發器、即時更新、圖片空間、平台設定（生效 Safe＝主網 Safe）、分潤費率

Authentication → Providers：開啟 Email（Privy 登入靠 magic link 換 session）。

## 2. 新的 Vercel 專案

連同一個 GitHub 倉庫（rwmt），Production Branch 用 `main`。環境變數：

| 變數 | 值 |
| --- | --- |
| `NETWORK` | `mainnet` |
| `MAINNET_ADMIN_EMAILS` | 管理員 email，逗號分隔（這些人登入即為管理員） |
| `ADMIN_PRIVATE_KEY` | 主網熱錢包 `0x9FB5…377F` 的私鑰（不可和測試網共用） |
| `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`SUPABASE_ANON_KEY` | 新 Supabase 專案的值 |
| `NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_ANON_KEY` | 同上 |
| `NEXT_PUBLIC_PRIVY_APP_ID` | 和測試網相同 |
| `TELEGRAM_OPS_BOT_TOKEN`、`TELEGRAM_OPS_CHAT_ID` | 可和測試網相同（主網訊息會加「【主網】」） |
| `CRON_SECRET` | 新產生一組 |

不要設：`MAINNET_PUBLIC_OPEN`（設成 `true` 才會開放一般用戶登入，正式上線時再加）。

Privy 後台：Allowed origins 加上新網站網址。

## 3. 部署主網四顆合約

`npm run mainnet:check` 通過後，用有 Base 主網 ETH 的錢包執行
`node scripts/mainnet/deploy.mjs --broadcast`（需 `MAINNET_DEPLOYER_PRIVATE_KEY`）。
部署前主網網站可以登入、看畫面，但任何鏈上動作都會失敗。

## 4. 正式上線

在 Vercel 把 `rwmt.link` 從舊專案移到主網專案，舊專案改用測試網子網域；
主網專案加 `MAINNET_PUBLIC_OPEN=true` 後重新部署。
