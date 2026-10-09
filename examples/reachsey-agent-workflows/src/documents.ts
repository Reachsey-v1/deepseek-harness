import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Machine-readable failure classes for the document workflow. */
export type WorkflowErrorCode = 'path-escape' | 'not-found' | 'not-a-directory' | 'exists' | 'invalid-title'

/** A refusal the workflow raises on purpose; the tool registry reports it to the model as an error result. */
export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode

  constructor(code: WorkflowErrorCode, message: string) {
    super(message)
    this.name = 'WorkflowError'
    this.code = code
  }
}

/** Per-file statistics. Only counts and the first heading leave the file; its content is never echoed. */
export interface DocumentStats {
  path: string
  bytes: number
  lines: number
  words: number
  heading: string
}

export type SkipReason = 'symlink' | 'too-large' | 'binary' | 'unreadable'

export interface SkippedEntry {
  path: string
  reason: SkipReason
}

export interface ScanResult {
  files: DocumentStats[]
  skipped: SkippedEntry[]
  truncated: boolean
}

export interface ScanOptions {
  /** Absolute directory every access is confined to. */
  root: string
  /** Directory to scan, relative to `root`. */
  relPath: string
  /** Extensions including the dot, such as `.md`; matched case-insensitively. */
  extensions: readonly string[]
  maxFiles: number
  maxFileBytes: number
  /** Directory (relative to `root`) that holds generated reports; it is never scanned. */
  excludeDir?: string
  signal?: AbortSignal
}

const MAX_HEADING_LENGTH = 120
const MAX_TITLE_LENGTH = 120

function isOutside(relative: string): boolean {
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/')
}

/**
 * Resolve `relPath` under `root` and prove, after symlink resolution, that the result stays inside `root`.
 * @param root - absolute confinement directory.
 * @param relPath - caller-supplied relative path.
 * @returns the real absolute path of the target.
 * @throws {WorkflowError} when the path is absolute, escapes the root, or does not exist.
 */
export async function resolveInside(root: string, relPath: string): Promise<string> {
  if (path.isAbsolute(relPath)) {
    throw new WorkflowError('path-escape', 'Absolute paths are not accepted; pass a path relative to the configured root.')
  }
  const realRoot = await realpath(root)
  const candidate = path.resolve(realRoot, relPath)
  if (isOutside(path.relative(realRoot, candidate))) {
    throw new WorkflowError('path-escape', 'The path resolves outside the configured root.')
  }
  let real: string
  try {
    real = await realpath(candidate)
  } catch {
    throw new WorkflowError('not-found', `The path does not exist under the configured root: ${toPosix(relPath)}`)
  }
  if (isOutside(path.relative(realRoot, real))) {
    throw new WorkflowError('path-escape', 'The path resolves outside the configured root.')
  }
  return real
}

function computeStats(relative: string, bytes: number, text: string): DocumentStats {
  const lines = text.length === 0 ? 0 : text.split(/\r?\n/).length - (/\r?\n$/.test(text) ? 1 : 0)
  const words = text.split(/\s+/).filter(Boolean).length
  const match = /^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(text)
  const heading = (match?.[1] ?? '').slice(0, MAX_HEADING_LENGTH)
  return { path: relative, bytes, lines, words, heading }
}

/**
 * Walk a directory deterministically and collect statistics for matching text documents.
 * Symlinks are never followed, hidden directories and `node_modules` are skipped, and limits bound the work.
 * @param options - confinement root, target directory, filters, limits, and an optional abort signal.
 * @returns file statistics, skipped entries, and whether `maxFiles` cut the scan short.
 * @throws {WorkflowError} when the target is outside the root, missing, or not a directory.
 */
export async function scanDocuments(options: ScanOptions): Promise<ScanResult> {
  const realRoot = await realpath(options.root)
  const start = await resolveInside(options.root, options.relPath)
  if (!(await lstat(start)).isDirectory()) {
    throw new WorkflowError('not-a-directory', `Not a directory: ${toPosix(options.relPath)}`)
  }
  const excluded = options.excludeDir === undefined ? undefined : path.resolve(realRoot, options.excludeDir)
  const extensions = new Set(options.extensions.map(extension => extension.toLowerCase()))
  const result: ScanResult = { files: [], skipped: [], truncated: false }

  const collect = async (full: string, relative: string): Promise<void> => {
    try {
      const { size } = await lstat(full)
      if (size > options.maxFileBytes) {
        result.skipped.push({ path: relative, reason: 'too-large' })
        return
      }
      const text = await readFile(full, options.signal ? { encoding: 'utf8', signal: options.signal } : { encoding: 'utf8' })
      if (text.includes('\u0000')) {
        result.skipped.push({ path: relative, reason: 'binary' })
        return
      }
      result.files.push(computeStats(relative, size, text))
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error
      result.skipped.push({ path: relative, reason: 'unreadable' })
    }
  }

  const walk = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      options.signal?.throwIfAborted()
      if (result.truncated) return
      const full = path.join(directory, entry.name)
      const relative = toPosix(path.relative(realRoot, full))
      if (entry.isSymbolicLink()) {
        result.skipped.push({ path: relative, reason: 'symlink' })
      } else if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || full === excluded) continue
        await walk(full)
      } else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
        if (result.files.length >= options.maxFiles) {
          result.truncated = true
          return
        }
        await collect(full, relative)
      }
    }
  }

  await walk(start)
  return result
}

