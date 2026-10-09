# reachsey-agent-workflows

[English](README.md) | 中文

这是一个面向 DeepSeek Harness 的小型示例插件。它注册两个工具，让 agent（智能体）汇总某个目录中的文本文档并写入 Markdown 报告；所有文件访问都限制在一个配置目录内。

它遵循仓库自己的插件教程（[第一个插件](../../docs/user/develop/basic/index.zh.md)、[配置](../../docs/user/develop/basic/config.zh.md)、[工具编写参考](../../docs/cookbook/adding-a-tool.zh.md)）。该示例位于 `packages/` 之外，因此不是 workspace package，也不会发布。

> DeepSeek Harness 是实验性、未经审计的软件（见 [SAFETY.md](../../SAFETY.zh.md)）。本示例限制了自身的文件访问，但这不能替代在隔离环境中运行 harness。

## 工具

| 工具 | 写入文件 | 说明 |
|---|---|---|
| `rw_scan_documents` | 否 | 列出根目录下匹配的文档，包含字节数、行数、词数，以及每个文件的第一个标题。不会返回文件内容。 |
| `rw_generate_report` | 是 | 执行同样的扫描，并写入 `<reportDir>/<title-slug>.md`。 |

词数按空白分隔的 token 计算，因此 Markdown 中的 `#` 也算一个。跳过的条目（符号链接、过大文件、二进制文件或无法读取的文件）会附带原因列出。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `rootDir` | 必填 | 限制所有扫描和写入操作的绝对目录。相对路径会导致插件加载失败。 |
| `reportDir` | `reports` | 报告目录，相对于 `rootDir`。扫描时会排除该目录。 |
| `extensions` | `['.md', '.txt']` | 要包含的扩展名，匹配时不区分大小写。 |
| `maxFiles` | `200` | 扫描达到此数量时停止并报告 `truncated`（范围为 1 到 10000）。 |
| `maxFileBytes` | `1048576` | 跳过更大的文件（范围为 1 字节到 50 MiB）。 |
| `allowOverwrite` | `false` | 为 `false` 时，不会替换已有报告。 |

## 运行

请从已完成[从源码运行路径](../../README.zh.md#run-from-source)的仓库检出开始：

1. 复制 `workflows.patch.yml`，或直接编辑该文件，并替换两个 `/absolute/path/...` 占位符。插件路径必须是绝对路径。
2. 使用该 overlay 启动 Web UI：

   ```sh
   pnpm dsh web --patch ./examples/reachsey-agent-workflows/workflows.patch.yml
   ```

3. 向 agent 提出请求，例如：`Use rw_generate_report to summarize the docs folder as "Weekly Summary".`

`preset.patch.yml` 展示同一个插件作为专用 Agent preset 的子项。它遵循文档中介绍的 preset 结构，但尚未启动过。

## 安全模型

- 工具参数由模型生成。路径会相对于 `rootDir` 解析，并在符号链接解析后再次检查；绝对路径和 `..` 越界路径都会被拒绝。
- 扫描时不会跟随符号链接，并会跳过隐藏目录和 `node_modules`。
- 报告使用独占创建语义，因此除非 `allowOverwrite` 为 `true`，否则不会覆盖已有文件；目标位置存在符号链接时始终会被拒绝。只有在验证标题后才会创建目录。
- 报告只包含计数和每个文件的第一个标题，不包含文件正文。
- 本示例不包含凭据、网络访问或特定机器路径。 `/absolute/path/...` 值只是占位符。

## 验证

在仓库根目录执行 `pnpm install --frozen-lockfile --ignore-scripts` 后运行：

```sh
pnpm exec tsc -b examples/reachsey-agent-workflows/tsconfig.json
pnpm exec vitest run --root examples/reachsey-agent-workflows --config vitest.config.ts
pnpm exec tsx scripts/run-oxlint.ts examples/reachsey-agent-workflows
```

测试会挂载真实的 `ToolRuntime`，并通过其执行流水线调用两个工具。所有 I/O 都只发生在临时目录中。

## 故障排查

- **`rootDir must be an absolute path`**：插件拒绝加载；请使用绝对路径。
- **`outside the configured root`**：请求路径直接或通过符号链接越出了 `rootDir`。
- **`already exists`**：请选择其他标题，或设置 `allowOverwrite: true`。
- **`truncated: true`**：提高 `maxFiles`，或缩小扫描的 `path` 范围。
- **未显示工具**：请确认 overlay 中的插件路径是绝对路径，并指向 `src/index.ts`。

## 已知限制

- 尚未在 Web UI 中针对真实模型完成端到端运行；测试是直接驱动这些工具。
- 扫描器只读取 UTF-8 文本文件。Word、PDF 和电子表格文件不在支持范围内；仓库的文档包会分别处理这些格式。
