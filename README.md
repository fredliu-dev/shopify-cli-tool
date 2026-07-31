# shopify-cli-tool

对 [`@shopify/cli`](https://www.npmjs.com/package/@shopify/cli) 的二次封装：原样透传 shopify 命令，并在前后输出美化文案。

## 用法

```bash
npm link                # 注册全局命令
shopify-tool app dev    # 任意 shopify 命令原样透传
shopify-tool theme pull
shopify-tool --help     # 查看用法
```

## 依赖说明

| 包 | 作用 | 基本用法 |
|---|---|---|
| **@shopify/cli** | 被封装的目标 CLI | 不直接 import，通过子进程调用其 `bin` 脚本 |
| **picocolors** | 文本上色（绿/红/cyan/dim/bold） | `pc.green('done')` |
| **boxen** | 给文字画带边框的盒子 | `boxen('hi', {borderStyle:'round'})` |
| **gradient-string** | 渐变色文本 | `gradient('#a','#b')('text')` |
| **log-symbols** | ✓ ✖ ⚠ ℹ 图标 | `symbols.success`、`symbols.error` |

### @shopify/cli
被封装的目标。用子进程跑，彩色输出原样透传，退出码透传。  
定位入口：解析其 `package.json` 拿到 `bin` 字段（`./bin/run.js`），再用 `node` 运行该脚本——因为它的 `exports` 没暴露 `./bin/run.js` 子路径，不能直接 `require.resolve`。见 [src/runner.js](src/runner.js)。

```js
const child = spawn(process.execPath, [SHOPIFY_BIN, ...args], {
  stdio: 'inherit',                        // 透传 shopify 自己的输出
  env: { ...process.env, FORCE_COLOR: '1' },
})
```

### picocolors
最小最快的终端上色库。每个日志级别配一种颜色。见 [src/ui/logger.js](src/ui/logger.js)。

```js
import pc from 'picocolors'
console.log(pc.green('成功'), pc.red('失败'), pc.dim('次要信息'))
```

### boxen
给标题/banner 画带边框、内边距、对齐的盒子。见 [src/ui/banner.js](src/ui/banner.js)。

```js
import boxen from 'boxen'
boxen('标题', {
  padding: 1, margin: 1,
  borderStyle: 'round', borderColor: 'green',
  textAlignment: 'center',
})
```

### gradient-string
给品牌名做渐变色，提升 banner 质感。

```js
import gradient from 'gradient-string'
gradient('#95BE22', '#3B82F6')('Shopify Wrapper')
```

### log-symbols
跨平台的状态图标（自动带颜色），用在每条日志前。见 [src/ui/logger.js](src/ui/logger.js)。

```js
import symbols from 'log-symbols'
console.log(symbols.success, '完成')   // ✔ 完成
console.log(symbols.error, '失败')      // ✖ 失败
```

## 结构

```
src/
├── index.js        # 入口：按 argv[0] 匹配自定义命令，否则原样透传
├── runner.js       # 子进程调用 @shopify/cli
├── registry.js     # 自动扫描 commands/ 加载自定义命令（去重、排序、容错）
├── ui/
│   ├── banner.js   # boxen + gradient 横幅
│   ├── logger.js   # picocolors + log-symbols 日志
│   └── table.js    # 「命令 | 说明」表格
└── commands/       # 自定义命令：每个文件一套，丢进来即生效（自动发现）
    ├── version.js  # -v / --version
    └── help.js     # -h / --help（「自定义命令」表从注册表自动生成）
```
