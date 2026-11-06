# 沉眠阁 · slumberpavilion

把 DSH 里「已归档」的会话**真正搬出加载路径**，并内置读取归档内容的能力。

沉眠阁保持极简、免配置：安装并加载后即可使用，不提供独立的用户配置界面，也不需要用户设置参数。
**自动搬移是插件的设计行为**：加载约 15 秒后首次扫描，后台按 20 秒间隔检查归档列表，
把已归档会话的日志目录和投影记录从 `~/.dsh` 移至 `~/DSH-Archive`；使用 `DSH_HOME`
的宿主则从该目录读取。搬移保留原文和还原清单；`archive_delete` 是单独的永久删除操作，
**不可恢复，工具调用没有二次确认**。

## 它为什么需要存在

DSH 的「归档」只是一个标签，写进 `storages/workspace.json` 的 `archivedSessionIds`。
官方 `archived-session-gate` 的原话是：

> an archived Session ... must not run a model step until it is restored.

它拦的是**能不能跑**，不是**占不占地方**。归档之后：

- 会话日志仍留在 `.dsh/sessions/<工作区>/<会话id>/`
- 投影记录仍留在 `.dsh/storages/session_projcache/sessions/<id>.json`

而 `session_projcache` 用的是 JSON 存储后端，官方注释写明「读写共享存储域内一致的内存状态」——
**全部记录常驻内存**。实测：2395 条记录 / 169.5 MB JSON，其中 126 条已归档的占 40.8 MB（24.1%），
而它们只占条目数的 5%。归档的大多是长篇会话，正是最占地方的那批。

本插件做三件事：

1. 每隔一段时间检查 `archivedSessionIds`，发现新归档的会话
2. 把它的日志目录与投影记录**移动**到 `~/DSH-Archive`（不是删除）
3. `manifest.json` 记下来源与去向，随时可还原

## 兼容性

- 声明的 DSH 宿主范围为 `>=0.2.1-rc.2 <0.4.0-0`；已记录的桌面实测版本仅为
  **DSH 0.2.1-rc.3**。范围声明不代表其他版本均已完成实测。
- Node.js 要求 `>=22.15.0`，用于读取 zstd 会话日志；桌面版以其内置 Node.js 为准。
- 插件依赖宿主的 `tools`、`workspaceRegistry` 服务，以及 `sessions`、
  `storages/workspace.json` 和 `storages/session_projcache/sessions` 的内部布局。
  宿主改变这些接口或文件布局时，需要重新验证兼容性。
- `package.json` 在 `dsh.engines.dsh` 声明宿主范围，并在顶层 `engines.dsh` 保留同值，
  供兼容读取使用；这两处都是发布元数据，无需用户配置。

## 安装

在 DSH 插件商店安装沉眠阁并由宿主加载即可，无需填写配置或修改插件参数。
手动集成到 profile 时，在该 profile 目录安装 npm 包：

```bash
npm install slumberpavilion
```

然后在 profile 的 `package.json` 里把包装进 bundles：

```json
"dependencies": {
  "slumberpavilion": "^0.1.1"
},
"dsh": {
  "profile": {
    "bundles": [
      "...",
      "slumberpavilion"
    ]
  }
}
```

重启 DSH。本地开发时可以用 `file:` 依赖 + 一条符号链接代替 npm 安装：

```bash
ln -s ../plugins/slumberpavilion ~/.dsh/profiles/desktop/node_modules/slumberpavilion
```

## 安装后的行为

归档搬移默认自动进行，无需额外启用。插件只搬移已被 DSH 标记为归档的会话，
不会由后台扫描主动归档普通会话。`~/DSH-Archive/manifest.json` 记录原路径与归档路径，
可通过 `archive_list` 查看，再用 `archive_read` 读取或 `archive_restore` 搬回。

源码中的 `Config` schema 与 `cordis.patch.yml` 参数用于 Cordis 宿主装配、内部实现和测试，
并不代表本插件提供了用户设置界面。`volatile` 是宿主侧参数的标记，不是要求用户修改参数。
内部日志搬移与投影搬移逻辑分别判断，默认都会执行；正常使用无需选择或调整它们。

## 读取归档

### 方式一：命令行（不依赖 DSH，随时可用）

```bash
node lib/cli.js list 20
node lib/cli.js read f8ab825e 上下文压缩 50
node lib/cli.js info f8ab825e
```

### 方式二：Agent 工具

注册五个工具，对话里可直接调用：

