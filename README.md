# shopify-cli-tool

对 [`@shopify/cli`](https://www.npmjs.com/package/@shopify/cli) 的美化封装。兼容所有原生 shopify 命令，并围绕主题开发流程提供了几个更易用的自定义命令。

## 快速开始

### 1. 初始化配置

在项目根目录运行：

```bash
shop init
```

按提示选择模板、填写 theme、port、preview_key，工具会生成 `shopify.theme.toml`。

打开 `shopify.theme.toml`，把 `[environments.dev]` 下的 `domain`、`store` 等值改成你对应店铺的。

### 2. 本地开发

```bash
shop dev    # 等价于 shopify theme dev -e dev
shop async  # 等价于 shopify theme dev --theme-editor-sync -e dev
```

`shop async` 会把本地主题同步到主题编辑器，适合需要在后台可视化调整的场景。

`shop dev` 成功完成后会自动调用 `shop pre` 生成预览链接。

### 3. 获取预览链接

```bash
shop pre
```

输出提测链接、主题后台地址和主题编辑器地址。

## 自定义命令

| 命令 | 说明 |
|---|---|
| `shop init` | 初始化 `shopify.theme.toml` |
| `shop dev` | 本地预览主题，完成后自动生成预览链接 |
| `shop async` | 本地预览并同步到主题编辑器 |
| `shop pre` | 输出预览链接与后台地址 |
| `shop help` / `shop --help` | 查看命令列表 |
| `shop version` / `shop --version` | 查看版本 |

## 原生命令

所有非自定义命令都会原样透传给 `@shopify/cli`，参数、输出、退出码保持一致。

```bash
shop theme pull
shop theme push
# …任意 shopify 命令
```
