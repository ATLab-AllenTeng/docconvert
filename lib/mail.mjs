// Email → Markdown：信頭＋內文零模型解析；附件遞迴轉成 Markdown 區段
//   .eml：標準 MIME（mailparser，含編碼處理）
//   .msg：Outlook OLE（@kenjiuno/msgreader）；若檔頭不是 OLE（Outlook 另存成 MIME 文字卻掛 .msg）改走 mailparser
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { htmlToMd } from './html.mjs'
import { imageToMd, VLM_OFF_NOTE } from './image.mjs'
import { IMG_EXT, converterFor, demoteHeadings, extOf, makeTmpDir, rmTmp } from './util.mjs'

const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
export const isOle = (buf) => buf.subarray(0, 8).equals(OLE_MAGIC)

/** 附件遞迴深度上限（信中夾信中夾信…） */
export const MAX_ATTACHMENT_DEPTH = 3

async function parseEml(buf) {
  const { simpleParser } = await import('mailparser')
  const m = await simpleParser(buf)
  return {
    subject: m.subject,
    from: m.from?.text,
    to: m.to?.text,
    cc: m.cc?.text,
    date: m.date?.toISOString().slice(0, 16).replace('T', ' '),
    bodyMd: m.text?.trim() || (m.html ? await htmlToMd(m.html) : ''),
    attachments: (m.attachments ?? []).map((a) => ({
      name: a.filename || '(未命名附件)', buf: a.content, ext: extOf(a.filename || ''),
    })),
  }
}

async function parseMsg(buf) {
  const mod = await import('@kenjiuno/msgreader')
  const MsgReader = mod.default?.default ?? mod.default // CJS/ESM 互操作的雙層 default
  const reader = new MsgReader(buf)
  const d = reader.getFileData()
  const rcpt = (kind) => (d.recipients ?? []).filter((r) => (r.recipType ?? 'to') === kind)
    .map((r) => r.name || r.email).join('、')
  return {
    subject: d.subject,
    from: [d.senderName, d.senderEmail && `<${d.senderEmail}>`].filter(Boolean).join(' '),
    to: rcpt('to'),
    cc: rcpt('cc'),
    date: d.messageDeliveryTime || d.clientSubmitTime || '',
    bodyMd: (d.body || '').trim() || (d.bodyHtml ? await htmlToMd(d.bodyHtml) : ''),
    attachments: (d.attachments ?? []).map((a) => {
      let content = null
      try { content = Buffer.from(reader.getAttachment(a).content) } catch { /* 取不到就只列名 */ }
      return { name: a.fileName || '(未命名附件)', buf: content, ext: extOf(a.fileName || '') }
    }),
  }
}

/** 解析信件（依副檔名與檔頭自動選 parser）；回傳 { subject, from, to, cc, date, bodyMd, attachments } */
export async function parseMail(buf, ext, ctx) {
  if (ext === '.msg') {
    if (isOle(buf)) return parseMsg(buf)
    ctx?.warnings.push('副檔名 .msg 但內容不是 Outlook OLE 格式，改以 MIME（mailparser）解析')
    return parseEml(buf)
  }
  return parseEml(buf)
}

