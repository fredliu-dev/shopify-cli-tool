# shopify-cli-tool

对 [`@shopify/cli`](https://www.npmjs.com/package/@shopify/cli) 的美化封装。兼容所有原生 shopify 命令，并围绕主题开发流程提供了一组更易用的自定义命令。

## 快速开始

```bash
npm install -g shopify-cli-tool
```

要求 Node.js >= 22。

### 1. 初始化配置

在主题项目根目录运行：

```bash
shop init
```

按提示选择模板，填写 `theme`、`port`、`preview_key`、`project_desc`（选填），工具会生成 `shopify.theme.toml`。再打开它，把 `[environments.dev]` 下的 `domain`、`store` 改成你对应店铺的值。

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

输出提测链接、主题后台地址和主题编辑器地址。

## 命令参考

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

```bash
shop add
```

#### `shop ls`

以表格列出所有已保存的项目（模板、描述、store、theme、端口等）。

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
3. 选中后把该项目的 `preview_key` / `port` 同步进 `[environments.dev]`。
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

### 帮助与版本

| 命令 | 说明 |
|---|---|
| `shop help`、`shop -h`、`shop --help` | 查看命令列表 |
| `shop version`、`shop -v`、`shop --version` | 查看本工具版本 |

不带任何参数运行 `shop` 也会显示帮助。

## 原生命令透传

所有非自定义命令都会原样透传给 `@shopify/cli`，参数、输出、退出码保持一致。

```bash
shop theme pull
shop theme push
# …任意 shopify 命令
```

## 配置文件：`shopify.theme.toml`

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
