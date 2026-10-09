# reachsey-agent-workflows

A small example plugin for DeepSeek Harness. It registers two tools that let an agent summarize a directory of text documents and write a Markdown report, with every file access confined to one configured directory.

It follows the repository's own plugin tutorials ([first plugin](../../docs/user/develop/basic/index.md), [configuration](../../docs/user/develop/basic/config.md), [tool authoring](../../docs/cookbook/adding-a-tool.md)). It is an example outside `packages/`, so it is not a workspace package and is not published.

> DeepSeek Harness is experimental, unaudited software (see [SAFETY.md](../../SAFETY.md)). This example limits its own file access, but that is not a substitute for running the harness in an isolated environment.

## Tools

| Tool | Writes files | What it does |
|---|---|---|
| `rw_scan_documents` | no | Lists matching documents under the root with byte, line and word counts and each file's first heading. File contents are not returned. |
| `rw_generate_report` | yes | Runs the same scan and writes `<reportDir>/<title-slug>.md`. |

Words are whitespace-separated tokens, so a Markdown `#` counts as one. Skipped entries (symlinks, oversized, binary or unreadable files) are listed with a reason.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `rootDir` | required | Absolute directory that confines every scan and write. A relative value fails the plugin load. |
| `reportDir` | `reports` | Report directory, relative to `rootDir`. It is excluded from scans. |
| `extensions` | `['.md', '.txt']` | Extensions to include, matched case-insensitively. |
| `maxFiles` | `200` | Scan stops and reports `truncated` at this count (1 to 10000). |
| `maxFileBytes` | `1048576` | Larger files are skipped (1 byte to 50 MiB). |
| `allowOverwrite` | `false` | When `false`, an existing report is never replaced. |

## Run it

From a repository checkout that completed the [run-from-source path](../../README.md#run-from-source):

1. Copy `workflows.patch.yml`, or edit it in place, and replace both `/absolute/path/...` placeholders. The plugin path must be absolute.
2. Start the Web UI with the overlay:

   ```sh
   pnpm dsh web --patch ./examples/reachsey-agent-workflows/workflows.patch.yml
   ```

3. Ask the agent, for example: `Use rw_generate_report to summarize the docs folder as "Weekly Summary".`

`preset.patch.yml` shows the same plugin as a child of a dedicated Agent preset. It follows the documented preset shape but has not been booted.

## Security model

- Tool arguments are model-generated. Paths are resolved against `rootDir` and re-checked after symlink resolution; absolute paths and `..` escapes are refused.
- Symlinks are never followed during a scan, and hidden directories and `node_modules` are skipped.
- Reports are created with exclusive-create semantics, so an existing file is not overwritten unless `allowOverwrite` is `true`; a symlink at the target is always refused. The title is validated before any directory is created.
- Reports contain counts and the first heading of each file, never file bodies.
- The example contains no credentials, network access or machine-specific paths. The `/absolute/path/...` values are placeholders.

## Validate

Run from the repository root after `pnpm install --frozen-lockfile --ignore-scripts`:

```sh
pnpm exec tsc -b examples/reachsey-agent-workflows/tsconfig.json
pnpm exec vitest run --root examples/reachsey-agent-workflows --config vitest.config.ts
pnpm exec tsx scripts/run-oxlint.ts examples/reachsey-agent-workflows
```

The tests mount the real `ToolRuntime` and call both tools through its execution pipeline. The only I/O is a temporary directory.

## Troubleshooting

- **`rootDir must be an absolute path`**: the plugin refuses to load; use an absolute path.
- **`outside the configured root`**: the requested path escaped `rootDir`, directly or through a symlink.
- **`already exists`**: choose another title or set `allowOverwrite: true`.
- **`truncated: true`**: raise `maxFiles` or scan a narrower `path`.
- **No tools appear**: confirm the overlay's plugin path is absolute and points at `src/index.ts`.

## Known limitations

- Not run end to end against a live model in the Web UI; the tests drive the tools directly.
- The scanner reads UTF-8 text only. Word, PDF and spreadsheet files are out of scope; the repository's document packages handle those separately.
