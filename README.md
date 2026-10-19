<div align="center">
  <img width="64" height="64" alt="icon" src="https://github.com/user-attachments/assets/7d54f34d-f47e-4b77-a12c-b07e66b1e8d4" />
</div>



<h3 align="center">网页 AI 助手</h3>
<h3 align="center">让AI立即解答你的所有疑惑</h3>
<div align="center">
  <img alt="GitHub repo size" src="https://img.shields.io/github/repo-size/erenind/apweb">
  <img alt="GitHub language count" src="https://img.shields.io/github/languages/count/erenind/apweb">
  <img alt="GitHub top language" src="https://img.shields.io/github/languages/top/erenind/apweb">
  <img alt="GitHub Created At" src="https://img.shields.io/github/created-at/erenind/apweb">
  <img alt="GitHub forks" src="https://img.shields.io/github/forks/erenind/apweb">
  <img alt="GitHub Repo stars" src="https://img.shields.io/github/stars/erenind/apweb">
</div>

## [To English README](README.en.md)

## 电脑端演示视频

### 解释万物
https://github.com/user-attachments/assets/bc1f69f5-f8a5-4b61-b212-e5975ba94816
### AI翻译
https://github.com/user-attachments/assets/a72f4cf9-48de-4088-9aea-c83c496f4c6b




## 提示
- 回答质量与提示词和ai模型有关。
- 提示词可自定义
- 模型名称可任意填写
- temperature可自定义
- 按`ESC`可隐藏面板

**分支说明**：当前 `chrome_edge` 分支用于 Chrome / Edge 桌面版；Firefox 和 Firefox for Android 版本请使用 `main` 分支。


## 安装
### Edge（桌面版 121+）

1. 下载并解压本仓库的 `chrome_edge` 分支。
```sh
git clone -b chrome_edge https://github.com/erenind/apweb
```
2. 打开 `edge://extensions`，开启「开发人员模式」。
3. 点「加载解压缩的扩展」，选择包含 **`manifest.json`** 的仓库根目录。
4. 将扩展固定到工具栏，打开普通网页，点击扩展图标。

### Chrome（桌面版 121+）

1. 下载并解压本仓库的 `chrome_edge` 分支。
```sh
git clone -b chrome_edge https://github.com/erenind/apweb
```
2. 打开 `chrome://extensions`，开启「开发者模式」。
3. 点「加载已解压的扩展程序」，选择包含 **`manifest.json`** 的仓库根目录。
4. 将扩展固定到工具栏，打开普通网页，点击扩展图标。

> Chrome / Edge 选择的是整个文件夹，不是单独的清单文件或 Firefox 的 `.xpi`。
> 无需安装 Node.js、构建或修改清单。请保留加载的目录；更新代码后，在扩展管理页点
> 「重新加载」，再刷新正在使用插件的网页。

## 浏览器适配说明

| 分支 | 目标浏览器 | 后台方式 |
| --- | --- | --- |
| `chrome_edge`（当前） | Chrome / Edge 桌面版 121+ | MV3 Service Worker |
| `main` | Firefox / Firefox for Android | Firefox 后台事件页 |

本分支使用 Chrome / Edge 专用清单：只声明 `background.service_worker`，不包含 Firefox
专用的 `browser_specific_settings` 或 `background.scripts`。最低支持版本设为 121。
`src/background-worker.js` 按顺序加载语言、AI 核心和后台逻辑，全部使用经典脚本，无需构建。

扩展 API 使用 `browser ?? chrome`，异步消息通过 `sendResponse` + `return true` 回复，
兼容不支持 Promise 消息监听器的 Chromium 版本。流式请求进行期间，Service Worker 每
25 秒调用一次扩展 API，避免等待首个 token 或思考内容时因空闲而休眠；完成、失败、取消
或断开连接时停止保活。补注入已打开的标签页时，使用清单中的完整脚本列表，包含语言、
Markdown 和公式模块。

存储写入回声按递归排序后的数据比较，兼容 Chromium 返回对象时改变字段顺序的行为，
避免空白的历史快照覆盖正在生成的回复。

Chrome / Edge 共用划词提问、流式回复、Markdown / LaTeX、设置和对话保存实现。
设置、API Key 和聊天记录只在**当前浏览器配置文件**内共享，不会在不同浏览器之间自动同步。
`chrome://`、`edge://` 和扩展商店等受限页面无法显示面板。

## 首次使用
第一次使用：点工具栏上的图标打开面板 → 点 ⚙ → 选服务商、填 API Key → 「完成」。
也可以在 `chrome://extensions` 或 `edge://extensions` → 本扩展「详情」→「扩展程序选项」中配置，两处是同一份设置。

