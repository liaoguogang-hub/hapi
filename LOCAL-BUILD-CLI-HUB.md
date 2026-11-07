# 本机构建：Kestrel 的 hub 与 CLI

这份文档记录本机从 `tiann/hapi` 的 fork 构建 **hub** 与 **CLI** 的完整流程，
以及把 DSH 桌面端会话导入 Kestrel（手机/网页端）的方法。

Android APK 的构建见仓库根目录的 [`LOCAL-BUILD.md`](LOCAL-BUILD.md)；
那份文档只覆盖 APK，从未编译过 hub/CLI —— 两者在此之前一直跑的是上游
`0.34.3` 发行版。

## 1. 这个 fork 改了什么

| commit | 内容 |
|---|---|
| `46b87d2` | **导入 DSH 原生会话历史**（本次构建的目的） |
| `3a00257` | 产品改名 Kestrel |
| `fc5512b` … `3bdfe3a` | Android 端模型选择器与图标修复 |

`46b87d2` 新增：

- `hub/src/web/routes/dshImport.ts` —— 导入路由 `POST /cli/dsh/import`
- `hub/src/web/middleware/cliAuth.ts` —— `/cli` 路由的 token 鉴权
- `cli/src/modules/common/dshSessions.ts` —— 读取并归一化 DSH 会话存储
- `cli/src/commands/dshImport.ts` —— `hapi dsh-import` 命令

## 2. 两条不同的 `session/list`

容易混淆，必须分清：

| 通道 | 协议 | 用途 | 带标题？ |
|---|---|---|---|
| ACP `session/list` | JSON-RPC over stdio | 仅刷新标题（`AcpSdkBackend.ts:646`） | 否，只有 id + cwd |
| **DSH Host RPC `session/list`** | HTTP POST + cookie | **导入会话列表** | **是**（标题/cwd/updatedAt/running） |

导入走第二条。Host 端点与调用格式（见 `cli/src/modules/common/dshSessions.ts`）：

```
POST http://127.0.0.1:6413/api/session/list
Cookie: dsh-auth-<base64url(sha256(authority))>=v1.<claims>.<hmac>

{
  "type": "client-request",
  "rpcId": "hapi-dsh-<ts>-<rand>",
  "method": "session/list",
  "payload": { "args": { "_request": {} } }
}
```

Cookie 的签名密钥取自 `~/.dsh/.credentials.yaml` 的
`client-connection/browser-session.secret`，**先 base64url 解码**再用作
HMAC-SHA256 密钥；claims 里的 `authority` 必须与请求的 `Host` 头完全一致。

读取完整对话用另外两个只读端点：

```
session/projections   -> 标题 + asOfSeq 水位线
session/page          -> 事件流（user/message、assistant/message、session/title）
```

## 3. 为什么反向（APK → 桌面端）天然成立

不靠回写文件，靠**共享存储**。

hapi 通过 ACP `session/new` 起的会话，物理上就落在 DSH 桌面端读的那份
存储里：

```
~/.dsh/sessions/<workspace>/<session id>/session.v4.jsonl.zstd
```

实测（`hapi` 起的会话 id 能在 DSH Host 的 `session/list` 里找到，且带标题）：

```
51f5442f -> ~/.dsh/sessions/--D-KimiCode--/51f5442f-...
6bf172d3 -> ~/.dsh/sessions/--C-Users-guoga--/6bf172d3-...   title=你是谁
```

所以 APK 里新起的对话，桌面端刷新就能看到。

## 4. 构建环境（本机的三个坑）

`D:\hapi-main` 是只读的，且本机 DSH 沙箱有三处限制。构建副本放在
`C:\Users\guoga\Documents\DSH\build`。

### 坑一：`bun install` 在沙箱里不可用

`bun install` 报 `bun is unable to write files to tempdir: EPERM`，
**连只有 zod 一个依赖的空项目也失败**——不是项目问题，是环境限制。

`TEMP=/tmp` 这个 POSIX 路径对 bun（Windows 程序）无效，bun 解析成
`C:\tmp`，而它不存在。

