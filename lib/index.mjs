// docconvert 程式介面：convertFile(path, opts) → { source, markdown, converter, warnings, ok, ... }
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { getConfig, expandTilde } from './config.mjs'
import { convertHtml } from './html.mjs'
import { convertImage } from './image.mjs'
import { convertMail } from './mail.mjs'
import { convertPdf } from './pdf.mjs'
import { convertPpt } from './ppt.mjs'
import { convertSheet } from './sheet.mjs'
import { convertDoc } from './word.mjs'
import { SUPPORTED_EXT, converterFor, extOf } from './util.mjs'

export { getConfig, expandTilde, loadDotEnv, ROOT } from './config.mjs'
export { SUPPORTED_EXT, converterFor, isSupported, extOf, stemOf, sofficeBin, zipEntries } from './util.mjs'
export { htmlToMd, convertHtml } from './html.mjs'
export { convertSheet, rowsToTable, workbookToSections } from './sheet.mjs'
export { convertDoc, docxToParts, legacyDocToParts } from './word.mjs'
export { convertPdf, pdftotextToMd, markerPdfToMd, markerLineSink, rewriteMarkerLine } from './pdf.mjs'
export { convertPpt, pptxSpeakerNotes } from './ppt.mjs'
export { convertMail, parseMail, isOle } from './mail.mjs'
export { imageToMd, embeddedImagesToMd, convertImage, IMG_PROMPT } from './image.mjs'
export { outNameFor, finalizeOutput } from './output.mjs'

export const unsupportedMessage = (p) =>
  `不支援的副檔名「${extOf(p) || '(無)'}」；支援：${SUPPORTED_EXT.join(' ')}`

/**
 * 轉換單一檔案。永不 throw：失敗時 ok=false、error 有訊息（呼叫端決定 exit code）。
 * opts：
 *   vlm         是否允許呼叫模型（預設 false：PDF 走 pdftotext、圖片只列名）
 *   maxRows     試算表每工作表列數上限（預設 DOCCONVERT_XLSX_MAX_ROWS 或 300）
 *   attachments 信件附件是否遞迴轉換（預設 true）
 *   log(msg)    進度訊息回呼（預設不輸出）
 *   quiet       壓掉 marker 子行程的輸出
 *   config      直接覆蓋 getConfig() 的欄位（測試用）
 */
export async function convertFile(path, opts = {}) {
  const source = resolve(expandTilde(String(path)))
  const converter = converterFor(source)
  const warnings = []
  const result = { source, converter, ok: false, markdown: '', warnings }
  if (!converter) return { ...result, error: unsupportedMessage(source) }
  try {
    if (!statSync(source).isFile()) throw new Error('不是檔案')
  } catch (e) {
    return { ...result, error: e.code === 'ENOENT' ? `找不到檔案：${source}` : e.message }
  }
  const config = getConfig({ xlsxMaxRows: opts.maxRows, ...(opts.config || {}) })
  const ctx = {
    vlm: !!opts.vlm,
    attachments: opts.attachments !== false,
    depth: opts.depth ?? 0,
    quiet: !!opts.quiet,
    log: typeof opts.log === 'function' ? opts.log : () => {},
    warnings,
    config,
    options: { vlm: !!opts.vlm, maxRows: opts.maxRows, attachments: opts.attachments, quiet: opts.quiet, config: opts.config },
    convertFile,
  }
  try {
    switch (converter) {
      case 'pdf': result.markdown = await convertPdf(source, ctx); break
      case 'image': result.markdown = await convertImage(source, ctx); break
      case 'sheet': result.markdown = await convertSheet(source, ctx); break
      case 'word': result.markdown = await convertDoc(source, ctx); break
      case 'ppt': result.markdown = await convertPpt(source, ctx); break
      case 'html': result.markdown = await convertHtml(source); break
      case 'mail': {
        const r = await convertMail(source, ctx)
        result.markdown = r.markdown
        result.attachments = r.attachments
        break
      }
    }
    if (!result.markdown.trim()) throw new Error('轉出內容為空')
    result.ok = true
  } catch (e) {
    result.error = e.message
  }
  return result
}

/** 依序轉換多個檔案（PDF/soffice 都吃 CPU，不並行） */
export async function convertFiles(paths, opts = {}) {
  const out = []
  for (const p of paths) out.push(await convertFile(p, opts))
  return out
}
