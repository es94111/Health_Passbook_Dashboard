# OpenBao 介接（既有實例）

本專案以 OpenBao 集中管理金鑰並支援**自動輪換**。此目錄是與「既存 OpenBao
實例」的介接層：原則檔、輪換工具與設定樣板。位址與認證（AppRole 或
GitHub Actions OIDC）之後填入即可，程式無需變更。

## 元件

| 檔案 | 用途 |
|---|---|
| `scripts/openbao/fetch-secrets.mjs` | 讀取 KV v2 密語 → 注入 env／GITHUB_ENV／dotenv／exec |
| `scripts/openbao/rotate-secret.mjs` | 輪換自產金鑰（寫入 KV 新版本；舊版保留於歷史） |
| `scripts/openbao/entrypoint.mjs` | 容器啟動：注入 `kv/apps/mediprisma/runtime/*` 後啟動 `server.js` |
| `policy-app.hcl` | 應用執行角色（唯讀 app 密語） |
| `policy-ci.hcl` | CI／輪換角色（讀 CI 憑證＋寫 app 密語） |

## 建議的密語佈局（KV v2，mount：`kv`）

| 路徑 | 欄位 | 用途 | 套用與輪換 |
|---|---|---|---|
| `apps/mediprisma/auth` | `google-client-secret` | Google OIDC client secret | 上游重新發行後更新 KV；應用快取最長 60 秒 |
| `apps/mediprisma/database` | `url` | PostgreSQL 連線字串 | 更新 KV 後最長 60 秒讀取新值，連線池會重建 |
| `apps/mediprisma/ai` | `base-url`、`api-key` | 自架 AI 服務（`/api/ai` 代理上游） | 更新 KV 後最長 60 秒讀取新值；上游 key 須先由服務提供者重新發行 |
| `apps/mediprisma/runtime` | `AI_SELF_MODEL`、`AI_SELF_ENDPOINT`、`AI_SELF_PROXY_KEY`、`AI_PROXY_KEY` 等 | 容器啟動時注入 runtime 環境與公開組態 | 容器啟動時讀取；更新後需重啟容器。公開值會寫入瀏覽器，不是秘密 |
| `ci/dockerhub` | `DOCKERHUB_USERNAME`、`DOCKERHUB_TOKEN` | 映像發佈 | 半自動（Docker Hub 重新發行後寫入） |

## 一次性設定（在你的 OpenBao 實例上）

```bash
# 1. 啟用 KV v2（若尚未啟用）
openbao secrets enable -path=kv kv-v2

# 2. 建立原則
openbao policy write mediprisma-app  openbao/policy-app.hcl
openbao policy write mediprisma-ci  openbao/policy-ci.hcl

# 3a. 應用角色（AppRole，容器用）
openbao write auth/approle/role/mediprisma-app \
  token_policies=mediprisma-app token_ttl=1h token_max_ttl=4h
openbao read -field=role_id   auth/approle/role/mediprisma-app/role-id
openbao write -f -field=secret_id auth/approle/role/mediprisma-app/secret-id

# 3b. CI 角色（GitHub Actions OIDC / JWT）
openbao auth enable jwt
openbao write auth/jwt/config/gha \
  oidc_discovery_url=https://token.actions.githubusercontent.com \
  bound_issuer=https://token.actions.githubusercontent.com
openbao write auth/jwt/role/github-actions \
  role_type=jwt \
  bound_audiences=<你的 OPENBAO_ADDR> \
  bound_subject="repo:es94111/Health_Passbook_Dashboard:*" \
  user_claim=sub token_policies=mediprisma-ci token_ttl=1h

# 4. 寫入應用密語（OAuth client secret、資料庫 URL 與 AI 上游金鑰皆為伺服器端秘密）
openbao kv put kv/apps/mediprisma/auth google-client-secret="..."
openbao kv put kv/apps/mediprisma/database url="postgresql://<user>:<password>@<host>:5432/<database>"
openbao kv put kv/apps/mediprisma/ai base-url="https://你的-AI-服務/v1" api-key="..."

# 5. 選用：容器啟動時注入的 runtime 設定；只放非秘密或需啟動時載入的額外閘門
openbao kv put kv/apps/mediprisma/runtime AI_SELF_MODEL="你的模型名稱" AI_PROXY_KEY="..."

# 選用：CI 發佈憑證
openbao kv put kv/ci/dockerhub DOCKERHUB_USERNAME="..." DOCKERHUB_TOKEN="..."
```

## 環境變數（應用容器）

| 變數 | 說明 |
|---|---|
| `OPENBAO_ADDR` | 實例位址（留空＝使用 `GOOGLE_CLIENT_SECRET`／`DATABASE_URL`／AI env 備援；設定後上述伺服器密語以 OpenBao 為準，讀取失敗不會退回 env） |
| `OPENBAO_ROLE_ID` / `OPENBAO_SECRET_ID` | 應用伺服器使用 AppRole 讀取 KV v2；本地自架容器必填 |
| `OPENBAO_RUNTIME_PATH` | 啟動注入的 KV 路徑（預設 `kv/apps/mediprisma/runtime`），用於 runtime 組態與額外閘門 |
| `OPENBAO_GOOGLE_CLIENT_SECRET_PATH` | Google OAuth client secret 的完整 KV v2 欄位路徑（預設 `kv/apps/mediprisma/auth/google-client-secret`） |
| `OPENBAO_DATABASE_URL_PATH` | PostgreSQL URL 的完整 KV v2 欄位路徑（預設 `kv/apps/mediprisma/database/url`） |

## 自動輪換

- `resolveSecret` 讀取的伺服器密語（Google OAuth client secret、資料庫 URL、自架 AI base URL／API key）會快取 60 秒；KV 更新後，後續請求最遲在快取到期時讀取新版本。資料庫 URL 改變時會重建 pool。外部供應商金鑰須先由供應商重新發行，再寫入 OpenBao。
- `AI_PROXY_KEY` 和 `AI_SELF_PROXY_KEY` 是額外閘門／瀏覽器配對值，從 `apps/mediprisma/runtime` 在容器啟動時注入；更新後須重啟容器，且配對值會公開給瀏覽器。它們不是本專案 session 的替代認證。
- 公開 `NEXT_PUBLIC_*` 設定不能作為秘密。runtime `app-config.js` 由容器啟動時產生，更新公開設定後也須重啟容器；它不會讓靜態 GitHub Pages 部署具備 Node API 或自架登入能力。
- 輪換工作流程可用 `scripts/openbao/rotate-secret.mjs` 與 `.github/workflows/openbao-rotate.yml` 將新版本寫入 KV；只對工作流程實際更新且應用會讀取的欄位啟用。

應用容器端的 Google OAuth client ID、`APP_BASE_URL`、`OPENBAO_ADDR` 與 AppRole 憑證須透過部署環境提供；其中 `GOOGLE_CLIENT_SECRET`／`DATABASE_URL` 只在未設定 `OPENBAO_ADDR` 的開發／備援模式使用。容器應以 Node standalone server 執行並連至 PostgreSQL；靜態匯出不支援本專案登入 API。

## CI（維持原本流程，選填接上 OpenBao）

`docker-publish.yml` 內建選填步驟：設定 repo 變數 `OPENBAO_ADDR` 後，映像發佈
改由 OpenBao 讀取 `kv/ci/dockerhub` 憑證；未設定時完全沿用 GitHub Secrets，
行為與原本一致。GitHub 側需要的僅是 repo 變數 `OPENBAO_ADDR`（或另加
`OPENBAO_JWT_ROLE`），其餘走 OIDC，不落長效憑證。
