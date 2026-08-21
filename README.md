# shopify-cli-tool

对 [`@shopify/cli`](https://www.npmjs.com/package/@shopify/cli) 的美化封装，提供终端和桌面两种使用方式：

- **命令行工具 `shop`**：兼容所有原生 shopify 命令，并围绕主题开发流程提供了一组更易用的自定义命令（所有命令需要在项目根目录执行）。
- **桌面应用「Shopify 工具箱」**：把同一条开发流程搬进图形界面，见[六、桌面应用](#六桌面应用shopify-工具箱)。

***当前工具只支持 us、ca、de 三个项目配置模版***

本仓库是 pnpm monorepo，包含三个包：

| 目录 | 包名 | 说明 | 分发 |
|---|---|---|---|
| [packages/cli](packages/cli/) | `shopify-cli-tool` | 终端命令 `shop` | npm |
| [packages/core](packages/core/) | `@shopify-cli-tool/core` | CLI 与桌面应用共用的核心逻辑（headless） | npm |
| [packages/desktop](packages/desktop/) | `@shopify-cli-tool/desktop` | Electron 桌面应用「Shopify 工具箱」 | GitHub Release（macOS / Windows） |

参与开发请看 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 一、背景
### 1.项目通常不上传配置文件shopify.theme.toml到仓库，手动创建耗时且容易出错，从其他地方复制耗时
命令：shop init
可以快速生成 `shopify.theme.toml` 文件，包含默认的开发环境配置。

### 2. 项目开发完提测链接老是人工拼接，找拼接url耗时
命令：shop pre
可以快速获取提测链接、本地调试地址、主题后台地址和主题编辑器地址。不用再手动拼接和记忆拼接规则。

### 3. 当同一个主题有多个页面要开发的时候，或者需要切换到其他分支去开发的时候，需要频繁的去网站上找theme_id和preview_key
命令：shop add
可以快速的把当前配置缓存到本地
命令：shop ls
可以列出所有已保存的配置
命令：shop edit
可以编辑某个配置
命令：shop del
可以删除某个配置
命令：shop use
可以快速切换到某个配置
这样就不用频繁的去后台查找theme_id和preview_key了，直接用命令切换即可

### 4.shopify运行命令太长不容易记，需要记忆多个参数
命令：shop dev
可以快速启动本地开发环境
命令：shop async
可以快速启动本地开发环境，同时把本地主题同步到主题编辑器

### 5. 在收到需求后，去拉分支后又要去后台复制主题，然后还要等主题创建好再点进去获取theme_id，来回切换应用等待太耗时了，主题的命名格式还需要记忆
命令：shop add
在你没有输入theme_id的时候会提示你是否需要复制线上主题，选择是就会自动去创建了，创建成功就会把theme_id保存到shopify.theme.toml文件中，同是把当前配置缓存到本地，方便后续切换配置

### 6.设计稿里有时候提供的图片边缘有空的地方需要裁剪掉，美工处理需要时间
命令：shop handleimage
可以把当前文件夹下的图片裁剪空白边框并转成webp格式

### 7.提测完要手动去钉钉群发通知，@人、贴提测链接来回复制耗时
命令：shop gotest
可以选择通知群和发布模板，提测本地项目时自动带上提测链接和项目描述，一键发送钉钉通知，还能 @ 指定的人或 @ 所有人



## 二、快速开始

```bash
npm install -g shopify-cli-tool
```

要求 Node.js >= 22。

不想用命令行？可以直接下载[桌面应用](#六桌面应用shopify-工具箱)，图形界面完成同样的流程。

### 1. 初始化配置

在主题项目根目录运行：

```bash
shop init
```

按提示选择模板，填写 `theme`、`port`、`preview_key`、`project_desc`（选填），工具会生成 `shopify.theme.toml`。

### 2. 本地开发

```bash
shop dev    # 等价于 shopify theme dev -e dev
shop async  # 等价于 shopify theme dev --theme-editor-sync -e dev
```

`shop async` 会把本地主题同步到主题编辑器，适合需要在后台可视化调整的场景。`shop dev` 成功结束后会自动调用 `shop pre` 生成预览链接。

### 3. 获取预览链接

```bash
shop pre
```

输出提测链接、本地调试地址、主题后台地址和主题编辑器地址。

## 三、命令参考

所有自定义命令都通过 `shop <命令>` 调用；未列出的命令会原样透传给 `@shopify/cli`。

### 配置与项目管理

| 命令 | 说明 |
|---|---|
| [`shop init`](#shop-init) | 初始化 / 补全 `shopify.theme.toml` |
| [`shop add`](#shop-add) | 把当前配置保存为项目 |
| [`shop ls`](#shop-ls) | 列出所有已保存的项目 |
| [`shop edit`](#shop-edit) | 编辑某个项目的配置 |
| [`shop del`](#shop-del) | 删除项目（多选 + 二次确认） |
| [`shop use`](#shop-use) | 选用与当前配置匹配的项目并启动开发 |

#### `shop init`

初始化 `shopify.theme.toml`：

- 文件不存在：选模板 → 填 `theme` / `port` / `preview_key` / `project_desc`(选填) → 生成。
- 文件已存在但缺少 `[environments.dev]`：选模板，把整个 dev 环境合并进去。
- 文件已存在且 `dev.domain` 已配置：提示已初始化完毕。

```bash
shop init
```

#### `shop add`

读取 `shopify.theme.toml` 中所有带 `store` 的环境，补全缺失字段后保存为项目。

- 逐个环境补全 `domain` / `port` / `theme` / `preview_key`(选填) / `project_desc`，并把补填值写回配置文件。
- `theme` 缺失时会询问「是否复制线上 live 主题」，选择是则自动复制 live 主题为草稿并把新主题 id 回填到 `theme`。
- 多选要保存的环境（默认勾选 `dev`）。
- 判重：`project_desc`、`domain`、`theme`、`store`、`preview_key` 五要素全相同视为「已存在」并跳过；否则作为新项目追加（改了 theme 就是新项目，不会覆盖旧的）。
- 存储位置在用户数据目录（包外），更新或重装工具都不会丢失：Windows 为 `%APPDATA%\shopify-cli-tool\projects.json`，macOS / Linux 为 `~/.config/shopify-cli-tool/projects.json`。可用 `shop ls` 查看实际路径。

```bash
shop add
```

#### `shop ls`

以表格列出所有已保存的项目（模板、描述、store、theme、端口等），并在末尾显示数据文件路径，方便定位与备份。

```bash
shop ls
```

#### `shop edit`

选择一个项目，修改 `theme` / `preview_key` / `port` / 描述（模板由 `store` 自动判断，仅展示）。

```bash
shop edit
```

#### `shop del`

多选要删除的项目，随后二次确认（逐条列出待删项目，默认选「否」）后才执行。

```bash
shop del
```

#### `shop use`

按当前配置的 `theme` + `store` 匹配已保存的项目：

1. 读取（缺失则补填并写回）当前 `theme` / `store`。
2. 列出项目，只有 `theme` + `store` 与当前配置一致的可选，其余置灰。
3. 选中后把该项目的全部字段（`domain` / `project_desc` / `preview_key` / `port` 等，`theme` / `store` 本就是匹配条件也一并写入）同步进 `[environments.dev]`。
4. 选择执行 `shop dev` 或 `shop async`；若端口被旧 dev server 占用会自动释放。

```bash
shop use
```

### 主题开发

| 命令 | 说明 |
|---|---|
| [`shop dev`](#shop-dev) | 本地预览主题，结束后自动生成预览链接 |
| [`shop async`](#shop-async) | 本地预览并同步到主题编辑器 |
| [`shop pre`](#shop-pre) | 输出预览链接与后台地址 |
| [`shop copy`](#shop-copy) | 复制 live 主题为新草稿主题 |

#### `shop dev`

本地预览主题，等价于 `shopify theme dev -e dev`，`-e` 可选指定其它环境。成功结束后自动调用 `shop pre`。

```bash
shop dev
shop dev -e prod
```

#### `shop async`

本地预览并把改动同步到主题编辑器，等价于 `shopify theme dev --theme-editor-sync -e dev`。

```bash
shop async
```

#### `shop pre`

根据当前环境配置输出提测预览链接、主题后台地址和主题编辑器地址。

```bash
shop pre
shop pre -e prod
```

#### `shop copy`

把线上 live 主题复制成新主题（草稿）：

1. 选择环境。
2. 拉取该环境的 live 主题。
3. 输入活动名称、负责人，自动拼接主题名 `[env] 活动 | 负责人 | 日期`。
4. 复制成草稿主题，展示后台 / 编辑器链接。
5. 询问是否把新主题 id 回填到对应环境的 `theme` 字段。

```bash
shop copy
```

### 图片处理

#### `shop handleimg`

交互式批量处理当前目录下的图片：

- 依次选择是否裁剪（去除四周空白 / 阴影）、是否转为 webp、颜色容差、保存目录，再按选择执行。
- 支持格式：jpg / jpeg / png / gif / bmp / tiff / webp。
- `--tolerance` / `-t` 可直接指定颜色容差（默认 20）。

```bash
shop handleimg
shop handleimg --tolerance 30
```

### 钉钉通知

| 命令 | 说明 |
|---|---|
| [`shop gotest`](#shop-gotest) | 发送通知到钉钉群（选群 → 选模板 → 填占位 → 发送） |
| [`shop gotest -e`](#shop-gotest--e) | 输出本地钉钉配置文件路径 |

#### `shop gotest`

把按模板填好的文本消息发送到钉钉群机器人，支持 @ 指定手机号 / @ 所有人。交互流程：

1. 若本地有 `shop add` 保存的项目，先问「是否提测本地项目？」，选是则选择项目——模板里的 `{{@url}}` 自动填入项目**提测链接**，`{{@title}}` 自动填入项目**描述**。
2. 选择通知群（列表末尾可选「＋ 新增通知群」，输入群名 / webhook / 加签 secret）。
3. 选择发布模板（列表末尾可选「＋ 新增模板」，输入模板名与内容）。
4. 填写模板里的占位符：有默认值的 `{{@person}}` 会提示是否使用默认值；没有默认值的逐个输入；手动输入的手机号会询问是否保存为默认值（仅 `person` 类型会存）。
5. 发送到所选群。

占位符语法 `{{@类型[数字] as 显示名}}`（花括号内空格数量任意，不影响匹配）：

| 占位符 | 含义 |
|---|---|
| `{{@person as 姓名}}` | @ 某人，运行时输入其钉钉手机号；可配默认值 |
| `{{@url as 链接}}` | 替换成链接；提测项目时自动用项目提测链接 |
| `{{@title as 标题}}` | 替换成标题；提测项目时自动用项目描述 |
| `{{@all}}` | @ 所有人 |

`as` 后的「显示名」仅用于命令行提示展示；数字后缀区分多个同类（`@person` / `@person1` / `@url1` …）。

```bash
shop gotest
```

#### `shop gotest -e`

输出本地钉钉配置文件路径，群和模板都存在这个文件里，可直接手动编辑：

```bash
shop gotest -e
# 钉钉配置文件：C:\Users\xxx\AppData\Roaming\shopify-cli-tool\dingtalk.json
```

配置结构（`groups` 为通知群，`templates` 为全局模板库）：

```json
{
  "groups": [
    { "id": "xxx", "name": "提测群", "webhook": "https://oapi.dingtalk.com/robot/send?access_token=xxx", "secret": "SECxxx" }
  ],
  "templates": [
    {
      "id": "xxx",
      "name": "提测通知",
      "content": "{{@person as 发布人}} 提交了 {{@title as 任务}}，预览：{{@url as 提测链接}}。复审 {{@person1 as 复审}} {{@all}}",
      "defaults": {
        "@person": "13800138000（张三）",
        "@person1": "13900139000（李四）"
      }
    }
  ]
}
```

`defaults` 只对 `@person` 生效。手机号默认值可附带姓名，括号支持中文 `（）` 或英文 `()`，如 `13800138000（张三）`：展示时显示括号内的姓名，实际 @ 只用手机号；不带括号则直接展示并使用手机号。

### 帮助与版本

| 命令 | 说明 |
|---|---|
| `shop help`、`shop -h`、`shop --help` | 查看命令列表 |
| `shop version`、`shop -v`、`shop --version` | 查看本工具版本 |

不带任何参数运行 `shop` 也会显示帮助。

## 四、原生命令透传

所有非自定义命令都会原样透传给 `@shopify/cli`，参数、输出、退出码保持一致。

```bash
shop theme pull
shop theme push
# …任意 shopify 命令
```

## 五、配置文件：`shopify.theme.toml`

多数自定义命令围绕这个文件工作，`[environments.<名称>]` 下常用字段：

| 字段 | 含义 |
|---|---|
| `domain` | 站点域名（用于拼接预览链接） |
| `store` | Shopify 店铺 myshopify 域名，也用于判断模板 |
| `theme` | 主题 id |
| `port` | 本地 dev server 端口，默认 9292 |
| `preview_key` | 预览密钥（选填，新页面才需要） |
| `project_desc` | 项目描述（选填） |

工具自带 us / ca / de / empty 等模板，`shop init` 时按需选择。

## 六、桌面应用（Shopify 工具箱）

命令行之外，本仓库还提供一个 Electron 桌面应用，把同一条主题开发流程（拉分支 → 开发 → 提测 → 合并）搬进图形界面。桌面应用与 CLI 共用 `@shopify-cli-tool/core`，本地项目（`projects.json`）、钉钉配置（`dingtalk.json`）和用户模板都存放在同一数据目录，两边互通。

### 安装

到 [GitHub Releases](https://github.com/fredliu-dev/shopify-cli-tool/releases) 下载对应平台的安装包（macOS `.dmg` / Windows `.exe`）。已装旧版的用户启动应用时会自动检查并提示更新。

### 功能

#### 仓库工作台

- 选择本地工作区目录后自动扫描其中的 git 仓库，以卡片展示当前分支、`shopify.theme.toml` 状态与绑定的本地项目。
- 仓库卡片：切换分支（本地 / 远程分组，标注每个分支绑定的项目数）、用编辑器打开目录（自动检测本机编辑器，可设默认）、直达 GitHub 当前分支页和 Shopify 主题后台。
- 未初始化的仓库可「创建配置」，已有配置但缺 dev 环境的可「合并 dev 环境」（即 `shop init` 的桌面版）；「本地保存」即 `shop add`。

#### 开发流程（仓库卡片上的三步）

1. **拉取分支**：选类型（新功能 / 缺陷修复 / 紧急热修复）、基准分支（展开自动 fetch origin）、负责人、工单链接，自动命名分支并切换，同时同步配置。
2. **提测**：多选当前分支下的本地项目，选模板后按项目填充通知内容（可直接改），一键发钉钉群，可 @ 人员。
3. **合并信息**：上线前汇总多个项目的标题 / 工单生成合并通知；并可继续**提交 Pull Request**（类型 / 标题 / 目标分支 / reviewers），创建成功后展示 PR 链接并复制审核话术。

#### 项目管理

- 项目面板展示 store / theme / port / preview_key（theme、preview_key 点击复制），支持编辑、删除。
- 「JSON改动」列出当前分支改动里的 `.json` 文件，方便核对页面配置变更。
- 「删除主题」用 shopify 删除该 theme ID 对应的线上主题，并连带清理引用它的本地项目（红色二次确认）。
- 支持复制线上 live 主题为新草稿；「创建项目」可从模板的 `_github` 仓库一键克隆（自动查重）。

#### 文件引用关系图

- 仓库卡片「引用图」按钮在新窗口打开主题文件引用关系图（echarts）：扫描 `render` / `section` / `asset_url` 等静态引用，按 layout / templates / sections / snippets / assets 目录配色。
- 顶栏文件名模糊搜索（fzf 风格子序列匹配，如输入 `hro` 命中 `hero.liquid`）定位节点；悬停高亮该文件及其直接相邻节点；空白处拖拽平移、滚轮缩放。
- 扫描结果有缓存，秒开；「重新扫描」强制重扫并覆盖缓存。

#### 其他

- **模板管理**：内置模板只读，可新建用户模板（写入数据目录 `templates/`，`shop init` 也能选到）。
- **人员 / 通知群 / 信息模板管理**：维护钉钉手机号、群 webhook（加签 secret）和消息模板。
- **本地配置**：一键导出整个数据目录为 zip 备份、迁移。
- **关于**：查看客户端 / shopify CLI / git / Electron / Node 版本。
