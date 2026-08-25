# 开发与发布指南

本仓库是 **pnpm monorepo**，包含三个包：命令行工具、Electron 桌面应用，以及两者共用的核心逻辑。

> 日常开发和发布都只需在**仓库根目录**执行，不用记 `pnpm -F ...` 长命令。

---

## 一、前置环境

| 工具 | 要求 |
|---|---|
| Node.js | `>= 22` |
| pnpm | `>= 11`（用 corepack 启用：`corepack enable`，或 `npm i -g pnpm`） |
| npm 账号 | 仅发布 CLI/core 时需要（`npm whoami` 能返回用户名） |

首次克隆后安装依赖：

```bash
corepack enable
pnpm install
```

> 首次安装会下载 Electron 二进制（约 100MB），耗时较长。若网络慢，可临时用国内镜像：
> ```bash
> export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
> pnpm install --registry=https://registry.npmmirror.com
> ```

---

## 二、仓库结构

```
shopify-cli-tool/
├── package.json                # workspace 根，统一脚本入口
├── pnpm-workspace.yaml
├── scripts/                    # 调试与发布脚本（dev-* / release-*）
├── .github/workflows/release.yml  # 桌面应用 CI 发布
└── packages/
    ├── core/      @shopify-cli-tool/core    # 共享核心逻辑（headless，发 npm）
    ├── cli/       shopify-cli-tool          # 命令行工具（发 npm，命令 `shop`）
    └── desktop/   @shopify-cli-tool/desktop # Electron 桌面应用（发 GitHub Release）
```

依赖方向：`cli → core`、`desktop → core`。core 改动后，cli 和 desktop 因是 workspace 软链会**立即生效**，无需重装。

---

## 三、调试（三个命令）

均在仓库根目录执行。

### `pnpm dev:core` — 调试核心逻辑

进入 `packages/core`，跑一遍 smoke 验证：列出全部导出、模板列表、项目数量。

```bash
pnpm dev:core
```

适合改完 core 后快速确认函数正常。core 是纯逻辑库，没有运行界面。

### `pnpm dev:cli -- <参数>` — 调试命令行

进入 `packages/cli`，把参数透传给 `shop`。**参数前要加 `--`**。

```bash
pnpm dev:cli                  # 等同 shop（显示 help）
pnpm dev:cli -- ls            # shop ls
pnpm dev:cli -- add           # shop add
pnpm dev:cli -- pre -e dev    # shop pre -e dev
```

### `pnpm dev:desktop` — 调试桌面应用

进入 `packages/desktop`，启动 `electron-vite dev`，弹出应用窗口。

```bash
pnpm dev:desktop
```

- **界面（React）**：保存即热更新
- **主进程 / IPC**：改动后 Electron 自动重启
- **DevTools**：运行后按 `Cmd+Option+I`（mac）/ 菜单 View → Toggle Developer Tools

> 该命令已自动清除 IDE（VSCode/Trae 等）继承的 `ELECTRON_RUN_AS_NODE` 环境变量，否则 Electron 会以纯 node 模式启动导致 `app` 拿不到。

---

## 四、发布（两个命令，自动改版本号）

### `pnpm release:npm` — 发布 core + cli 到 npm

交互选择版本位，自动 bump **core 和 cli 两个包**的版本，然后**先发 core、后发 cli**。

```bash
pnpm release:npm
# 当前版本：core 1.0.0 / cli 1.0.14
# 升级版本位 [1]major [2]minor [3]patch（默认 3）: 3
# → core 1.0.1 / cli 1.0.15
# [1/2] 发布 core …
# [2/2] 发布 cli …
```

要点：
- **顺序不能反**：cli 依赖 core，core 必须先存在于 npm。
- `pnpm publish` 会自动把 cli 里的 `"@shopify-cli-tool/core": "workspace:^"` 替换为 core 的真实版本号，发布出去是正常依赖。
- core 是 scoped 包，脚本已带 `--access public`。

### `pnpm release:desktop` — 打包桌面应用 + 提示发版

**先把代码全部提交**，再交互选择版本位，bump desktop 版本，**本机打包**验证，自动提交版本号改动、打 tag，确认后推送触发 CI。

```bash
git add -A && git commit -m "feat: xxx"   # ① 先提交所有代码
pnpm release:desktop
# 当前版本：desktop 0.1.0
# 升级版本位 ... : 3   → desktop 0.1.1
# 本机打包（packages/desktop/release/，不上传 Release）…
# ✅ 已提交并打 tag。立即推送 origin 触发 CI 发布？[Y/n]
```

要点：
- **工作区不干净会直接拒绝发版**：tag 只能指向已提交的 commit，未提交的改动进不了 CI 构建的安装包（v0.1.24 就因此漏掉了 TAPD 工单系统）。务必先提交、再发版。
- 本地落后远端（`origin/<分支>` 有新提交）同样拒绝，先 `git pull`。
- 本机没有 `GH_TOKEN`，**不能直接上传到 Release**；真正发布靠**推 `desktop-v*` tag 触发 CI**。
- CI（`.github/workflows/release.yml`）会在 macOS + Windows 各构建，把 `.dmg` / `.exe` 挂到 GitHub Release。
- 已装旧版的用户启动 app 时，`electron-updater` 会自动检查、下载、提示更新。

---

## 五、完整发版流程示例

### 改了命令行逻辑（core / cli）→ 发 npm

```bash
pnpm release:npm          # 选版本位，自动发 core + cli
git add -A && git commit -m "release: cli vX.Y.Z"
git push
```

### 改了桌面界面（desktop）→ 发 GitHub Release

```bash
git add -A && git commit -m "feat: xxx"   # ① 先提交所有代码（必须，脚本会检查工作区干净）
pnpm release:desktop                      # ② bump 版本 + 本机打包验证 + 自动 commit/tag，确认后推送触发 CI
```

> 桌面发版 tag 用 `desktop-v*` 前缀，刻意与 CLI 的 npm 版本解耦，两边可独立迭代。

---

## 六、打包产物与签名

- 打包产物在 `packages/desktop/release/`（已被 `.gitignore` 忽略，不入库）。
- **当前未做代码签名**（个人/内部使用）：
  - macOS：用户首次打开会被 Gatekeeper 拦，需**右键 → 打开**。
  - Windows：SmartScreen 会弹未知发行者警告，点"仍要运行"。
  - 如需消除警告，后续配 Apple Developer 证书（mac notarize）和 Windows 代码签名证书。

---

## 七、常见问题

| 现象 | 原因 / 解决 |
|---|---|
| `pnpm dev:desktop` 报 `Cannot read properties of undefined (reading 'whenReady')` | IDE 继承了 `ELECTRON_RUN_AS_NODE=1`。`dev:desktop` 已自动清除，若仍报错检查是否直接跑了 `electron-vite dev` 而非脚本 |
| `pnpm install` 卡在 electron / sharp 下载 | 用 npmmirror 镜像（见第一节） |
| 改了 core 但 cli/desktop 没生效 | workspace 软链，正常应立即生效；若没有，重启 `dev:cli` / `dev:desktop` |
| `release:npm` 报 403 | 未登录 npm（`npm login`），或包名被占用 |
| core 第一次发布失败 | scoped 包需 `--access public`，脚本已带；若手动发要加 |

---

## 八、已废弃

`packages/cli/scripts/publish.js`（旧的单包发布脚本）已被根目录的 `pnpm release:npm` 取代，可删除（保留也不影响）。
