// PDF → Markdown
//   預設（零模型）：pdftotext -layout 純抽字，逐頁以 --- 分隔
//   --vlm        ：scripts/marker_bridge.py（marker_tools：逐頁轉換 + VLM 組稿），需 MARKER_PYTHON venv
import { spawn } from 'node:child_process'
import { existsSync, openSync, readSync, closeSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { ROOT } from './config.mjs'
import { makeTmpDir, rmTmp, runCmd, stemOf } from './util.mjs'

/** 前置檔頭檢查：不是 PDF 就不啟動任何工具，直接給一行乾淨的原因 */
export function assertPdfHeader(pdfPath) {
  const fd = openSync(pdfPath, 'r')
  const head = Buffer.alloc(1024)
  const n = readSync(fd, head, 0, 1024, 0)
  closeSync(fd)
  if (!head.subarray(0, n).includes('%PDF-')) {
    throw new Error('不是有效的 PDF（找不到 %PDF- 檔頭）——檔案可能被 DRM/文管系統包裝、損壞或副檔名錯誤。' +
      '建議：file <檔案> 看實際格式；DRM 檔請在授權環境開啟後「列印→另存 PDF」再轉。')
  }
}

export const PDFTOTEXT_HINT =
  '找不到 pdftotext（poppler）；PDF 預設抽字需要它（macOS：brew install poppler；Windows：安裝 poppler 後把 bin 加入 PATH 或 .env 設 PDFTOTEXT_BIN）'

/** pdftotext 純抽字 → 頁陣列（去掉空白頁） */
export async function pdftotextPages(pdfPath, cfg) {
  let text
  try {
    text = await runCmd(cfg.pdftotextBin, ['-layout', '-enc', 'UTF-8', pdfPath, '-'])
  } catch (e) {
    throw new Error(e.missing ? PDFTOTEXT_HINT : `pdftotext 失敗：${e.message}`)
  }
  return text.split('\f').map((p) => p.replace(/[ \t]+$/gm, '').trim()).filter(Boolean)
}

export async function pdftotextToMd(pdfPath, ctx, { title = basename(pdfPath) } = {}) {
  assertPdfHeader(pdfPath)
  const pages = await pdftotextPages(pdfPath, ctx.config)
  if (!pages.length) {
    throw new Error('PDF 沒有可抽取的文字（可能是掃描件或純圖片 PDF）；加 --vlm 走 marker（含 OCR）')
  }
  return `# ${title}\n\n${pages.join('\n\n---\n\n')}\n`
}

// --- marker 子行程輸出的收斂 -------------------------------------------
// marker 每轉一份 PDF 都會吐兩條看起來像出事、實際完全良性的訊息。
// 原則：只濾「已知且確定良性」的整行，其餘一個字都不動——真出事必須看得到。
const MARKER_NOISE = [
  /^Warning: You are sending unauthenticated requests to the HF Hub\b/, // 匿名下載 HF 權重的速率提醒
  /^Force-killed llamacpp \(pid \d+\)$/,                              // 轉完後收掉 OCR 子行程：善後，不是錯誤
]

/** 把 marker 的機器訊息翻成人看得懂的一行 */
export function rewriteMarkerLine(line) {
  const ok = line.match(/^BRIDGE_OK\s+(.+?)\s+\((\d+)\s+chars\)$/)
  if (ok) return `   轉換完成：產出 ${Number(ok[2]).toLocaleString('en-US')} 字 → ${basename(ok[1])}`
  const tbl = line.match(/Table processing stats:.*?'tables_pdftext':\s*(\d+).*?'tables_ocr':\s*(\d+).*?'tables_total':\s*(\d+)/)
  if (tbl) {
    const [, txt, ocr, total] = tbl
    return `   表格 ${total} 個：${txt} 個直接取文字、${ocr} 個需 OCR${Number(ocr) > 0 ? '（OCR 較慢，請耐心等）' : ''}`
  }
  return line
}

/** 逐行過濾器。\r 結尾的是 tqdm 進度更新，原樣放行才能保持進度條會動 */
export function markerLineSink(write) {
  let buf = ''
  const emit = (text) => {
    const body = text.replace(/[\r\n]+$/, '')
    if (MARKER_NOISE.some((re) => re.test(body.trim()))) return
    write(rewriteMarkerLine(body) + text.slice(body.length))
  }
  return {
    push(chunk) {
      buf += chunk.toString()
      const parts = buf.split(/(?<=[\r\n])/) // 保留行尾字元，才能區分 \r 進度與 \n 換行
      buf = /[\r\n]$/.test(buf) ? '' : parts.pop()
      for (const part of parts) emit(part)
    },
    flush() { if (buf) { emit(buf + '\n'); buf = '' } },
  }
}

const runMarker = (python, args, ctx) => new Promise((res) => {
  const c = spawn(python, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  const write = (t) => { if (!ctx.quiet) process.stderr.write(t) }
  const out = markerLineSink(write)
  const err = markerLineSink(write)
  c.stdout.on('data', (d) => out.push(d))
  c.stderr.on('data', (d) => err.push(d))
  c.on('close', (code) => { out.flush(); err.flush(); res(code) })
  c.on('error', (e) => { ctx.warnings.push(`無法啟動 ${python}：${e.message}`); res(-1) })
})

export const BRIDGE_PY = resolve(ROOT, 'scripts', 'marker_bridge.py')

/** PDF → Markdown（marker_tools 橋接）；失敗丟錯，中繼檔保留供除錯 */
export async function markerPdfToMd(pdfPath, ctx) {
  assertPdfHeader(pdfPath)
  const cfg = ctx.config
  const tmp = makeTmpDir(cfg, `marker-${stemOf(pdfPath)}`)
  const outMd = resolve(tmp, 'out.md')
  const workdir = resolve(tmp, 'pages')
  ctx.log('   逐頁轉換中——PDF 是最慢的格式，表格多的檔案可能要數分鐘到十幾分鐘，這期間沒有輸出是正常的。')
  const args = [BRIDGE_PY, pdfPath, outMd, '--workdir', workdir, '--model', cfg.visionModel]
  if (cfg.baseUrl) args.push('--api-base', cfg.baseUrl, '--api-key', cfg.apiKey)
  const code = await runMarker(cfg.markerPython, args, ctx)
  if (code !== 0 || !existsSync(outMd)) {
    throw new Error(`marker 轉換失敗（exit ${code}）；中繼檔保留在 ${tmp} 供除錯` +
      (code === -1 || code === 2 ? '。請確認 MARKER_PYTHON 指向裝好 marker_tools 的 venv（scripts/docconvert.sh install）' : ''))
  }
  const md = readFileSync(outMd, 'utf8')
  rmTmp(tmp)
  return md
}

export async function convertPdf(pdfPath, ctx) {
  if (ctx.vlm) return markerPdfToMd(pdfPath, ctx)
  return pdftotextToMd(pdfPath, ctx)
}
