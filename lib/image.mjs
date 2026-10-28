// 圖片 → VLM 描述筆記（只在 vlm 開啟時呼叫模型）；Office 檔嵌入圖片的處理
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { vlmEndpoint } from './config.mjs'
import { IMG_EXT, extOf, makeTmpDir, rmTmp, zipEntries } from './util.mjs'

// 單次呼叫自路由：先判斷圖片類型，再套用該類型的轉錄規則（電路圖有專屬 BOM 式規則）
export const IMG_PROMPT =
  '你是知識庫的圖片轉錄員。先判斷這張圖的類型，再依對應規則轉成繁體中文（台灣用語）Markdown 筆記。\n\n' +
  '第一行固定寫：「圖片類型：<電路圖|波形量測圖|架構流程圖|表格文件截圖|白板手寫|照片|其他>」，接一句主題說明。\n\n' +
  '【電路圖】用 BOM 式轉錄，嚴禁腦補：\n' +
  '- 「元件清單」小節：逐一列出可辨識的元件——編號、型號、數值/規格（如 R12 10kΩ、U3 BQ76942），保留原文；\n' +
  '- 「關鍵連接」小節：只列你有把握的連接關係（如 U3 ALERT → MCU PA4）；\n' +
  '- 任何看不清或不確定的內容一律標「(?)」，字太小無法辨識就明寫「無法辨識」，寧可留白不要猜。\n' +
  '【波形量測圖】描述各軸與單位、每條曲線的意義、關鍵數值（觸發點、峰值、時間差），不確定標「(?)」。\n' +
  '【架構流程圖】列出元件/節點、連接關係與資料流向。\n' +
  '【表格文件截圖】忠實轉錄：表格轉 Markdown 表格；程式碼、參數、標籤保留原文不翻譯。\n' +
  '【白板手寫/照片/其他】完整描述內容與所有可見文字。\n\n' +
  '最後加「重點」小節，條列可供日後檢索的關鍵結論（電路圖含辨識不完整的警語，提醒讀者查證原圖）。\n' +
  '只輸出 Markdown 內容本身，不要加任何前言或說明。'

export const VLM_OFF_NOTE = '未啟用 VLM（加 --vlm 才會呼叫模型產生描述）'

/** 圖片 → Markdown 描述（OpenAI 相容 chat API；只有 ctx.vlm 為真才會被呼叫） */
export async function imageToMd(imgPath, ctx) {
  if (!ctx.vlm) throw new Error(VLM_OFF_NOTE)
  const cfg = ctx.config
  const mime = IMG_EXT[extOf(imgPath)]
  if (!mime) throw new Error(`不支援的圖片格式：${extOf(imgPath)}`)
  const dataUrl = `data:${mime};base64,${readFileSync(imgPath).toString('base64')}`
  const res = await fetch(`${vlmEndpoint(cfg)}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: JSON.stringify({
      model: cfg.visionModel,
      messages: [{ role: 'user', content: [
        { type: 'text', text: IMG_PROMPT },
        { type: 'image_url', image_url: { url: dataUrl } },
      ] }],
    }),
    signal: AbortSignal.timeout(cfg.vlmTimeoutMs),
  })
  if (!res.ok) throw new Error(`VLM 回應 ${res.status}：${(await res.text()).slice(0, 300)}`)
  const body = await res.json()
  const md = (body.choices?.[0]?.message?.content || '').trim()
  if (md.length < 20) throw new Error(`VLM 回覆過短（${md.length} 字），視為失敗`)
  return md
}

/** 單一圖片檔：有 vlm 走描述；沒有就輸出佔位並記 warning */
export async function convertImage(imgPath, ctx) {
  if (!ctx.vlm) {
    ctx.warnings.push(`圖片未轉換：${VLM_OFF_NOTE}`)
    return `# ${basename(imgPath)}\n\n（圖片未轉換：${VLM_OFF_NOTE}）\n`
  }
  ctx.log(`   圖片 → VLM（${ctx.config.visionModel}）`)
  return `${await imageToMd(imgPath, ctx)}\n`
}

/**
 * Office zip 檔（.xlsx/.docx）的嵌入圖片：xlsx 在 xl/media/*、docx 在 word/media/*。
 * vlm 開啟時逐張描述；關閉時只列清單。限制：不解析圖片在原文的位置（統一附在文末）；原生 chart 無圖檔可取
 */
export async function embeddedImagesToMd(srcPath, mediaRe, ctx) {
  const entries = await zipEntries(srcPath, mediaRe)
  if (!entries.length) return null
  const imgs = entries.filter((e) => extOf(e.base) in IMG_EXT)
  const other = entries.filter((e) => !(extOf(e.base) in IMG_EXT))
  const secs = []
  if (imgs.length && !ctx.vlm) {
    ctx.warnings.push(`${imgs.length} 張嵌入圖片未轉換：${VLM_OFF_NOTE}`)
    secs.push(`> 本文件含 ${imgs.length} 張嵌入圖片（${imgs.map((e) => e.base).join('、')}），${VLM_OFF_NOTE}。`)
  } else if (imgs.length) {
    const mediaDir = makeTmpDir(ctx.config, 'office-media')
    try {
      for (const [i, e] of imgs.entries()) {
        const p = resolve(mediaDir, e.base)
        writeFileSync(p, await e.file.async('nodebuffer'))
        ctx.log(`   嵌入圖片 ${i + 1}/${imgs.length}（${e.base}）→ VLM`)
        try {
          secs.push(`### 嵌入圖片 ${i + 1}（${e.base}）\n\n${await imageToMd(p, ctx)}`)
        } catch (err) {
          ctx.warnings.push(`嵌入圖片 ${e.base} 描述失敗：${err.message}`)
          secs.push(`### 嵌入圖片 ${i + 1}（${e.base}）\n\n（描述失敗：${err.message}）`)
        }
      }
    } finally { rmTmp(mediaDir) }
  }
  if (other.length) {
    secs.push(`> 註：${other.length} 個嵌入物件為不支援的格式（${other.map((e) => e.base).join('、')}），未轉換。`)
  }
  return secs.length ? `## 嵌入圖片\n\n${secs.join('\n\n')}` : null
}
