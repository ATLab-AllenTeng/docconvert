// Word 文件 → Markdown（零模型；嵌入圖只在 vlm 下描述）
//   .docx：mammoth → HTML → turndown(GFM 表格) → Markdown；嵌入圖片解 zip 處理
//   .doc ：舊二進位格式，偵測順序 textutil（macOS 內建，只有文字）→ soffice（跨平台：先轉 .docx 再走完整管線）
import { basename } from 'node:path'
import { htmlToMd } from './html.mjs'
import { embeddedImagesToMd } from './image.mjs'
import { DRM_HINT, extOf, makeTmpDir, officeZipProblem, rmTmp, runCmd, sofficeConvert } from './util.mjs'

export async function docxToParts(docxPath, ctx) {
  const mammoth = (await import('mammoth')).default
  // 圖片另走嵌入圖片路徑，HTML 中先以佔位符呈現，避免 base64 塞爆輸出
  const r = await mammoth.convertToHtml({ path: docxPath }, {
    styleMap: ["p[style-name='Title'] => h1:fresh"], // Word「標題」樣式 → h1
    convertImage: mammoth.images.imgElement(async () => ({ src: 'about:embedded-image' })),
  })
  const md = await htmlToMd(r.value)
  if (!md) throw new Error('轉出內容為空（文件可能是掃描件或加密檔）')
  const parts = [md]
  const imgSection = await embeddedImagesToMd(docxPath, /^word\/media\//, ctx)
  if (imgSection) parts.push(imgSection)
  return parts
}

/** 舊格式/非標準 Word：textutil（macOS 內建）→ soffice（跨平台；轉 .docx 含嵌入圖） */
export async function legacyDocToParts(srcPath, ctx) {
  try {
    const html = await runCmd('textutil', ['-convert', 'html', '-stdout', srcPath])
    if (!html) throw new Error('textutil 轉出內容為空')
    const md = await htmlToMd(html)
    if (!md) throw new Error('轉出內容為空（文件可能是掃描件或加密檔）')
    return [md]
  } catch (e) {
    if (!e.missing) throw e // textutil 存在但轉檔失敗 → 直接回報，不掩蓋
    const tmpDir = makeTmpDir(ctx.config, 'doc-convert')
    try {
      let produced
      try {
        produced = await sofficeConvert(srcPath, 'docx', tmpDir, ctx.config)
      } catch (e2) {
        throw new Error(/找不到 LibreOffice/.test(e2.message)
          ? '找不到 textutil（macOS）也找不到 LibreOffice；請安裝 LibreOffice（必要時 .env 設 SOFFICE_BIN），或先另存為 .docx'
          : e2.message)
      }
      return await docxToParts(produced, ctx)
    } finally { rmTmp(tmpDir) }
  }
}

export async function convertDoc(srcPath, ctx) {
  let parts
  if (extOf(srcPath) === '.docx') {
    try {
      parts = await docxToParts(srcPath, ctx)
    } catch (e) {
      // 副檔名 .docx 但內容不是 zip（實為舊 .doc 或 HTML 偽裝）→ 退到 textutil/soffice 路徑
      if (!/central directory|zip/i.test(e.message)) throw e
      if (officeZipProblem(srcPath) === 'not-zip') throw new Error(DRM_HINT('.docx'))
      ctx.log('   （副檔名 .docx 但內容非 docx 格式，改走 textutil/soffice 路徑）')
      ctx.warnings.push('副檔名 .docx 但內容非 docx 格式，改走 textutil/soffice 路徑')
      parts = await legacyDocToParts(srcPath, ctx)
    }
  } else {
    parts = await legacyDocToParts(srcPath, ctx)
  }
  return `# ${basename(srcPath)}\n\n${parts.join('\n\n')}\n`
}