## 功能说明
- **API请求**: 走 **OpenAI 兼容**协议，所以 DeepSeek / OpenAI / Moonshot / 通义 / 智谱 / OpenRouter / 本地 Ollama 都能用。请求由浏览器直接发往你填的接口地址，**key 只存在本机**，不经过任何中转。
- **界面语言跟随浏览器**：`chrome.i18n.getUILanguage()` 是中文就用中文，其它一律用英文
  （取不到时退回 `navigator.language`；内容脚本里这一项由后台 Service Worker 随面板状态一起下发，
  因为内容脚本不一定有 i18n 权限）。**对话语言也跟着走**：默认提示词就是按当前语言发的，
  英文浏览器里默认助手会要求"write them in English"，划词默认动作也变成英文的
  "Explain and translate"。你自己改过的提示词不会被覆盖——只有仍是**出厂原文**的那些
  才会在语言切换时跟着换。没有面板内的语言开关，改语言就改浏览器语言。
- **开启划词即问**：点 ⚙ 打开设置，表单顶部是一个醒目的 `✦ 启动划词即问` 按钮，
  按下后变成实心绿色的 `✦ 划词即问 · 已开启`，下面一行小字说明当前行为；再点一下回到
  「选中后先弹出按钮，点按钮才发送」。它和下面的「划词提问」下拉是
  **同一个设置，保持同步**——按钮只在这两种模式之间切换；想彻底不提问（选中后什么都不做），
  只在下面的下拉里选「完全关闭」。
- **划词提问**：在任意网页上选中文字，旁边出现一个绿色按钮（默认显示选中内容要用的用途，
  例如「解释并翻译」），点它就会把这段文字发给模型。设置里可以改成「选中后自动提问」。
- **换「划词用途」会丢掉旧用途的上下文**：之前用另一种用途问过的回合不会再发给模型。
  否则那些回答就是一连串和新指令相矛盾的范例，模型会照着旧例继续——典型表现就是
  「从解释并翻译切到只解释，结果还是在解释+翻译」。同一种用途下的连续提问照旧带上下文。
- **对话面板**：点工具栏图标开关面板。输入框里 `Enter` 发送、`Shift+Enter` 换行。
  回答按 Markdown 渲染，可复制。
  思考模型返回的 `reasoning_content` 会显示成可折叠的「思考过程」。
- **只有浮动面板**：一个可拖动、可拉伸的卡片，没有「显示方式」这类设置。
- **位置和大小会记住**：拖动标题栏移动、拖动右下角的斜纹手柄调整大小，松手即保存；
  下次打开——包括划词自动打开——都会回到**上次的位置和上次的大小**。窗口变小后如果放不下，
  会自动往回收一点，保证整个面板都在屏幕内。
- **开合状态按标签页记住**：刚装好时面板是收起的，页面上只会在你划词时弹出小按钮；
  你在某个标签页打开它之后，**在这个标签页里翻页会保持打开**，而**切到别的标签页仍然默认收起**。
- **Esc 隐藏**：面板开着时按 Esc 收起，不管焦点在页面里还是在面板的输入框里。
- **输入框可折叠，收起时不占地方**：输入框**上边框的左上角**嵌着一个小箭头（向下），
  点一下输入框和发送按钮的高度动画归 0（连那条分隔线一起收掉），箭头翻成向上；再点展开、
  自动聚焦、草稿不丢。箭头是用 CSS 边框画的而不是字符，所以不挑字体；折叠状态会记住。
- **请求形状可调**：设置里有「发送 temperature 参数」开关和数值框（默认开、0.3），
  给那些拒收 `temperature` 的接口用——见下面 AI 章节的三道保险。
- **页面上下文**：默认只带**选中处所在的那一段**（可在设置里改成整个页面正文），
  而且**只有**在选中的是词或短句（不足 40 字）时才附带——一个词单独拿出来常有歧义，
  长句不附以省 token。面板里每条消息都会显示「上下文：…」，发出去什么一眼能看到。
- **只动选中的部分**：划词回合的用户消息里始终带一句「只处理下面引号内的文字，
  不要翻译页面正文」。这句不能改——它是防止整页被翻译的保险；你能改的是「划词提示词」
  里「要做什么」的那一句。