| 工具 | 作用 |
|---|---|
| `archive_list` | 列出归档会话（按体积降序） |
| `archive_read` | 读一个归档会话；`keyword` 过滤、`compact` 只留对话轮次、`maxChars` 逐条截断 |
| `archive_session` | **执行归档**：标记 + 立刻搬走，不用等后台扫描；先 `dryRun=true` 看清目标 |
| `archive_restore` | **还原归档**：搬回 `.dsh`、撤销归档标记、清清单；同样支持 `dryRun` |
| `archive_delete` | **永久删除**一个归档会话（日志 + 投影文件 + 清单条目）：**不可恢复，且工具调用没有二次确认**；调用前务必先跑 `dryRun=true` |

`archive_session` 走的是宿主的 `ctx.workspaceRegistry.archiveSession()`，所以归档状态
是 DSH 自己写进 `workspace.json` 的，不靠手改文件；标记落盘后插件立刻 `sweep()` 一轮，
把日志与投影搬进归档区，返回里会报出最终目录。

- 只认唯一命中：ID 或片段模糊命中多条时**拒绝执行**并列出候选，免得搬错会话。
- 活跃会话默认拒绝（`WorkspaceActiveSessionError`）；确认要归档正在跑的会话，加
  `stopActivity=true`，宿主会先请求停掉它的工作再归档。
- 拒绝归档「正在执行这条工具的那个会话」，不然等于自断。

`archive_restore` 是它的逆操作，顺序是「搬文件 → `unarchiveSession()` → 清清单」：

- 目标位置已有同名目录时**拒绝**，让你先确认是不是重复还原。
- 清单里记着原始的 `from`，还原优先搬回原位；没有记录时退回
  `.dsh/sessions/<工作区>/<会话 ID>`。
- 投影记录（`projcache`）跟着一起搬回；目标已存在的不覆盖。
- 撤销标记失败时仍然搬文件，并在返回里明确警告「它仍算已归档，请在界面取消归档」。

这层曾经整个是哑的，原因是三个叠在一起的问题，现在都修了：

1. **没有声明 `inject`**。Cordis 里不 `export const inject = ["tools"]` 就读不了
   `ctx.tools`，一读抛 `cannot get property "tools" without inject`；原来的代码把这句
   写在 `try` 里，异常被吞掉，只剩一条 warn，工具永远静默缺席。
2. **`await import("@deepseek-ai/dsh-tools")` 解析不到**。这个包只随宿主打包在
   `app.asar` 里，profile 的 `node_modules` 没有它，Node 的 ESM 解析器又不认 asar。
   改用 `createRequire(import.meta.url)`（Electron 主进程认得 asar 路径），同步取。
3. **工具定义形状不对**。`defineTool` 收的是「属性表」，必填用 `required: true` 标在
   属性上；`output.render(args, value)` 必须返回 `ContentBlock[]`。原来传的是完整
   JSON Schema、`render` 直接返回字符串。

取不到 `defineTool` 时还有一层本地兜底：`normalizeToolDefinition()` 自己把属性表
展开成完整 JSON Schema，所以换机器/换宿主也不会两头空。

> 排障：插件往 `%TEMP%\slumber-pavilion-diag.log` 记一行 apply、一行
> defineTool 是否取到、每个工具是否注册成功。改了代码重载插件后先看这个文件。

## 还原

两种方式，效果一样：

- 对话里 `archive_restore`（推荐）：搬文件、撤销标记、清清单一次做完，先跑 `dryRun` 看目标。
- 手动：`manifest.json` 里每个条目都记着 `from`（原路径）与 `to`（归档路径），把 `to` 移回
  `from`，再去界面里取消归档、从清单删掉那一条。

## 已知边界

- **扫描只处理「已归档」的会话**。归档标记由 DSH 写；`archive_session` 只是替你把这个
  标记写进去，然后立刻搬文件。
- 移动后 `workspace.json` 里的 `archivedSessionIds` 不会清理，指向一个不存在的会话。
  实测这不影响启动（列表按投影记录渲染，记录没了就不显示）。
- 若会话日志已被 DSH 重新折叠出新的投影记录，下次扫描会再搬一次。
- 「已搬过」的判据覆盖**顶层与各批次目录**的 `manifest.json`。早先只读顶层那份，老批次
  条目会被当成没搬过、每轮空转一次；现在不会了。
- `archive_session` 只认磁盘上还在 `.dsh/sessions` 里的会话；只剩归档副本的请用
  `archive_list` / `archive_read`。

## 为什么解压要手写

DSH 的 `session.v4.jsonl.zstd` 是**多帧** zstd（边写边追加，每追加一次一个独立帧）。
Node 的 `zstdDecompressSync` 和 `createZstdDecompress` 都只解第一帧就收工——
实测 1.1 MB 只解出 285 字节，恰好是会话头。

所以 `reader.js` 按帧魔数 `28 B5 2F FD` 切开逐个解，切错就往后找下一个魔数重试。
实测那个 60.6 MB 的会话：**31,528 帧，56,701 行，零失败**，压缩比约 ×3.8。

## License

MIT
