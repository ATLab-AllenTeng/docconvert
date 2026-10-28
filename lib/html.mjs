// HTML → Markdown（turndown + GFM 表格；零模型）
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

export async function htmlToMd(html) {
  const TurndownService = (await import('turndown')).default
  const { gfm } = await import('@joplin/turndown-plugin-gfm')
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
  td.use(gfm) // 表格轉 GFM Markdown 表格
  td.remove(['script', 'style', 'head', 'title', 'noscript']) // 網頁存檔常見的雜訊
  td.addRule('embedded-img-placeholder', {
    filter: (node) => node.nodeName === 'IMG',
    replacement: (_c, node) => {
      const src = node.getAttribute?.('src') || ''
      return src === 'about:embedded-image'
        ? '（嵌入圖片，見文末「嵌入圖片」一節）'
        : `（圖片：${src.startsWith('data:') ? '內嵌 data URI' : src || '無來源'}）`
    },
  })
  return promoteEmptyTableHeader(td.turndown(html).trim())
}

/**
 * GFM 表格的表頭列若全空（Word 表格沒有 th 時 turndown 的輸出），把第一列資料升為表頭。
 * 只動「空表頭 + 分隔列 + 至少一列資料」的表格；其餘原樣
 */
export function promoteEmptyTableHeader(md) {
  return md.replace(/^(\|(?:[ \t]*\|)+)\n(\|(?:\s*-{3,}\s*\|)+)\n(\|[^\n]*\|)\n?/gm, (_m, _head, sep, first) => `${first}\n${sep}\n`)
}

/** HTML 存檔 → Markdown；圖片僅保留來源註記，不另行 VLM */
export async function convertHtml(srcPath) {
  const html = readFileSync(srcPath, 'utf8')
  const md = await htmlToMd(html)
  if (!md) throw new Error('轉出內容為空（可能是純 JS 渲染的頁面存檔，改存「完整網頁」或列印成 PDF 再轉）')
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1].trim()
  return `# ${title || basename(srcPath)}\n\n${md}\n`
}
