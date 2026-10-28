// 簡報 → Markdown：soffice 轉 PDF → 預設 pdftotext 抽字；--vlm 改走 marker 逐頁處理。
// .pptx 另外從 XML 抽「講者備註」（PDF 會丟失）零模型附在文末；.ppt（舊格式）無備註抽取
import { basename } from 'node:path'
import { markerPdfToMd, pdftotextToMd } from './pdf.mjs'
import { DRM_HINT, extOf, makeTmpDir, officeZipProblem, rmTmp, sofficeConvert, zipEntries } from './util.mjs'

/** .pptx 的講者備註：解 zip 讀 ppt/notesSlides/notesSlideN.xml，抽 <a:t> 文字（零模型） */
export async function pptxSpeakerNotes(srcPath) {
  const entries = (await zipEntries(srcPath, /^ppt\/notesSlides\/notesSlide\d+\.xml$/))
    .sort((a, b) => parseInt(a.base.match(/\d+/)[0], 10) - parseInt(b.base.match(/\d+/)[0], 10))
  const out = []
  for (const e of entries) {
    const xml = await e.file.async('string')
    const texts = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decodeXml(m[1])).filter(Boolean)
    // 濾掉純頁碼佔位（備註頁自帶的投影片編號）
    const body = texts.filter((t) => !/^\d+$/.test(t.trim())).join(' ').trim()
    if (body) out.push(`- 第 ${e.base.match(/\d+/)[0]} 頁：${body}`)
  }
  return out.length ? out.join('\n') : null
}

export async function convertPpt(srcPath, ctx) {
  if (extOf(srcPath) === '.pptx' && officeZipProblem(srcPath) === 'not-zip') throw new Error(DRM_HINT('.pptx'))
  const tmpDir = makeTmpDir(ctx.config, 'ppt-convert')
  let md
  try {
    ctx.log('   soffice 轉 PDF 中')
    const pdf = await sofficeConvert(srcPath, 'pdf', tmpDir, ctx.config)
    md = ctx.vlm
      ? await markerPdfToMd(pdf, ctx)
      : await pdftotextToMd(pdf, ctx, { title: basename(srcPath) })
  } finally { rmTmp(tmpDir) }
  if (extOf(srcPath) === '.pptx') {
    const notes = await pptxSpeakerNotes(srcPath)
    if (notes) md = `${md.replace(/\n+$/, '')}\n\n## 講者備註\n\n${notes}\n`
  }
  return md
}

/** 解 XML 文字節點的實體（&lt; &amp; &#NNN; …） */
export function decodeXml(s) {
  const named = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
    return named[e.toLowerCase()] ?? m
  })
}