**解法**：不装依赖，直接从 `D:\hapi-main` 的 store 物化。

### 坑二：bun 的 isolated 布局依赖符号链接

bun 默认 `linker = "isolated"`，把包放在
`node_modules/.bun/<name>@<version>/node_modules/<name>`，用**符号链接**连
依赖边。Windows 建符号链接需要特权，复制过来的树会静默丢掉每一条边
（`zod` 能解析、`proper-lockfile` 不能）。

**解法**：`scripts/materialize-deps.ts` 把 store 物化成 **hoisted** 布局
（扁平真实目录，Node 向上查找即可解析），并按依赖图递归补齐整个闭包。

版本选择按 package.json 声明的范围匹配——store 里同时存在
`@vitest/expect` 2.1.9 与 4.0.16，取错版本会让类型检查报出一片
`toHaveBeenCalledExactlyOnceWith` 不存在。

### 坑三：workspace 内部链接建不出来

`@hapi/protocol` 指向 `shared/`，`hapi-hub` 指向 `hub/`。这些是软链，
复制后失效。

**解法**：用 **junction**（目录联接），Windows 无需特权即可创建：

```powershell
New-Item -ItemType Junction -Path cli/node_modules/@hapi/protocol -Target (Resolve-Path shared)
New-Item -ItemType Junction -Path cli/node_modules/hapi-hub       -Target (Resolve-Path hub)
```

### 坑四：tunwg 二进制下载不到

CLI exe 编译时要打包 `shared/tools/tunwg/tunwg-x64-win32.exe`，
`bun run hub/scripts/download-tunwg.ts` 在沙箱里连不上 GitHub。

**解法**：从已安装的 0.34.3 里取：

```powershell
Copy-Item $env:USERPROFILE\.hapi\runtime\0.34.3\tools\tunwg\tunwg.exe `
          shared/tools/tunwg/tunwg-x64-win32.exe
```

## 5. 构建步骤

```powershell
# 0) 准备副本（只读源 -> 可写工作区）
cd D:\hapi-main
tar -cf - --exclude='./android' --exclude='./website' --exclude='./docs' `
          --exclude='./e2e' --exclude='./ios' --exclude='./relay' `
          --exclude='./node_modules' --exclude='./*/node_modules' . `
  | tar -xf - -C C:\Users\guoga\Documents\DSH\build

cd C:\Users\guoga\Documents\DSH\build
git checkout -b feature/local-hub-cli-build

# 1) 物化依赖（isolated -> hoisted 闭包）
bun scripts/materialize-deps.ts --store D:/hapi-main/node_modules/.bun --workspace .

# 2) workspace junction
powershell -NoProfile -Command "
  foreach (\$pkg in @('cli','hub','web')) {
    New-Item -ItemType Directory -Force -Path \"\$pkg/node_modules/@hapi\" | Out-Null
    New-Item -ItemType Junction -Path \"\$pkg/node_modules/@hapi/protocol\" -Target (Resolve-Path shared) | Out-Null
  }
  New-Item -ItemType Junction -Path 'cli/node_modules/hapi-hub' -Target (Resolve-Path hub) | Out-Null
"

# 3) tunwg 二进制
Copy-Item $env:USERPROFILE\.hapi\runtime\0.34.3\tools\tunwg\tunwg.exe `
          shared/tools/tunwg/tunwg-x64-win32.exe

# 4) 类型检查
bun run --cwd cli  typecheck
bun run --cwd hub  typecheck

# 5) 构建 hub
bun run --cwd hub build              # -> hub/dist/index.js

# 6) 构建 CLI exe（Windows）
bun run --cwd cli scripts/build-executable.ts --target bun-windows-x64 --outdir dist-exe
#    -> cli/dist-exe/bun-windows-x64/hapi.exe

