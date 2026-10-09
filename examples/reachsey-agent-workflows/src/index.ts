import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { renderReport, scanDocuments, validateTitle, writeReport } from './documents.ts'
import type { ScanResult } from './documents.ts'

export const name = 'reachsey-agent-workflows'
export const inject = ['tools']

export interface Config {
  rootDir: string
  reportDir: string
  extensions: string[]
  maxFiles: number
  maxFileBytes: number
  allowOverwrite: boolean
}

export const Config: Schema<Config> = Schema.object({
  rootDir: Schema.string().required(),
  reportDir: Schema.string().default('reports'),
  extensions: Schema.array(Schema.string()).default(['.md', '.txt']),
  maxFiles: Schema.number().min(1).max(10_000).default(200),
  maxFileBytes: Schema.number().min(1).max(50 * 1024 * 1024).default(1024 * 1024),
  allowOverwrite: Schema.boolean().default(false),
})

const SCAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    files: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          bytes: { type: 'number', required: true },
          lines: { type: 'number', required: true },
          words: { type: 'number', required: true },
          heading: { type: 'string', required: true },
        },
      },
    },
    skipped: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          reason: { type: 'string', required: true, enum: ['symlink', 'too-large', 'binary', 'unreadable'] },
        },
      },
    },
    truncated: { type: 'boolean', required: true },
  },
} as const

function summarize(scan: ScanResult): string {
  const lines = [`${scan.files.length} document(s)${scan.truncated ? ' (truncated at the file limit)' : ''}, ${scan.skipped.length} skipped.`]
  for (const file of scan.files) lines.push(`${file.path}: ${file.bytes} bytes, ${file.lines} lines, ${file.words} words`)
  for (const entry of scan.skipped) lines.push(`skipped ${entry.path}: ${entry.reason}`)
  return lines.join('\n')
}

export function apply(ctx: Context, config: Config) {
  if (!path.isAbsolute(config.rootDir)) {
    throw new Error(`${name}: rootDir must be an absolute path.`)
  }
  const limits = { root: config.rootDir, extensions: config.extensions, maxFiles: config.maxFiles, maxFileBytes: config.maxFileBytes, excludeDir: config.reportDir }

  ctx.tools.register(defineTool({
    name: 'rw_scan_documents',
    description: 'Read-only. List text documents under the configured document root with byte, line and word counts and each file\'s first heading. File contents are not returned.',
    parameters: {
      path: { type: 'string', description: 'Directory relative to the configured root. Defaults to the root itself.' },
    },
    output: {
      schema: SCAN_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: summarize(value) }],
    },
    async execute(args, exec) {
      return scanDocuments({ ...limits, relPath: args.path ?? '.', signal: exec.signal })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'rw_generate_report',
    description: 'Scan documents under the configured root and write a Markdown summary report into the configured report directory. Never overwrites an existing report unless the deployment allows it.',
    parameters: {
      title: { type: 'string', required: true, description: 'Report title; it also names the report file.' },
      path: { type: 'string', description: 'Directory relative to the configured root to summarize. Defaults to the root itself.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reportPath: { type: 'string', required: true },
          documents: { type: 'number', required: true },
          skipped: { type: 'number', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Wrote ${value.reportPath} covering ${value.documents} document(s); ${value.skipped} skipped${value.truncated ? '; truncated at the file limit' : ''}.`,
      }],
    },
    async execute(args, exec) {
      const title = validateTitle(args.title)
      const relPath = args.path ?? '.'
      const scan = await scanDocuments({ ...limits, relPath, signal: exec.signal })
      exec.signal.throwIfAborted()
      const content = renderReport(title, relPath, scan, new Date().toISOString())
      const reportPath = await writeReport({
        root: config.rootDir, reportDir: config.reportDir, title, content, allowOverwrite: config.allowOverwrite,
      })
      return { reportPath, documents: scan.files.length, skipped: scan.skipped.length, truncated: scan.truncated }
    },
  }))
}
