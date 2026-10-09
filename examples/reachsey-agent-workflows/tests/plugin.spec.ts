import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Workflows from '../src/index.ts'
import type { Config } from '../src/index.ts'

// Configuration enters as untrusted records. Parse it through the plugin schema instead of asserting through unknown.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isConfig(value: unknown): value is Config {
  if (!isRecord(value)) return false
  return typeof value.rootDir === 'string'
    && typeof value.reportDir === 'string'
    && Array.isArray(value.extensions)
    && value.extensions.every((extension: unknown) => typeof extension === 'string')
    && typeof value.maxFiles === 'number'
    && typeof value.maxFileBytes === 'number'
    && typeof value.allowOverwrite === 'boolean'
}

const parseConfig = (value: Record<string, unknown>): Config => {
  const parsed: unknown = Reflect.apply(Workflows.Config, undefined, [value])
  if (!isConfig(parsed)) throw new TypeError('Plugin configuration schema returned an invalid value.')
  return parsed
}

let root: string
const signal = new AbortController().signal

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'rw-plugin-'))
  await writeFile(path.join(root, 'notes.md'), '# Notes\n\nhello world\n')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function mount(config: Record<string, unknown>): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Workflows, parseConfig(config))
  return ctx
}

describe('reachsey-agent-workflows plugin', () => {
  it('exports the Cordis plugin shape and fills schema defaults', () => {
    expect(Workflows.name).toBe('reachsey-agent-workflows')
    expect(Workflows.inject).toEqual(['tools'])
    // A default export would make the Loader unwrap only `apply` and drop `inject`.
    expect('default' in Workflows).toBe(false)
    expect(parseConfig({ rootDir: root })).toMatchObject({
      reportDir: 'reports', extensions: ['.md', '.txt'], maxFiles: 200, allowOverwrite: false,
    })
    expect(() => parseConfig({})).toThrow()
    expect(() => parseConfig({ rootDir: root, maxFiles: 0 })).toThrow()
  })

  it('registers both tools and unregisters them when the plugin fiber is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin(Workflows, parseConfig({ rootDir: root }))
    try {
      expect(ctx.tools.schemas().map(schema => schema.name).toSorted()).toEqual(['rw_generate_report', 'rw_scan_documents'])
      await fiber.dispose()
      expect(ctx.tools.schemas()).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('scans through the real tool pipeline', async () => {
    const ctx = await mount({ rootDir: root })
    try {
      const result = await ctx.tools.execute({ signal, callId: ToolCallId('scan'), name: 'rw_scan_documents', arguments: {} })
      if (result.isError) throw new Error(JSON.stringify(result.content))
      expect(result.value).toMatchObject({ files: [{ path: 'notes.md', heading: 'Notes', words: 4 }], truncated: false })
      expect(JSON.stringify(result.content)).toContain('notes.md')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('writes a report once and reports a refusal as an error result the second time', async () => {
    const ctx = await mount({ rootDir: root })
    try {
      const args = { title: 'Weekly Summary' }
      const first = await ctx.tools.execute({ signal, callId: ToolCallId('r1'), name: 'rw_generate_report', arguments: args })
      if (first.isError) throw new Error(JSON.stringify(first.content))
      expect(first.value).toEqual({ reportPath: 'reports/weekly-summary.md', documents: 1, skipped: 0, truncated: false })
      expect(await readFile(path.join(root, 'reports', 'weekly-summary.md'), 'utf8')).toContain('| notes.md |')
      const second = await ctx.tools.execute({ signal, callId: ToolCallId('r2'), name: 'rw_generate_report', arguments: args })
      expect(second.isError).toBe(true)
      expect(JSON.stringify(second.content)).toContain('already exists')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('turns an escaping path argument into an error result', async () => {
    const ctx = await mount({ rootDir: root })
    try {
      const result = await ctx.tools.execute({ signal, callId: ToolCallId('esc'), name: 'rw_scan_documents', arguments: { path: '../..' } })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('outside the configured root')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects a relative rootDir while the plugin loads', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await expect(ctx.plugin(Workflows, parseConfig({ rootDir: 'relative/dir' }))).rejects.toThrow(/absolute/)
    await ctx.fiber.dispose()
  })
})
