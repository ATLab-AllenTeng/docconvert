// 共用工具：副檔名分類、外部指令、zip 讀取、LibreOffice 偵測、暫存目錄
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync } from 'node:fs'
import { basename, resolve } from 'node:path'

export const IMG_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }
export const SHEET_EXT = new Set(['.xlsx', '.xls', '.csv'])
export const DOC_EXT = new Set(['.docx', '.doc'])
export const PPT_EXT = new Set(['.pptx', '.ppt'])
export const MAIL_EXT = new Set(['.eml', '.msg'])
export const HTML_EXT = new Set(['.html', '.htm'])
export const PDF_EXT = '.pdf'

export const extOf = (p) => { const m = String(p).toLowerCase().match(/\.[a-z0-9]+$/); return m ? m[0] : '' }

/** 副檔名 → 轉換器名稱；不支援回 null */
export function converterFor(p) {
  const e = extOf(p)
  if (e === PDF_EXT) return 'pdf'
  if (e in IMG_EXT) return 'image'
  if (SHEET_EXT.has(e)) return 'sheet'
  if (DOC_EXT.has(e)) return 'word'
  if (PPT_EXT.has(e)) return 'ppt'
  if (MAIL_EXT.has(e)) return 'mail'
  if (HTML_EXT.has(e)) return 'html'
  return null
}
export const SUPPORTED_EXT = [
  PDF_EXT, ...Object.keys(IMG_EXT), ...SHEET_EXT, ...DOC_EXT, ...PPT_EXT, ...MAIL_EXT, ...HTML_EXT,
]
export const isSupported = (p) => converterFor(p) !== null

/** 檔名去掉副檔名（輸出標題與 outNameFor 用） */
export const stemOf = (p) => basename(p).replace(/\.[a-z0-9]+$/i, '')

/**
 * 執行外部指令並收集 stdout（字串）。exit 非 0 → reject，錯誤帶 stderr 片段；
 * 找不到執行檔 → err.missing = true，呼叫端據此給安裝提示
 */
export const runCmd = (cmd, args, { encoding = 'utf8', input } = {}) => new Promise((res, rej) => {
  let c
  try { c = spawn(cmd, args, { stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] }) } catch (e) { return rej(e) }
  const out = [], err = []
  c.stdout.on('data', (d) => out.push(d))
  c.stderr.on('data', (d) => err.push(d))
  c.on('error', (e) => rej(Object.assign(e, { missing: e.code === 'ENOENT' })))
  c.on('close', (code) => {
    const stdout = Buffer.concat(out)
    if (code === 0) return res(encoding ? stdout.toString(encoding) : stdout)
    const tail = Buffer.concat(err).toString('utf8').trim().split('\n').slice(-3).join(' | ')
    rej(new Error(`${basename(cmd)} exit ${code}${tail ? `：${tail}` : ''}`))
  })
  if (input != null) { c.stdin.end(input) }
})

/** zip（Office 檔）內符合 re 的檔案清單：純 JS，跨平台（Windows 沒有 unzip 指令） */
export async function zipEntries(srcPath, re) {
  const JSZip = (await import('jszip')).default
  let zip
  try { zip = await JSZip.loadAsync(readFileSync(srcPath)) } catch { return [] }
  return Object.keys(zip.files)
    .filter((n) => re.test(n) && !zip.files[n].dir)
    .sort()
    .map((n) => ({ name: n, base: basename(n), file: zip.files[n] }))
}

// LibreOffice 執行檔：Windows/macOS 安裝後都不在 PATH，逐一偵測；可用 SOFFICE_BIN 指定
let _sofficeBin = null
export function sofficeBin(cfg) {
  if (_sofficeBin) return _sofficeBin
  const cands = [
    cfg?.sofficeBin,
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  ].filter(Boolean)
  for (const c of cands) { if (existsSync(c)) return (_sofficeBin = c) }
  return (_sofficeBin = 'soffice') // 退回 PATH（Linux、homebrew、已設好 PATH 的環境）
}
export const SOFFICE_HINT =
  '找不到 LibreOffice；此格式需要它（macOS：brew install --cask libreoffice；' +
  'Windows：官網安裝後若仍找不到，於 .env 設 SOFFICE_BIN=C:\\Program Files\\LibreOffice\\program\\soffice.exe）'