export async function convertMail(srcPath, ctx) {
  const buf = readFileSync(srcPath)
  const parsed = await parseMail(buf, extOf(srcPath), ctx)
  const { from, to, cc, date, bodyMd, attachments } = parsed
  const subject = (parsed.subject || '').trim()
  if (!bodyMd && !attachments.length) throw new Error('信件內文為空且無附件（檔案可能損毀）')

  const head = [
    `- 主旨：${subject || '(無主旨)'}`,
    from && `- 寄件人：${from}`,
    to && `- 收件人：${to}`,
    cc && `- 副本：${cc}`,
    date && `- 日期：${date}`,
  ].filter(Boolean).join('\n')
  const parts = [head, bodyMd || '（內文為空）']
  const attResults = []

  const depth = ctx.depth ?? 0
  const canRecurse = ctx.attachments !== false && depth < MAX_ATTACHMENT_DEPTH
  const imgAtts = attachments.filter((a) => a.buf && a.ext in IMG_EXT)
  const docAtts = attachments.filter((a) => a.buf && !(a.ext in IMG_EXT) && converterFor(a.name))
  const otherAtts = attachments.filter((a) => !imgAtts.includes(a) && !docAtts.includes(a))

  // 附件圖片：vlm 才描述；否則只列名
  if (imgAtts.length) {
    if (!ctx.vlm) {
      ctx.warnings.push(`${imgAtts.length} 個附件圖片未轉換：${VLM_OFF_NOTE}`)
      parts.push(`## 附件圖片（${VLM_OFF_NOTE}）\n\n${imgAtts.map((a) => `- ${a.name}`).join('\n')}`)
      for (const a of imgAtts) attResults.push({ name: a.name, size: a.buf.length, converter: 'image', converted: false, warnings: [VLM_OFF_NOTE] })
    } else {
      const attDir = makeTmpDir(ctx.config, 'mail-att-img')
      try {
        const secs = []
        for (const [i, a] of imgAtts.entries()) {
          const p = resolve(attDir, `att${i}${a.ext}`)
          writeFileSync(p, a.buf)
          ctx.log(`   附件圖片 ${i + 1}/${imgAtts.length}（${a.name}）→ VLM`)
          const r = { name: a.name, size: a.buf.length, converter: 'image', converted: false, warnings: [] }
          try {
            r.markdown = await imageToMd(p, ctx); r.converted = true
            secs.push(`### 附件圖片 ${i + 1}（${a.name}）\n\n${r.markdown}`)
          } catch (e) {
            r.warnings.push(e.message); ctx.warnings.push(`附件圖片 ${a.name} 描述失敗：${e.message}`)
            secs.push(`### 附件圖片 ${i + 1}（${a.name}）\n\n（描述失敗：${e.message}）`)
          }
          attResults.push(r)
        }
        parts.push(`## 附件圖片\n\n${secs.join('\n\n')}`)
      } finally { rmTmp(attDir) }
    }
  }

  // 文件附件：遞迴交給 convertFile（同一套 vlm 設定）；失敗只記 warning、列名
  if (docAtts.length) {
    if (!canRecurse) {
      parts.push(`## 其他附件（未轉換）\n\n${docAtts.map((a) => `- ${a.name}`).join('\n')}`)
      for (const a of docAtts) attResults.push({ name: a.name, size: a.buf.length, converter: converterFor(a.name), converted: false, warnings: ['未遞迴轉換（已停用或超過深度）'] })
    } else {
      const attDir = makeTmpDir(ctx.config, 'mail-att')
      try {
        for (const [i, a] of docAtts.entries()) {
          // 保留原檔名（副檔名決定轉換器；標題也用它），同名就加序號
          const p = resolve(attDir, `${i}-${basename(a.name).replace(/[\\/:*?"<>|]/g, '_')}`)
          writeFileSync(p, a.buf)
          ctx.log(`   附件 ${i + 1}/${docAtts.length}（${a.name}）→ ${converterFor(a.name)}`)
          const sub = await ctx.convertFile(p, { ...ctx.options, depth: depth + 1, log: ctx.log })
          const r = { name: a.name, size: a.buf.length, converter: sub.converter, converted: sub.ok, warnings: sub.warnings }
          if (sub.ok) {
            r.markdown = sub.markdown
            parts.push(`## 附件：${a.name}\n\n${demoteHeadings(sub.markdown).trim()}`)
          } else {
            ctx.warnings.push(`附件 ${a.name} 轉換失敗：${sub.error}`)
            parts.push(`## 附件：${a.name}\n\n（轉換失敗：${sub.error}）`)
          }
          for (const w of sub.warnings) ctx.warnings.push(`附件 ${a.name}：${w}`)
          attResults.push(r)
        }
      } finally { rmTmp(attDir) }
    }
  }

  if (otherAtts.length) {
    parts.push(`## 其他附件（不支援的格式，未轉換）\n\n${otherAtts.map((a) => `- ${a.name}`).join('\n')}`)
    for (const a of otherAtts) attResults.push({ name: a.name, size: a.buf?.length ?? 0, converter: null, converted: false, warnings: ['不支援的格式'] })
  }

  return { markdown: `# ${subject || basename(srcPath)}\n\n${parts.join('\n\n')}\n`, attachments: attResults }
}
