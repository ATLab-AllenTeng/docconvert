#!/usr/bin/env node
// docconvert CLI：見 lib/cli.mjs 的 USAGE
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { parseArgs, USAGE, VERSION } from '../lib/cli.mjs'
import { convertFile, expandTilde, outNameFor, finalizeOutput } from '../lib/index.mjs'

let args
try {
  args = parseArgs(process.argv.slice(2))
} catch (e) {
  process.stderr.write(`${e.message}\n\n${USAGE}`)
  process.exit(2)
}
if (args.help) { process.stdout.write(USAGE); process.exit(0) }
if (args.version) { process.stdout.write(`docconvert ${VERSION}\n`); process.exit(0) }
if (!args.files.length) { process.stderr.write(`請指定至少一個檔案\n\n${USAGE}`); process.exit(2) }

const log = args.quiet ? () => {} : (m) => process.stderr.write(`${m}\n`)
const outDir = args.out ? resolve(expandTilde(args.out)) : null
const withFm = args.frontmatter ?? !!outDir
if (outDir) mkdirSync(outDir, { recursive: true })

const results = []
const taken = new Set()
for (const f of args.files) {
  log(`── ${f}${args.vlm ? '（VLM 開啟）' : ''}`)
  const r = await convertFile(f, { vlm: args.vlm, maxRows: args.maxRows, attachments: args.attachments, quiet: args.quiet || args.json, log })
  if (r.ok && outDir) {
    const name = outNameFor(r.source, { outDir, taken })
    const p = resolve(outDir, name)
    writeFileSync(p, finalizeOutput(r.markdown, { source: r.source, converter: r.converter }))
    r.output = p
    const rel = relative(process.cwd(), p)
    log(`   → ${rel && !rel.startsWith('..') ? rel : p}`)
  }
  if (r.ok) for (const w of r.warnings) log(`   注意：${w}`)
  else log(`   失敗：${r.error}`)
  results.push(r)
}

const failed = results.filter((r) => !r.ok)
if (args.json) {
  process.stdout.write(JSON.stringify({ version: VERSION, vlm: args.vlm, files: results }, null, 2) + '\n')
  process.exit(failed.length === results.length ? 1 : 0)
}

if (outDir) {
  for (const r of results) if (r.ok) process.stdout.write(`${r.output}\n`)
} else {
  const blocks = results.filter((r) => r.ok).map((r) =>
    withFm ? finalizeOutput(r.markdown, { source: r.source, converter: r.converter }) : r.markdown.replace(/\n+$/, '') + '\n')
  if (blocks.length) process.stdout.write(blocks.join('\n---\n\n'))
}
if (failed.length) {
  process.stderr.write(`\n失敗 ${failed.length}/${results.length}：\n${failed.map((r) => `  ✗ ${r.source}：${r.error}`).join('\n')}\n`)
  process.exit(1)
}