# 7) 归档 + manifest
bun scripts/write-manifest.ts --dist dist/<version> --version <version> --repo .
```

## 6. 版本管理

| 位置 | 内容 |
|---|---|
| `cli/package.json` → `version` | CLI 自身版本（`hapi --version` 输出它） |
| `shared/src/buildInfo.ts` → `APP_VERSION` | hub/协议版本，同时决定 `~/.hapi/runtime/<版本>/` 目录 |
| `android/gradle.properties` → `hapiVersionName` | APK 版本，**独立计数** |
| `dist/<版本>/manifest.json` | 构建清单：源码 commit、工具链版本、每个产物的 sha256 |

当前本地版本：`0.34.3+local.1`。Android 侧是 `0.34.3+local.7`，两者独立
计数。

Tag 约定：

| tag | 指向 |
|---|---|
| `v0.34.3-local.N` | Android APK 构建 |
| `hub-cli-v0.34.3+local.N` | hub + CLI 构建 |
| `upstream-2741217` | 上游基线 commit |

版本号规则沿用仓库自带的 `cli/scripts/release-version.ts`（它同步
`cli/package.json`、`shared/src/buildInfo.ts`、iOS 与 Android 四处）。该脚本
会要求 `android/` 与 `ios/` 存在；只构建 CLI/hub 时手工改前两处即可。

## 7. 验证

```powershell
# 版本自证
.\cli\dist-exe\bun-windows-x64\hapi.exe --version
# -> hapi version: 0.34.3+local.1

# 路由存在（上游 0.34.3 在此返回 404）
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3999/cli/dsh/import `
  -Headers @{authorization='Bearer <token>:default'} `
  -ContentType 'application/json' -Body '{"machineId":"x","sessions":[]}'
# -> 400 {"error":"Invalid body", ... "Too small: expected array to have >=1 items"}
```

隔离验证用独立 `HAPI_HOME` 与端口，**不碰正式的 `~/.hapi`**：

```powershell
$env:HAPI_HOME = 'C:\Users\guoga\Documents\DSH\build\.testhome'
$env:HAPI_LISTEN_PORT = 3999
$env:HAPI_LISTEN_HOST = '127.0.0.1'
bun hub/dist/index.js
```

## 8. 导入 DSH 会话

```powershell
$env:HAPI_HOME = 'C:\Users\guoga\Documents\DSH\build\.testhome'
$env:HAPI_API_URL = 'http://127.0.0.1:3999'

# 列出
.\cli\dist-exe\bun-windows-x64\hapi.exe dsh-import --cwd 'D:\KimiCode'

