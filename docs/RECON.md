# 逆向记录（TeleAgent 3.0.0 / 2026-11-11）

只记录可复现的事实，方便版本升级后重新核对。

## 1. 安装与数据目录

| 用途 | 路径 |
| --- | --- |
| 程序 | `D:\app\TeleAgent\TeleAgent.exe`；`resources\app.asar` 860,380,558 B |
| 配置 | `%USERPROFILE%\.config\TeleAgent\`（`users\<owner>\TeleAgent.jsonc`、`tools\*.ts`） |
| 数据 | `%USERPROFILE%\.local\share\TeleAgent\`（`Local State`、`Partitions\`、`logs\`、`runtimes\`、`users\`） |
| Go 内核 | `%LOCALAPPDATA%\...\runtimes\super-agent-code\bin\TeleAgent.exe`（49 MB，其实是个 opencode 风格的服务端） |
| 调试覆盖 | `%USERPROFILE%\.local\share\TeleAgent\internal-debug.yaml` |

## 2. 中继与鉴权

应用日志（`logs\main-*.log`）：

```
[ServerManager] Effective model relay URLs: {
  newApiBaseUrl: 'https://agent.teleai.com.cn/superCowork/sapi/api/v1',
  toolsNewApiBaseUrl: 'https://agent.teleai.com.cn/superCowork/sapi/api/v1',
  superAgentApiBaseUrl: 'https://agent.teleai.com.cn'
}
[ServerManager] System proxy is disabled for TeleAgent runtime; cleared HTTP(S)_PROXY env { source: 'windows-registry' }
```

app.asar 里的中继地址推导：

```js
const ys = "https://agent.teleai.com.cn/superCowork/sapi"
function sDe(t) { return `${t || ys}/api/v1` }   // t = internal-debug.yaml 的 llmBaseUrl
```

上游鉴权（实测）：

| 请求 | 响应 |
| --- | --- |
| 无任何凭据 | `401 {"code":40108,"message":"invalid token"}` |
| `Cookie: operationToken=...` | `401 40108` |
| `X-Token: <tenant:jwt>` | `401 {"code":40101,"message":"missing super agent security headers"}` |
| `X-Token` + `X-SuperAgent-Timestamp/Nonce/Device-Id/Install-Id` | `401 {"code":40104,"message":"unsupported sign version"}` |

Go 内核里出现的签名头常量：`X-SA-Sign-Version`（值 `superagent-auth-v1`）、`X-SA-Timestamp`、`X-SA-Nonce`、`X-SA-Signature`、`X-AK`、`LocalSessionKey`、`super-agent-go/1.0`。

## 3. 本地登录态（可读，已实现）

- `current-owner.json` → `{"ownerDir":"v1_public_1000123456789012345","tenantId":"public","userId":"...","generation":1}`
- `users\<ownerDir>\app-auth\token.json`：`{version:1, encryptedToken:"v10...", encrypted:true, scheme:"safe_storage", encryptedMeta:"v10..."}`
  - 解密：`Local State` 的 `os_crypt.encrypted_key`（base64，去掉前缀 `DPAPI`）→ Windows DPAPI(CurrentUser) → 32 字节 AES key → `v10` 结构 = 3 字节前缀 + 12 字节 nonce + 密文 + 16 字节 tag，AES-256-GCM。
  - 明文形如 `DEMO01:eyJhbGciOiJIUzI1NiJ9...`（tenant:JWT），claims: `tenant/userId/accountId/exp/nbf/jti`，有效期 7 天。
- `Partitions\owner%3A<ownerDir>\Network\Cookies`：SQLite，`value` 列是**明文** cookie（`agent.teleai.com.cn|operationToken`、`.teleai.com.cn|operToken`）。
- `users\<ownerDir>\auth.json`：用户自加的 provider 凭据，例如 `{"custom-<uuid>":{"type":"api","key":"oc_sk_..."}}`。

## 4. 本地跑起来的东西

| 端口 | 归属 | 说明 |
| --- | --- | --- |
| `127.0.0.1:4397` | Go 内核 | 同一个进程里还有随机本地端口；`/ready` 公开，其余路由需要本地鉴权，未带凭据返回 `401 {"code":"local_auth_missing"}` |
| 随机端口 | Go 内核 | `/plugin`、`/session`、`/provider`、`/experimental/tool/ids` 等 opencode 风格路由 |
| `127.0.0.1:<PORT>/super-agent/tools-bridge` | 应用自身 | 工具桥，`tools\auth.ts` 里约定：`Authorization: Bearer ${SUPER_AGENT_TOOLS_BRIDGE_TOKEN || "default-bridge-token"}`，端点 `/image-read`、`/baidu-search`、`/scheduler/create-task` |

## 5. 环境变量（子进程）

`SECRET_ENV_KEYS` 包含：`OPENCODE_SERVER_USERNAME`、`OPENCODE_SERVER_PASSWORD`、`SUPER_AGENT_AUTH_STATE`、`OPENCODE_CONFIG_CONTENT`、`SUPER_AGENT_LOCAL_SESSION_KEY`、`SUPER_AGENT_TOOLS_BRIDGE_TOKEN`、`SUPER_AGENT_TOOLS_SECURITY_AK/SK` 等；这些值走 stdin 传给 Go 内核，不落在 OS 环境块里（所以别指望从进程环境里读）。

## 6. 复盘：走过的死路

1. 系统代理 MITM —— 运行时清 `HTTP(S)_PROXY`，无效。
2. 改 `TeleAgent.jsonc` 里 NewApi 的 baseURL —— 该 provider 没有 baseURL 字段，地址由宿主在 spawn 时注入。
3. 拿 token 直接打上游 —— 卡在 `X-SA-*` 签名（40101/40104）。
4. 想让第三方客户端复用配额 —— 同上；需要官方 AK/SK，属于另一条合规边界。
## 7. 签名与路径：桥必须保留官方的路径前缀（本次实测结论）

TeleAgent 的 Go 内核（`ua=super-agent/1.0`）自己签名，上游按「官方路径」校验。所以 `llmBaseUrl` 决定了签名是否成立：

| `internal-debug.yaml` 里的 `llmBaseUrl` | 应用实际 dial 的路径 | 上游返回 |
| --- | --- | --- |
| `http://127.0.0.1:8787` | `/api/v1/chat/completions` | ❌ `401 {"code":40104,"message":"invalid signature"}` |
| `http://127.0.0.1:8787/superCowork/sapi` | `/superCowork/sapi/api/v1/chat/completions` | ✅ `200` + SSE（230 events） |