function cell(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|')
}

/**
 * Validate a report title.
 * @param title - caller-supplied title.
 * @returns the trimmed title.
 * @throws {WorkflowError} when the title is empty, too long, or contains control characters.
 */
export function validateTitle(title: string): string {
  const trimmed = title.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_TITLE_LENGTH || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new WorkflowError('invalid-title', `The title must be 1-${MAX_TITLE_LENGTH} characters without control characters.`)
  }
  return trimmed
}

/**
 * Render a deterministic Markdown report. The caller supplies the timestamp so rendering stays pure.
 * @param title - validated report title.
 * @param scanned - directory that was scanned, relative to the root.
 * @param scan - scan result to summarize.
 * @param generatedAt - ISO-8601 timestamp to print.
 * @returns the report text.
 */
export function renderReport(title: string, scanned: string, scan: ScanResult, generatedAt: string): string {
  const totals = scan.files.reduce(
    (sum, file) => ({ bytes: sum.bytes + file.bytes, lines: sum.lines + file.lines, words: sum.words + file.words }),
    { bytes: 0, lines: 0, words: 0 },
  )
  const out = [
    `# ${cell(title)}`,
    '',
    `- Generated: ${generatedAt}`,
    `- Scanned: \`${cell(toPosix(scanned) || '.')}\``,
    `- Documents: ${scan.files.length}${scan.truncated ? ' (truncated at the configured file limit)' : ''}`,
    `- Totals: ${totals.bytes} bytes, ${totals.lines} lines, ${totals.words} words`,
    '',
    '## Documents',
    '',
  ]
  if (scan.files.length === 0) {
    out.push('_No matching documents._')
  } else {
    out.push('| File | Bytes | Lines | Words | First heading |', '| --- | ---: | ---: | ---: | --- |')
    for (const file of scan.files) {
      out.push(`| ${cell(file.path)} | ${file.bytes} | ${file.lines} | ${file.words} | ${cell(file.heading)} |`)
    }
  }
  if (scan.skipped.length > 0) {
    out.push('', '## Skipped', '', '| Path | Reason |', '| --- | --- |')
    for (const entry of scan.skipped) out.push(`| ${cell(entry.path)} | ${entry.reason} |`)
  }
  out.push('')
  return out.join('\n')
}

export interface WriteReportOptions {
  root: string
  reportDir: string
  title: string
  content: string
  allowOverwrite: boolean
}

/**
 * Write a report file inside `reportDir` under the root. Existing files are never overwritten unless allowed,
 * and an existing symlink at the target is always refused.
 * @param options - confinement root, report directory, title (names the file), content, and overwrite policy.
 * @returns the report path relative to the root, using `/` separators.
 * @throws {WorkflowError} when the directory escapes the root, the title yields no file name, or the file exists.
 */
export async function writeReport(options: WriteReportOptions): Promise<string> {
  const slug = options.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '')
  if (slug.length === 0) {
    throw new WorkflowError('invalid-title', 'The title must contain at least one ASCII letter or digit to name the report file.')
  }
  const realRoot = await realpath(options.root)
  const lexical = path.resolve(realRoot, options.reportDir)
  if (path.isAbsolute(options.reportDir) || isOutside(path.relative(realRoot, lexical))) {
    throw new WorkflowError('path-escape', 'The report directory must be a relative path inside the configured root.')
  }
  await mkdir(lexical, { recursive: true })
  const realDir = await realpath(lexical)
  if (isOutside(path.relative(realRoot, realDir))) {
    throw new WorkflowError('path-escape', 'The report directory resolves outside the configured root.')
  }
  const target = path.join(realDir, `${slug}.md`)
  if (options.allowOverwrite) {
    const existing = await lstat(target).catch(() => undefined)
    if (existing?.isSymbolicLink()) {
      throw new WorkflowError('path-escape', 'Refusing to write through a symlink.')
    }
  }
  try {
    await writeFile(target, options.content, { encoding: 'utf8', flag: options.allowOverwrite ? 'w' : 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new WorkflowError('exists', `A report named ${slug}.md already exists; choose another title or enable allowOverwrite.`)
    }
    throw error
  }
  return toPosix(path.relative(realRoot, target))
}