- **思考模式**按各家 API 真正接受的字段发送，并按**服务商**分别记住：

  | 服务商 | 关闭思考发的字段 | 限制 |
  | --- | --- | --- |
  | DeepSeek | `thinking: {type: "disabled"}` | — |
  | 智谱 GLM | `thinking: {type: "disabled"}` | **GLM-5.3 只能强制思考**，此时不发该字段 |
  | 通义 Qwen | `enable_thinking: false` | 仅 `qwen3` 系列接受 |
  | Kimi | `thinking: {type: "disabled"}` | 仅 `kimi-k2.6`；k3 只能强制思考 |
  | OpenAI | `reasoning_effort: "minimal"` | 仅 `gpt-5` 接受 |
  | Ollama / 自定义 | **不发送** | 不猜字段，猜错就是 400 |

- **接口地址只在服务商选「自定义」时出现**；预设服务商的地址由预设决定
  （加载时归一化、切换时重置），否则一个旧地址可能在你看不到的地方继续生效。
  自定义地址指向 `api.deepseek.com` 时仍然提供思考开关。
- **Temperature（默认 0.3）有三道保险**。有些模型只接受固定温度，发别的值直接 400：
  Moonshot 的 `kimi-k3` 只允许 1、`kimi-k2.6` 只允许 0.6，OpenAI 的 `gpt-5` 只支持默认
  值——这些在 `src/shared/ai.js` 的 `FIXED_TEMPERATURE` 表里，命中就**不发该字段**
  （发与不发等价，但服务端改默认值我们也不会再炸）；自定义地址指向 `api.moonshot.cn`
  时同样按 Moonshot 处理。
  第二道是**自动重试**：任何接口返回「temperature 被拒绝」这类 400（`deprecated` /
  `unsupported` / `only X allowed` / `invalid`）时，面板会**去掉该字段重试一次**，并把这个
  「接口地址 + 模型」记进 `temperatureOffSlots`，以后这个模型直接不发——所以像
  `https://modelsell.cc/v1` 的 `claude-fable-5` 这种"只认 1"的模型（实测 0.3 与 0 都是
  400，1 或省略才 200）不用你操心。
  第三道是设置里的**「发送 temperature 参数」开关 + 数值框**：表猜不到、自动重试也不适合
  的接口，你可以直接关掉这个字段，或把值改成服务端接受的那个。
- **API key 按「接口地址 + 模型」分别保存**，换模型／换服务商时 key 自动跟着换，
  设置里那行小字会写明当前 key 属于哪个模型。
- **两套提示词**（提问提示词 / 划词提示词）各自可改、可新建、可删除、可恢复默认，
  按**入口**分开；ids 稳定，改完切换不会丢。设置里的「提示词」区**默认折叠**，
  点一下展开；折叠状态在你切换/新建提示词导致表单重绘时也不会被重置。
- 回答渲染前一律过 **DOMPurify**，并且**图片一律丢弃**——模型能读到网页内容，
  而网页可以诱导模型输出 HTML，一张远程 `<img>` 就等于一个能被网页控制的追踪像素；
  `javascript:` 链接会被剥掉，正常链接一律 `target="_blank" rel="noopener noreferrer nofollow"`。
- **数学公式会渲染**：交给 **KaTeX**（JS + 官方 CSS + `.woff2` 字体，随扩展一起打包、
  离线可用），输出用的是它的 **HTML 渲染**——也就是 `htmlAndMathml`：看得见的那一半是
  KaTeX 自己的排版（配合它的样式表和字体，和官方预览一致），另一半是隐藏的 MathML 副本，
  供读屏使用。**不要退回纯 MathML 输出**：那个版本没有自带样式，实测在 Firefox 里又小又扁
  （见下）。
  识别范围覆盖模型真正会写的样子：行内 `$…$` / `\(…\)`、独立成行 `$$…$$` / `\[…\]`、
  裸的 `\begin{align}` 等 17 种环境，以及 **info 字符串为 `latex`/`math`/`tex` 的代码围栏**
  （普通代码围栏仍是代码）。`\$`、`$5 and $10`、行内代码里的 `$` 都不会被误认。
  顺序是「先把公式换成占位符 → 过 marked 和 DOMPurify → 再把 KaTeX 产物填回去」，
  这样 DOMPurify 的白名单不必为公式开口子；写坏的公式会渲染成一行红字而不会报错。

- **划词默认不自动发**。；在开放网页上，选中文字往往只是想复制，所以这里的默认是「选中后显示按钮，点击提问」。
- **上下文从「当前页 PDF 正文」换成**「选中处所在的那一段」（可切到整页正文），
  页面标题和 URL 会一并附上，方便模型知道你在看什么。
- **设置存在 `chrome.storage.local`**，面板在任意网页都能读到同一份；key 不再是每个站点一份。
- **设置和对话都只写纯数据**。面板为了流式更新会把 DOM 节点挂在内存里的消息对象上，而 DOM 节点
  不可结构化克隆——直接写整份对象会让 `storage.set` 失败、整段历史都存不下来，所以落盘前会先
  把消息压成 `role`/`content`/`context`… 这几个字段。