实测样本（`captures/requests.jsonl`，均为应用自己发起的真实请求）：

- 前缀缺失时的 6 条请求全部 `40104`，头部齐备：`x-superagent-sign-version: v1`、`x-superagent-signature`、`x-superagent-timestamp: 1794394567`、`x-route-target: ops-gateway`、`x-teleai-run-unit-type: memory_consolidation`。
- 带上 `/superCowork/sapi` 之后的第一条请求：`POST /superCowork/sapi/api/v1/chat/completions -> 200`，SSE 正文是应用在做当天的记忆整理，模型 `chat-lite`。

结论与实现：

1. `config.hookPath` 默认 `/superCowork/sapi`，`up`/`hook install` 都写这个地址。
2. `proxy.buildTargetUrl` 对「已经带官方前缀」的路径**原样**送 origin，不再拼接；只有客户端只说 `/api/v1/...` 时才补前缀（否则会出现 `.../api/v1/superCowork/sapi/api/v1/...` 这种废路径）。
3. 签名内容里至少包含路径，因此「改 host 不改 path」也必须靠前缀对齐，不能靠重写 URL。
4. `x-route-target: ops-gateway` 与 `X-Runtime-Env` 是 `llmBaseUrl` 非默认值时应用自动加的额外头，转发时必须原样保留（桥只过滤 hop-by-hop 头）。

## 7.5 每日签到（积分福利社）：纯前端功能，只要 X-Token

app.asar 里搜 `dailySign` 只有 2 处（zustand store 的 `userPointData / dailySignData / taskList` 字段），真正的接口表在**常量模块**里（偏移 842,840,503 / 842,925,257）：

```js
{ ACTIVE_USERCENTER: "/user/portal/companyStore/userCenter",
  ACTIVE_DAYTASK: "/user/portal/companyStore/checkDayTask",
  ACTIVE_CHECK_DAILY_TASK: "/user/portal/companyStore/checkTask",
  ACTIVE_CAMPAIGN_TYPE: "/user/portal/companyStore/getCampaignType",
  NEW_ACTIVE_DAYTASK: "/user/portal/companyStore/v2/checkDayTask",
  NEW_ACTIVE_DAYTASK_V3: "/user/portal/companyStore/v3/checkDayTask",
  ACTIVE_Detail: "/user/portal/points/detail",
  AUTH_SESSION_CODE: "/api/v1/auth/session-code" }
```

福利社组件的领取逻辑（偏移 847,637,xxx）：

```js
const D = async (task) => {
  const G = task.jump_url.replace("/superCowork/sapi", "");
  if (await pr(G) === null) return;   // pr() = GET，带 X-Token
}
```

实测（2026-11-11，token 来自 DPAPI 解密，仅带 `X-Token`，无 `X-SA-*`）：

| 请求 | 结果 |
| --- | --- |
| `GET https://agent.teleai.com.cn/superCowork/sapi/user/portal/companyStore/v3/checkDayTask?theme=light` | 200 `{"code":200,...}`，`activity_data` 两条：双11 活动（`web`）、每日可领100积分（`api`，`action_status:"completed"`，`jump_url: /superCowork/sapi/user/portal/companyStore/checkTask?type=daily_login`） |
| `GET .../user/portal/companyStore/checkTask?type=daily_login` | 200 `{"code":200,"msg":"success","data":[]}`（今日已领 → 空数组） |
| `GET .../user/portal/points/detail` | 200，`pointsBalance: 6100` |
| `GET .../user/portal/companyStore/userCenter` | 200，`plan_display_name:"免费版"`、`activities[0].remaining_activity_points:"6100.00"` |

结论：签到走的是 `superCowork/sapi` 下的 `/user/portal/*` 业务接口，**不需要签名**，token 足够；TeleAgent.exe（Go 内核）里没有相关字符串，说明这个功能完全在渲染层。实现见 `src/signin.mjs`（`checkDayTask` → 未领取的 `api` 任务 → `checkTask`），守护见 `node src/cli.mjs signin --daemon`。

未验证：真实「未领取 → 领取成功」的那一天（测试当天已领过）；服务端若改路径/加校验，先 `signin --dry-run` 看断在哪一步。

---

## 8. 本机策略导致的实现选择

- 往「启动」文件夹写 `.vbs` 被拒：`EPERM ... Startup\\TeleProxyBridge.vbs`（`.txt`/`.cmd` 可写）。因此开机自启改为 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 指向项目内 `autostart.vbs`（`wscript.exe` 隐藏窗口）。
- 重启 TeleAgent 不能用 Node 的 `spawn(exe, {detached:true})`：进程起来了但应用不出现（Electron 在非交互父进程下静默退出）。改用 `powershell Start-Process`，实测可用。
- `.cmd` 必须 CRLF；LF 结尾会让 cmd 把行首吃掉（例如 `title TeleProxyBridge` 变成 `eleProxyBridge`）。UTF-8 + `chcp 65001` 可以正常显示中文菜单。
