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

| 路徑 | 欄位 | 用途 | 輪換 |
|---|---|---|---|
| `apps/mediprisma/ai` | `base-url`、`api-key` | 自架 AI 服務（/api/ai 代理上游） | `api-key` 半自動（上游發行後 `--value` 發佈；生效免重啟） |
| `apps/mediprisma/runtime` | `AI_SELF_API_KEY`、`AI_PROXY_KEY`… | 容器啟動注入 | 自產欄位可全自動 |
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

# 4. 寫入密語
openbao kv put kv/apps/mediprisma/ai base-url="https://你的-AI-服務/v1" api-key="..."
openbao kv put kv/ci/dockerhub DOCKERHUB_USERNAME="..." DOCKERHUB_TOKEN="..."
```

## 環境變數（應用容器）

| 變數 | 說明 |
|---|---|
| `OPENBAO_ADDR` | 實例位址（留空＝完全不接 OpenBao，沿用 env） |
| `OPENBAO_AUTH_METHOD` | `approle`（預設）或 `jwt` |
| `OPENBAO_ROLE_ID` / `OPENBAO_SECRET_ID` | AppRole 憑證 |
| `OPENBAO_RUNTIME_PATH` | 啟動注入的 KV 路徑（預設 `kv/apps/mediprisma/runtime`） |

## 自動輪換

- **自產金鑰**（例如未來的簽章／session 金鑰）：排程執行
  `scripts/openbao/rotate-secret.mjs --path kv/apps/mediprisma --field <欄位>`，
  或啟用 `.github/workflows/openbao-rotate.yml`（以 `vars.OPENBAO_ROTATION_ENABLED=true`
  與 `vars.OPENBAO_ROTATE_FIELDS` 指定欄位）。寫入 KV 新版本即完成；
  應用端 60 秒 TTL 快取內自動改用新值，**免重啟**。
- **外部發行金鑰**（AI 服務、Docker Hub）：上游重新發行後以
  `rotate-secret.mjs --value <新值>` 發佈，生效方式相同（半自動——只有上游
  能發行新值，傳播與套用仍是自動）。
- **注意**：`NEXT_PUBLIC_*` 在建置期烘焙進前端，不可自動輪換（例如
  `NEXT_PUBLIC_AI_PROXY_KEY` 與伺服器 `AI_PROXY_KEY` 成對，輪換需重新建置）。

## CI（維持原本流程，選填接上 OpenBao）

`docker-publish.yml` 內建選填步驟：設定 repo 變數 `OPENBAO_ADDR` 後，映像發佈
改由 OpenBao 讀取 `kv/ci/dockerhub` 憑證；未設定時完全沿用 GitHub Secrets，
行為與原本一致。GitHub 側需要的僅是 repo 變數 `OPENBAO_ADDR`（或另加
`OPENBAO_JWT_ROLE`），其餘走 OIDC，不落長效憑證。
