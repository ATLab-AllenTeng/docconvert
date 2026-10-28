// 試算表 → Markdown 表格（SheetJS 確定性轉換：公式取算好的值、每工作表一節；零模型）
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { embeddedImagesToMd } from './image.mjs'
import { DRM_HINT, extOf, officeZipProblem } from './util.mjs'

const esc = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()

/** 單一工作表的 rows（array of arrays）→ Markdown 表格；超過 maxRows 截斷並附註 */
export function rowsToTable(rows, maxRows) {
  const width = Math.max(...rows.map((r) => r.length))
  const truncated = rows.length > maxRows
  const body = rows.slice(0, maxRows)
  const line = (r) => `| ${Array.from({ length: width }, (_, i) => esc(r[i])).join(' | ')} |`
  const table = [line(body[0]), `|${' --- |'.repeat(width)}`, ...body.slice(1).map(line)].join('\n')
  return table + (truncated ? `\n\n> ⚠️ 僅轉出前 ${maxRows} 列（原始共 ${rows.length} 列）；完整資料請看原始檔。` : '')
}

/**
 * 活頁簿 → 各工作表的 Markdown 區段（純邏輯，測試用；回傳陣列）。
 * raw:false＝取儲存格「顯示文字」（公式取算好的值、日期用 yyyy-mm-dd、百分比等依格式），
 * 與人在 Excel 看到的一致（letta.kb 版用原始值，日期會變成 JS Date 字串）
 */
export function workbookToSections(wb, XLSX, maxRows) {
  const parts = []
  for (const sheetName of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '', blankrows: false, raw: false, dateNF: 'yyyy-mm-dd' })
    if (!rows.length) continue
    parts.push(`## 工作表：${sheetName}\n\n${rowsToTable(rows, maxRows)}`)
  }
  return parts
}

export async function convertSheet(srcPath, ctx) {
  if (extOf(srcPath) === '.xlsx' && officeZipProblem(srcPath) === 'not-zip') throw new Error(DRM_HINT('.xlsx'))
  const mod = await import('xlsx')
  const XLSX = mod.default ?? mod
  // 自己讀 buffer，避免 ESM 版無 fs 綁定的問題
  const wb = XLSX.read(readFileSync(srcPath), { cellDates: true })
  normalizeDates(wb)
  const parts = workbookToSections(wb, XLSX, ctx.config.xlsxMaxRows)
  if (extOf(srcPath) === '.xlsx') {
    const imgSection = await embeddedImagesToMd(srcPath, /^xl\/media\//, ctx)
    if (imgSection) parts.push(imgSection)
  }
  if (!parts.length) throw new Error('試算表沒有任何非空工作表')
  return `# ${basename(srcPath)}\n\n${parts.join('\n\n')}\n`
}

/** 日期儲存格一律輸出 ISO（yyyy-mm-dd，有時間再加 hh:mm），不受 Excel 顯示格式（m/d/yy 等）影響 */
export function normalizeDates(wb) {
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name]
    for (const addr of Object.keys(ws)) {
      const c = ws[addr]
      if (!c || c.t !== 'd' || !(c.v instanceof Date)) continue
      // SheetJS 的日期以 UTC 分量承載 Excel 的「牆上時鐘」時間，格式化也用 UTC 分量；距午夜不到一分鐘視為無時間（浮點誤差）
      const secs = c.v.getUTCHours() * 3600 + c.v.getUTCMinutes() * 60 + c.v.getUTCSeconds()
      const hasTime = secs > 60 && secs < 86340
      c.z = hasTime ? 'yyyy-mm-dd hh:mm' : 'yyyy-mm-dd'
      delete c.w // 讓 raw:false 依新格式重算顯示文字
    }
  }
}
