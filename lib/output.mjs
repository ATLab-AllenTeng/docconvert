// 輸出檔名與最終整理（-o 模式）
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { extOf, stemOf } from './util.mjs'

/**
 * 決定輸出檔名：<名>.md；同一輸出資料夾撞名（報告.pdf + 報告.png）時改用 <名>_<副檔名>.md，
 * 再撞就加流水號。taken 是本次執行已分配的名字（避免同批兩檔互相覆蓋）。
 */
export function outNameFor(src, { outDir, taken = new Set(), stem = stemOf(src) } = {}) {
  const ext = extOf(src).slice(1)
  const free = (c) => !taken.has(c) && !(outDir && (existsSync(resolve(outDir, c)) || existsSync(resolve(outDir, c.replace(/\.md$/, '')))))
  const candidates = [`${stem}.md`, `${stem}_${ext}.md`]
  for (let i = 2; ; i++) {
    for (const c of candidates) if (free(c)) { taken.add(c); return c }
    candidates.length = 0
    candidates.push(`${stem}_${ext}${i}.md`)
  }
}

/**
 * 最終整理：確保有來源 frontmatter（source / converted / converter）。
 * 轉換器輸出若已自帶 frontmatter（如 marker），保留原有欄位、補缺的。
 */
export function finalizeOutput(markdown, { source, converter, date = new Date().toISOString().slice(0, 10) }) {
  const fm = markdown.match(/^---\n([\s\S]*?)\n---\n+/)
  const body = fm ? markdown.slice(fm[0].length) : markdown
  const lines = fm ? fm[1].split('\n') : []
  const has = (k) => lines.some((l) => l.startsWith(`${k}:`))
  if (!has('source')) lines.push(`source: ${source}`)
  if (!has('converted')) lines.push(`converted: ${date}`)
  if (!has('converter')) lines.push(`converter: ${converter}`)
  return `---\n${lines.join('\n')}\n---\n\n${body.replace(/\n+$/, '')}\n`
}
