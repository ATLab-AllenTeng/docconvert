// 測試共用：程式內產生小 fixture（不依賴外部檔）
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

export const tmpDir = (label = 'docconvert-test') => mkdtempSync(resolve(tmpdir(), `${label}-`))

/** 以 SheetJS 動態產生 xlsx（多工作表） */
export async function makeXlsx(path, sheets) {
  const mod = await import('xlsx')
  const XLSX = mod.default ?? mod
  const wb = XLSX.utils.book_new()
  for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name)
  writeFileSync(path, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
  return path
}

const xmlEsc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')

/** 最小 docx：段落 + 一張嵌入圖片（1x1 PNG）+ 一個表格 */
export async function makeDocx(path, { paragraphs = [], table = null, image = false } = {}) {
  const JSZip = (await import('jszip')).default
  const zip = new JSZip()
  const body = []
  for (const p of paragraphs) {
    const m = p.match(/^(#+)\s+(.*)$/)
    if (m) body.push(`<w:p><w:pPr><w:pStyle w:val="Heading${m[1].length}"/></w:pPr><w:r><w:t>${xmlEsc(m[2])}</w:t></w:r></w:p>`)
    else body.push(`<w:p><w:r><w:t>${xmlEsc(p)}</w:t></w:r></w:p>`)
  }
  if (table) {
    body.push('<w:tbl>' + table.map((row) =>
      `<w:tr>${row.map((c) => `<w:tc><w:p><w:r><w:t>${xmlEsc(c)}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`).join('') + '</w:tbl>')
  }
  if (image) {
    body.push('<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip r:embed="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>')
    // 1x1 透明 PNG
    zip.file('word/media/image1.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))
    zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>`)
  }
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}</w:body></w:document>`)
  writeFileSync(path, await zip.generateAsync({ type: 'nodebuffer' }))
  return path
}

/** 只含講者備註的假 pptx（測 pptxSpeakerNotes 的 zip 解析） */
export async function makePptxNotes(path, notes) {
  const JSZip = (await import('jszip')).default
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types/>')
  notes.forEach((t, i) => {
    zip.file(`ppt/notesSlides/notesSlide${i + 1}.xml`,
      `<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>${xmlEsc(t)}</a:t><a:t>${i + 1}</a:t></p:notes>`)
  })
  writeFileSync(path, await zip.generateAsync({ type: 'nodebuffer' }))
  return path
}

/** 簡單 MIME 信：純文字內文 + 若干附件（base64） */
export function makeEml(path, { subject, from = 'a@example.com', to = 'b@example.com', text, attachments = [] }) {
  const b = 'BOUNDARY-docconvert-test'
  const parts = [
    `--${b}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${text}\r\n`,
    ...attachments.map((a) =>
      `--${b}\r\nContent-Type: ${a.type || 'application/octet-stream'}; name="${a.name}"\r\n` +
      `Content-Disposition: attachment; filename="${a.name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
      `${Buffer.from(a.content).toString('base64').replace(/(.{76})/g, '$1\r\n')}\r\n`),
    `--${b}--\r\n`,
  ]
  const eml = `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: Tue, 01 Sep 2026 10:00:00 +0800\r\nMIME-Version: 1.0\r\n` +
    `Content-Type: multipart/mixed; boundary="${b}"\r\n\r\n${parts.join('')}`
  writeFileSync(path, eml)
  return path
}