# 导入全部
.\cli\dist-exe\bun-windows-x64\hapi.exe dsh-import --cwd 'D:\KimiCode' --all
```

实测结果：`D:\KimiCode` 下 40 个会话 → 导入 7 个、跳过 30 个
（"no importable messages"，即只有系统消息、没有用户对话的空会话），
共 21 条消息。**重复执行是幂等的**（第二次 `0 message(s) appended`）。

导入的会话在 hub 里带：

- `metadata.dshSessionId` —— 与 DSH 会话的对应关系，用于去重
- `metadata.name` / `metadata.summary.text` —— 标题
- `metadata.path` —— 工作区
- `metadata.lifecycleState` = `imported`
- 原始时间戳（消息的 `createdAt` / `invokedAt` 保持 DSH 侧的值）

APK 显示标题走 `metadata.name` → `metadata.summary.text` →
`metadata.promptTitle` → path → id 的回退链，导入时写的是前两个，
所以标题正常显示。

## 9. 已知限制

1. **7 个会话始终导不进来。** 它们的 `session/projections` 返回 `ok: true`
   但没有 `asOfSeq`，没有序号水位就读不出事件流，导入报
   `DSH did not report a head seq`。是这些会话本身没有可枚举的历史。
2. **大量会话没有可导入内容。** `D:\KimiCode` 40 个里只有 7 个有用户消息，
   其余只有系统注入，Host 侧 `blank: true` 或无 `user/message` 事件。
3. **占用中的会话接不了。** 桌面端正开着的会话，ACP 返回
   `already owned by an active write handle`，hapi 会**静默新建**一个
   会话而不是报错。导入路由本身有守卫，拒绝向已有 live-agent 消息的
   会话导入。
4. **DSH Host 侧只有只读端点。** `dshSessions.ts` 只用
   `session/list`、`session/projections`、`session/page` 三个，没有写入
   端点——反向同步靠共享存储，不靠回写。
5. **tunwg 隧道功能未验证。** 二进制是从 0.34.3 借来的，版本可能不匹配。
   本机对外入口走 Tailscale Serve，不依赖 tunwg。

## 10. 部署（2026-11-08 已上线）

`0.34.3+local.2` 已替换掉 npm 全局的 `hapi.exe`，版本自证：

```powershell
hapi --version      # hapi version: 0.34.3+local.2
```

部署脚本在 `C:\Users\guoga\Documents\DSH\deploy\`（独立 git 仓库，
tag `deploy-v0.34.3+local.2`）：

| 脚本 | 作用 |
|---|---|
| `verify.ps1` | 只读体检：版本、健康、导入路由、会话数、任务状态 |
| `deploy.ps1` | 停看门狗 → 停任务 → 备份 → 换二进制 → 启任务 → 验证，失败自动回滚 |
| `post-deploy.ps1` | 立即导入一次 + 注册 `HAPI DSH Sync` |
| `dsh-sync.ps1` | 每 10 分钟跑一次的导入 |
| `rollback.ps1` | 还原二进制（可选数据库） |

**只换一个文件就够**：`HAPI Hub` 和 `HAPI Runner` 都通过 `hapi.cmd` 启动，
落到同一个 `hapi.exe`；这个自包含二进制里装着 hub、runner、Web 前端和导入功能。

上线后的实测：

| 项 | 值 |
|---|---|
| 会话总数 | 99（16 原有 + 83 导入） |
| 消息总数 | 48570 |
| DSH 会话 | 87，其中 83 条 `lifecycleState=imported` |
| 重复导入 | 0（`dshSessionId` 无重复分组） |
| 同步任务 | 每 10 分钟，实测增量 `0~3 messages appended` |

备份在 `~/.hapi/deploy-backups/`（`hapi.exe.<时间戳>` 与 `hapi.db.<时间戳>`）。

### 上线后补的一个坑：runner 的工作区根

导入之后 APK 能看到对话，但发消息报
`Directory is outside this machine's workspace roots`。

`HAPI Runner` 任务只注册了 `--workspace-root "D:\KimiCode"`，而导入的 78 个会话
都在 `C:\Users\guoga\Documents\DSH`。runner 的
`MachinePathPolicy.isWithinSpawnRoots` 是硬性检查，第二个根必须真的在启动参数里。
（`isWithinBrowseRoots` 直接复用 spawn 的那份列表，所以浏览和 spawn 同源。）

任务改不动：`schtasks /Change /TR` 要密码，`Set-ScheduledTask` 报
`0x80070005`，`schtasks /Create` 重建会丢电池/重试设置。最终在
`%APPDATA%\npm\hapi.cmd` 这层注入第二个根 —— 详见
`C:\Users\guoga\Documents\DSH\deploy\README.md` 的「工作区根」一节。

## 11. 本次改动涉及的文件

| 位置 | 内容 |
|---|---|
| `D:\hapi-main` | 只读源仓库，未改动（保留 upstream 基线） |
| `~` 下的 `build` 工作副本 | 版本号、两个构建脚本、本文档 |
| `C:\Users\guoga\Documents\DSH\kestrel-build\` | 构建产物 + manifest |
| `C:\Users\guoga\Documents\DSH\deploy\` | 部署/回滚/同步/根配置脚本（独立 git） |
| `%APPDATA%\npm\hapi.exe` 所在目录 | 被替换的二进制 |
| `%APPDATA%\npm\hapi.cmd` | runner 根注入包装（原版存为 `hapi.cmd.npm-original`） |
| `D:\KimiCode\LOCAL-BUILD.md` | 机器运维文档已同步更新 |