- **网页内面板、首选项页、其它标签页默认保持同步**：它们共用这一份 storage，
  任一处改动都会通过 `storage.onChanged` 推给其它处（自己写入的回声会被识别并忽略，
  不会因为重放自己而多渲染一次，也不会被稍后到达的旧回声覆盖掉新状态）。
- 面板用 **Shadow DOM** 隔离，样式不会和网页互相污染。

## 已知取舍

- **需要 `host_permissions: <all_urls>`**：既要往任意服务商/自建中转发请求，又要在任意网页
  注入面板和划词按钮，所以权限比较宽。安装时浏览器会明确提示。
- **受目标服务的 CORS 策略限制**：请求从后台 Service Worker 发出（不是从网页），正常不受网页 CORS 影响；
  但服务商若拒绝浏览器直连，会看到「连不上这个接口」。
- **受限页面没有面板**：`chrome://`、`edge://`、扩展商店等页面无法注入。
  在扩展刚安装前就开着的标签页，第一次点工具栏会**按需注入**内容脚本，之后正常。
- **严格 CSP 的网站**：面板样式通过影子根里的 `<link>` 加载扩展内 CSS；极少数 CSP
  极严的站点可能加载失败（面板会变得朴素但功能仍在）。
- **对话记录是全局一份**（和 Reader 一样只有一个会话），不是每个站点各自一份；
  多个标签页同时聊天会互相覆盖（这一份现在会在各处实时同步）。
- **面板是浮动的，会盖住那一小块内容**；它不会把网页挤开。
- **面板会跟着网页缩放一起变大**（它就是画在页面里的）。这条以前靠反向缩放抵消过，但放大时
  会把面板整体推出页面右侧，所以去掉了。
- **面板尺寸全部用绝对 `px` 写死，不用 `rem`**。`rem` 在影子树里仍然以网页的 `<html>`
  字号为基准，所以遇到 `html{font-size:62.5%}` 这类页面，面板的字会缩成一半——这正是
  「在某个缩放页面下面板字体很小」的成因（测试里有一条断言盯着这件事）。
- **浮动面板的开合状态按标签页存在 `storage.session`**：新标签页默认收起，同一个标签页里翻页
  保持，关标签页时清掉。
- **位置/大小是全局一份**（`panelRect`，存在 `storage.local`），不是每个站点各自一套。
- 还差什么：没有全文翻译整页、没有右键菜单、没有联网 OCR——这些是后续可能的方向。

## 结构

| 路径 | 作用 |
| --- | --- |
| `manifest.json` | Chrome / Edge MV3 清单：Service Worker、内容脚本、工具栏按钮、选项页 |
| `src/shared/ai.js` | Reader `src/lib/ai.js` 的移植：服务商、思考开关、提示词、流式客户端 |
| `src/shared/i18n.js` | 界面与对话语言：zh/en 两份文案表，按浏览器语言取用（每个宿主都必须最先加载它） |
| `src/shared/math.js` | LaTeX 抽取：把公式换成占位符、渲染后填回（`test/logic.test.js` 覆盖边界情况） |
| `src/shared/markdown.js` | Reader `src/lib/markdown.js` 的移植：marked + DOMPurify |
| `src/shared/store.js` | Reader `src/lib/chat-storage.js` 的移植：设置/消息持久化与归一化 |
| `src/background.js` | 共用后台：发请求（绕开网页 CORS）、流式回传、工具栏按钮、每标签页面板状态 |
| `src/background-worker.js` | Chrome / Edge Service Worker 入口，按顺序载入共用后台模块 |
| `src/content/content.js` | 内容脚本：影子根、划词检测、「问 AI」浮动按钮、页面上下文提取、Esc 收起 |
| `src/content/panel.js` | 对话面板 + 设置表单（Reader `ChatPanel.vue`/`ChatSettingsForm.vue` 的 DOM 重写） |
| `src/content/panel.css` | 面板样式（影子根里加载，选项页也复用） |
| `src/options/options.html` | 首选项页：复用同一个面板 |
| `test/` | 三个零依赖测试（node 内置模块），见下面「验证」 |
| `web-ext-config.mjs` | `web-ext lint` / `build` 的忽略清单（把测试和文档排除在打包外） |
| `LICENSE` | [PolyForm Noncommercial 1.0.0](LICENSE)：非商业免费，商业使用需另行授权 |
| `vendor/` | `marked`、`DOMPurify`（来自 Reader 的 node_modules）与 KaTeX（JS + CSS + `.woff2` 字体），版本与许可见 `vendor/LICENSES.md` |
| `icons/` | 图标：`icon.svg` 是真源，`icon-*.png` 由它生成 |


