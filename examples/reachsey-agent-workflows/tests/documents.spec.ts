import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderReport, resolveInside, scanDocuments, validateTitle, WorkflowError, writeReport } from '../src/documents.ts'

let root: string
let outside: string

const limits = { extensions: ['.md', '.txt'], maxFiles: 100, maxFileBytes: 1024 }

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'rw-root-'))
  outside = await mkdtemp(path.join(tmpdir(), 'rw-outside-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(WorkflowError)
  expect((error as WorkflowError).code).toBe(code)
}

describe('resolveInside', () => {
  it('accepts the root and nested directories', async () => {
    await mkdir(path.join(root, 'a'))
    expect(await resolveInside(root, '.')).toBe(await resolveInside(root, ''))
    expect(await resolveInside(root, 'a')).toMatch(/a$/)
  })

  it('refuses absolute paths, parent traversal, and missing paths', async () => {
    await expectCode(resolveInside(root, outside), 'path-escape')
    await expectCode(resolveInside(root, '../elsewhere'), 'path-escape')
    await expectCode(resolveInside(root, 'missing'), 'not-found')
  })

  it('refuses a symlink that points outside the root', async () => {
    await symlink(outside, path.join(root, 'link'))
    await expectCode(resolveInside(root, 'link'), 'path-escape')
  })
})

describe('scanDocuments', () => {
  it('collects statistics deterministically and never echoes content', async () => {
    await writeFile(path.join(root, 'b.md'), '# Beta | title\n\nsecret body text\n')
    await writeFile(path.join(root, 'a.txt'), 'one two\nthree\n')
    await writeFile(path.join(root, 'ignored.bin'), 'x')
    await mkdir(path.join(root, 'sub'))
    await writeFile(path.join(root, 'sub', 'c.MD'), '')
    const scan = await scanDocuments({ ...limits, root, relPath: '.' })
    expect(scan.files.map(file => file.path)).toEqual(['a.txt', 'b.md', 'sub/c.MD'])
    expect(scan.files[0]).toMatchObject({ lines: 2, words: 3, heading: '' })
    expect(scan.files[1]).toMatchObject({ heading: 'Beta | title', words: 7 })
    expect(scan.files[2]).toMatchObject({ bytes: 0, lines: 0, words: 0 })
    expect(JSON.stringify(scan)).not.toContain('secret body text')
    expect(scan.truncated).toBe(false)
  })

  it('skips symlinks, oversized, and binary files, and ignores hidden and node_modules directories', async () => {
    await writeFile(path.join(outside, 'leak.md'), '# leak')
    await symlink(path.join(outside, 'leak.md'), path.join(root, 'leak.md'))
    await writeFile(path.join(root, 'big.md'), 'x'.repeat(2048))
    await writeFile(path.join(root, 'bin.md'), 'a\u0000b')
    await mkdir(path.join(root, '.hidden'))
    await writeFile(path.join(root, '.hidden', 'h.md'), '# h')
    await mkdir(path.join(root, 'node_modules'))
    await writeFile(path.join(root, 'node_modules', 'n.md'), '# n')
    const scan = await scanDocuments({ ...limits, root, relPath: '.' })
    expect(scan.files).toEqual([])
    expect(scan.skipped).toEqual([
      { path: 'big.md', reason: 'too-large' },
      { path: 'bin.md', reason: 'binary' },
      { path: 'leak.md', reason: 'symlink' },
    ])
  })

  it('truncates at maxFiles and excludes the report directory', async () => {
    for (const name of ['1.md', '2.md', '3.md']) await writeFile(path.join(root, name), '# t')
    await mkdir(path.join(root, 'reports'))
    await writeFile(path.join(root, 'reports', 'old.md'), '# old')
    const scan = await scanDocuments({ ...limits, root, relPath: '.', maxFiles: 2, excludeDir: 'reports' })
    expect(scan.files.map(file => file.path)).toEqual(['1.md', '2.md'])
    expect(scan.truncated).toBe(true)
  })

  it('rejects files as scan targets and honors an aborted signal', async () => {
    await writeFile(path.join(root, 'f.md'), '# f')
    await expectCode(scanDocuments({ ...limits, root, relPath: 'f.md' }), 'not-a-directory')
    const controller = new AbortController()
    controller.abort()
    await expect(scanDocuments({ ...limits, root, relPath: '.', signal: controller.signal })).rejects.toThrow()
  })
})

describe('validateTitle and renderReport', () => {
  it('validates titles', () => {
    expect(validateTitle('  Q3 Review  ')).toBe('Q3 Review')
    expect(() => validateTitle('   ')).toThrow(WorkflowError)
    expect(() => validateTitle('bad\ntitle')).toThrow(WorkflowError)
    expect(() => validateTitle('x'.repeat(121))).toThrow(WorkflowError)
  })

  it('renders a stable report with escaped table cells', () => {
    const text = renderReport('Report', 'docs', {
      files: [{ path: 'a|b.md', bytes: 10, lines: 2, words: 3, heading: 'H' }],
      skipped: [{ path: 'x.md', reason: 'symlink' }],
      truncated: true,
    }, '2026-01-01T00:00:00.000Z')
    expect(text).toContain('| a\\|b.md | 10 | 2 | 3 | H |')
    expect(text).toContain('Documents: 1 (truncated at the configured file limit)')
    expect(text).toContain('| x.md | symlink |')
    expect(renderReport('Empty', '', { files: [], skipped: [], truncated: false }, 't')).toContain('_No matching documents._')
  })
})

describe('writeReport', () => {
  const base = () => ({ root, reportDir: 'reports', title: 'My Report', content: 'body', allowOverwrite: false })

  it('writes inside the report directory and refuses to overwrite by default', async () => {
    expect(await writeReport(base())).toBe('reports/my-report.md')
    expect(await readFile(path.join(root, 'reports', 'my-report.md'), 'utf8')).toBe('body')
    await expectCode(writeReport(base()), 'exists')
    expect(await readFile(path.join(root, 'reports', 'my-report.md'), 'utf8')).toBe('body')
  })

  it('overwrites only when allowed', async () => {
    await writeReport(base())
    await writeReport({ ...base(), content: 'new', allowOverwrite: true })
    expect(await readFile(path.join(root, 'reports', 'my-report.md'), 'utf8')).toBe('new')
  })

  it('refuses a title without usable characters, absolute or escaping directories, and symlinked targets', async () => {
    await expectCode(writeReport({ ...base(), title: '!!!' }), 'invalid-title')
    await expect(readdir(path.join(root, 'reports'))).rejects.toThrow() // a refused title creates nothing
    await expectCode(writeReport({ ...base(), reportDir: outside }), 'path-escape')
    await expectCode(writeReport({ ...base(), reportDir: '../x' }), 'path-escape')
    await mkdir(path.join(root, 'reports'))
    await symlink(path.join(outside, 'target.md'), path.join(root, 'reports', 'my-report.md'))
    await expectCode(writeReport({ ...base(), allowOverwrite: true }), 'path-escape')
    await expectCode(writeReport(base()), 'exists')
  })

  it('refuses a report directory that is a symlink out of the root', async () => {
    await symlink(outside, path.join(root, 'out'))
    await expectCode(writeReport({ ...base(), reportDir: 'out' }), 'path-escape')
  })
})