/**
 * 以 soffice 把檔案轉成指定格式，回傳產出的檔案路徑（在 outDir 內）。
 * 一律用 docconvert 自己的 LibreOffice 使用者 profile（<tmpRoot>/lo-profile）：headless 轉檔若與
 * 開著的 LibreOffice 視窗共用 profile，會連到既有實例後靜默結束、什麼都沒產出（letta.kb 版沒有防這個）
 */
export async function sofficeConvert(srcPath, to, outDir, cfg) {
  const profile = resolve(cfg.tmpRoot, 'lo-profile')
  mkdirSync(profile, { recursive: true })
  const profileUrl = `file://${profile.replace(/\\/g, '/').replace(/^([A-Za-z]:)/, '/$1')}` // Windows 路徑 → file:///C:/...
  try {
    await runCmd(sofficeBin(cfg), [`-env:UserInstallation=${profileUrl}`, '--headless', '--norestore', '--convert-to', to, '--outdir', outDir, srcPath])
  } catch (e) {
    throw new Error(e.missing ? SOFFICE_HINT : `soffice 轉 ${to} 失敗：${e.message}`)
  }
  const { readdirSync } = await import('node:fs')
  const produced = readdirSync(outDir).find((f) => f.toLowerCase().endsWith(`.${to}`))
  if (!produced) throw new Error(`soffice 未產出 .${to}（檔案可能加密或損毀）`)
  return resolve(outDir, produced)
}

/** 建立獨立暫存目錄（DOCCONVERT_TMP 或系統暫存區之下），回傳路徑 */
export function makeTmpDir(cfg, label) {
  mkdirSync(cfg.tmpRoot, { recursive: true })
  return mkdtempSync(resolve(cfg.tmpRoot, `${label.replace(/[^\w一-鿿-]+/g, '_').slice(0, 40)}-`))
}
export const rmTmp = (p) => { if (p) rmSync(p, { recursive: true, force: true }) }

/** 把一份 Markdown 的標題全部降一級（附件內容掛在 ## 之下用），並去掉開頭的 H1 */
export function demoteHeadings(md) {
  const lines = md.replace(/^\s*#\s+[^\n]*\n+/, '').split('\n')
  let inFence = false
  return lines.map((l) => {
    if (/^\s*```/.test(l)) inFence = !inFence
    return (!inFence && /^#{1,5}\s/.test(l)) ? `#${l}` : l
  }).join('\n')
}

/**
 * Office Open XML（.docx/.xlsx/.pptx）應是 zip（PK 開頭）。不是的話多半是 DRM/文管系統包裝、
 * 舊二進位格式（OLE）或副檔名錯誤：先給一行乾淨的原因，不要讓 soffice/mammoth 吐難懂的錯
 */
export function officeZipProblem(srcPath) {
  const fd = openSync(srcPath, 'r')
  const head = Buffer.alloc(8)
  const n = readSync(fd, head, 0, 8, 0)
  closeSync(fd)
  if (n >= 2 && head[0] === 0x50 && head[1] === 0x4b) return null // PK：正常 zip
  if (head.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return 'ole'
  return 'not-zip'
}
export const DRM_HINT = (ext) =>
  `不是有效的 ${ext} 檔（不是 zip 格式）——檔案可能被 DRM/文管系統包裝、損壞或副檔名錯誤。` +
  '建議：file <檔案> 看實際格式；DRM 檔請在授權環境開啟後另存或列印成 PDF 再轉。'