**纯 DOM + 原生 JS**，逻辑（`ai.js` / `store.js` / `markdown.js`）以经典脚本
（挂在 `globalThis` 上）在后台 Service Worker 和内容脚本之间共用，`node --check` 与下面那套
测试即可保证质量。

## icon设计
改完 `icons/icon.svg` 之后重新生成 PNG：

```sh
for s in 16 32 48 96; do
  magick -background none -density 384 icons/icon.svg -resize ${s}x${s} icons/icon-$s.png
done
```

## 测试

仓库里带了三个**零依赖**的测试（只用 node 内置模块），不需要 npm install：

```sh
node test/logic.test.js       # 服务商/思考开关/key 槽位/提示词/消息上限等纯逻辑
node test/panel.test.js       # 面板构建、设置表单、流式回合、划词→按钮→提问、拖动/拉伸、Esc
node test/background.test.js  # Chrome / Edge 后台：状态、消息、注入、流式请求及保活清理
```

`panel.test.js` 用一个手写的小型 DOM（带真实的捕获/冒泡 + `stopPropagation` 语义）
加一个假的 WebExtension 端口，跑的是**真实的** `panel.js` / `content.js` / `store.js` /
`ai.js`，覆盖：流式回合、划词→按钮→提问、拖动改位置与「松手就结束拖动」、
位置与大小的保存/还原、Esc 收起、开合状态、划词即问开关、跨界面同步，以及「消息落盘只有纯数据」
这类回归。所有测试仅提供 `chrome` API；`background.test.js` 在无 DOM 的 Chromium Worker 环境中，
用桩覆盖异步消息、状态跨后台重启保留、脚本补注入，以及流式请求完成/报错/取消/断开后的保活清理。
它们**不覆盖**
真实浏览器里的样式、DOMPurify 的净化结果
和 Shadow DOM 行为——这三点需要在各目标浏览器里手动检查。

本次适配已在 Chromium 152 中验证扩展加载、设置页、面板状态恢复、流式回复、Markdown /
LaTeX 渲染、聊天记录保存及停止生成；关闭 Worker 调试连接后，等待 35 秒才收到响应头的
本地模拟接口也能完成回复。Edge 尚未单独实机验证。

可以用 [`web-ext`](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/)
打包及辅助静态检查（`web-ext-config.mjs` 配置打包忽略项）：

```sh
nix-shell -p nodejs web-ext --run 'web-ext lint'      # Firefox 静态检查，见下方适用范围
nix-shell -p nodejs web-ext --run 'web-ext build'     # 打包成 zip
```

`web-ext lint` 面向 Firefox：本分支会报告 `BACKGROUND_SERVICE_WORKER_NOFALLBACK`、
`ADDON_ID_REQUIRED` 两个 Firefox 兼容性错误，以及缺少 Firefox 数据收集声明和两处
`UNSAFE_VAR_ASSIGNMENT` 警告；后两处来自 DOMPurify 及已净化 Markdown 的 `innerHTML` 赋值。
它不能替代 Chrome / Edge 的实际加载验证。修改后请在扩展管理页检查错误，并验证工具栏开关、
划词提问、设置保存、流式回复和停止生成。打包后的 zip 可用于分发；本地加载前需先解压。

## 许可证

本项目采用 [PolyForm Noncommercial License 1.0.0](LICENSE)（全文见 `LICENSE`）：

- **个人 / 非商业使用免费**：个人学习、研究、实验、私人娱乐、业余爱好，以及慈善组织、
  教育机构、公共科研、公共安全与卫生、环保与政府机构的使用，都按许可证原文免费，
  可以自己修改、也可以分发副本（分发时把 `LICENSE` 一起带上）。
- **商业使用需要授权**：带商业目的的用法——公司内部生产工具、对外售卖、托管成
  SaaS、随自有产品分发、为客户定制等——需要事先拿到书面的商业许可。请联系仓库主页
  （GitHub Issues 或主页邮箱）说明用途。
- `vendor/` 里的第三方库（`marked` MIT、`DOMPurify` MPL-2.0 或 Apache-2.0、KaTeX
  MIT）仍按各自原许可证授权，与上面的条款无关，见 `vendor/LICENSES.md`。

这不是 OSI 认可的开源许可证，属于「源码可见」（source-available）：源码可以看、
可以改、可以自己用，但商用要单独谈。
