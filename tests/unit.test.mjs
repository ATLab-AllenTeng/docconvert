// 純邏輯單元測試：不依賴外部檔案、不呼叫網路；需要的 fixture 在測試內動態產生
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeDocx, makeEml, makePptxNotes, makeXlsx, tmpDir } from './helpers.mjs'
import {
  convertFile, converterFor, finalizeOutput, htmlToMd, isSupported, outNameFor, parseMail,
  pptxSpeakerNotes, rowsToTable, SUPPORTED_EXT, unsupportedMessage, markerLineSink, rewriteMarkerLine,
} from '../lib/index.mjs'
import { parseArgs } from '../lib/cli.mjs'
import { demoteHeadings } from '../lib/util.mjs'
import { isOle } from '../lib/mail.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const BIN = resolve(ROOT, 'bin', 'docconvert.mjs')
// 任何意外的模型呼叫都會打到這個關閉的 port 而失敗
process.env.DOCCONVERT_BASE_URL = 'http://127.0.0.1:9'
process.env.DOCCONVERT_API_KEY = 'unused'

describe('副檔名與轉換器對應', () => {
  test('每種支援的副檔名都有轉換器', () => {
    for (const e of SUPPORTED_EXT) assert.ok(converterFor(`x${e}`), e)
    assert.equal(converterFor('a.PDF'), 'pdf')
    assert.equal(converterFor('a.XLSX'), 'sheet')
    assert.equal(converterFor('a.eml'), 'mail')
  })
  test('不支援的副檔名回 null 並有清楚訊息', () => {
    assert.equal(converterFor('a.xyz'), null)
    assert.equal(isSupported('a'), false)
    assert.match(unsupportedMessage('a.xyz'), /不支援的副檔名「\.xyz」/)
    assert.match(unsupportedMessage('a.xyz'), /\.pdf/)
  })
  test('convertFile 對不支援副檔名回 ok=false、不丟例外', async () => {
    const r = await convertFile('whatever.xyz')
    assert.equal(r.ok, false)
    assert.equal(r.converter, null)
    assert.match(r.error, /不支援的副檔名/)
  })
  test('convertFile 對不存在的檔回 ok=false', async () => {
    const r = await convertFile('/nonexistent/x.pdf')
    assert.equal(r.ok, false)
    assert.match(r.error, /找不到檔案/)
  })
})

describe('outNameFor', () => {
  test('基本：<名>.md；同批撞名改 <名>_<副檔名>.md，再撞加序號', () => {
    const taken = new Set()
    assert.equal(outNameFor('/x/報告.pdf', { taken }), '報告.md')
    assert.equal(outNameFor('/x/報告.png', { taken }), '報告_png.md')
    assert.equal(outNameFor('/y/報告.png', { taken }), '報告_png2.md')
    assert.equal(outNameFor('/z/報告.png', { taken }), '報告_png3.md')
  })
  test('輸出資料夾已有同名檔案時避開', () => {
    const d = tmpDir()
    writeFileSync(resolve(d, 'a.md'), 'x')
    assert.equal(outNameFor('/x/a.docx', { outDir: d }), 'a_docx.md')
  })
})

describe('finalizeOutput', () => {
  test('沒有 frontmatter 就補 source/converted/converter', () => {
    const out = finalizeOutput('# T\n\nbody\n', { source: '/s/a.pdf', converter: 'pdf', date: '2026-10-28' })
    assert.equal(out, '---\nsource: /s/a.pdf\nconverted: 2026-10-28\nconverter: pdf\n---\n\n# T\n\nbody\n')
  })
  test('已有 frontmatter 時保留原欄位、只補缺的', () => {
    const out = finalizeOutput('---\ntitle: X\nsource: keep\n---\n\nbody', { source: '/s', converter: 'pdf', date: 'D' })
    assert.equal(out, '---\ntitle: X\nsource: keep\nconverted: D\nconverter: pdf\n---\n\nbody\n')
  })
})

describe('htmlToMd', () => {
  test('標題、表格（GFM）、雜訊移除、圖片佔位', async () => {
    const md = await htmlToMd(`<html><head><title>T</title><style>p{}</style></head><body>
      <h1>標題</h1><script>alert(1)</script><p>內文 <b>粗</b></p>
      <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
      <img src="about:embedded-image"><img src="data:image/png;base64,xx"><img src="http://x/y.png"></body></html>`)
    assert.match(md, /^# 標題/)
    assert.doesNotMatch(md, /alert|p\{\}|\bT\b/)
    assert.match(md, /\| A\s+\| B\s+\|\n\| --- \| --- \|\n\| 1\s+\| 2\s+\|/)
    assert.match(md, /（嵌入圖片，見文末「嵌入圖片」一節）/)
    assert.match(md, /（圖片：內嵌 data URI）/)
    assert.match(md, /（圖片：http:\/\/x\/y\.png）/)
  })
})

describe('試算表', () => {
  test('rowsToTable：對齊欄寬、跳脫 |、換行變空白、超過上限截斷', () => {
    const t = rowsToTable([['a', 'b|c'], ['1\n2'], ['3', '4', '5']], 2)
    assert.equal(t.split('\n')[0], '| a | b\\|c |  |')
    assert.equal(t.split('\n')[1], '| --- | --- | --- |')
    assert.equal(t.split('\n')[2], '| 1 2 |  |  |')
    assert.match(t, /僅轉出前 2 列（原始共 3 列）/)
  })
  test('rowsToTable：去掉尾端全空的欄（工作表範圍延伸到 XFD 時不會爆量）', () => {
    const pad = (r) => [...r, ...Array(16381).fill('')]
    const t = rowsToTable([pad(['部門', '職級', '人數']), pad(['技術開發處', 'E5', '12']), pad(['', '', ''])], 300)
    assert.equal(t.split('\n')[0], '| 部門 | 職級 | 人數 |')
    assert.equal(t.split('\n')[1], '| --- | --- | --- |')
    assert.ok(t.length < 200)
  })
  test('rowsToTable：列數很多（20 萬列）也不會撐爆呼叫堆疊', () => {
    const rows = Array.from({ length: 200_000 }, (_, i) => [`t${i}`, '3.7'])
    rows.push(['x', 'y', 'z'])
    const t = rowsToTable(rows, 300)
    assert.equal(t.split('\n')[0], '| t0 | 3.7 |  |')
    assert.match(t, /僅轉出前 300 列（原始共 200001 列）/)
  })
  test('convertFile(xlsx)：每工作表一節、空工作表略過、--max-rows 生效、日期用 yyyy-mm-dd', async () => {
    const d = tmpDir()
    const p = await makeXlsx(resolve(d, '測試.xlsx'), {
      總表: [['項目', '數量', '日期'], ['A', 1, new Date(2026, 8, 1)], ['B', 2, ''], ['C', 3, '']],
      空白: [],
    })
    const r = await convertFile(p, { maxRows: 2 })
    assert.equal(r.ok, true, r.error)
    assert.equal(r.converter, 'sheet')
    assert.match(r.markdown, /^# 測試\.xlsx\n\n## 工作表：總表\n/)
    assert.doesNotMatch(r.markdown, /工作表：空白/)
    assert.match(r.markdown, /\| A \| 1 \| 2026-09-01 \|/)
    assert.doesNotMatch(r.markdown, /\| B \|/)
    assert.match(r.markdown, /僅轉出前 2 列（原始共 4 列）/)
    assert.deepEqual(r.warnings, [])
  })
  test('convertFile(csv)：BOM/引號正確、無模型呼叫', async () => {
    const d = tmpDir()
    const p = resolve(d, 'c.csv')
    writeFileSync(p, '﻿"name","val"\n"x, y","1"\n"z","2"\n')
    const r = await convertFile(p)
    assert.equal(r.ok, true, r.error)
    assert.match(r.markdown, /\| name \| val \|\n\| --- \| --- \|\n\| x, y \| 1 \|\n\| z \| 2 \|/)
  })
})

describe('Word（mammoth，程式內產生 docx）', () => {
  test('標題、段落、表格；嵌入圖片在無 --vlm 下只列名並記 warning', async () => {
    const d = tmpDir()
    const p = await makeDocx(resolve(d, 'doc.docx'), {
      paragraphs: ['# 大標', '第一段內容', '## 小標', '第二段'],
      table: [['欄一', '欄二'], ['甲', '乙']],
      image: true,
    })
    const r = await convertFile(p)
    assert.equal(r.ok, true, r.error)
    assert.equal(r.converter, 'word')
    assert.match(r.markdown, /^# doc\.docx\n/)
    assert.match(r.markdown, /\n# 大標\n/)
    assert.match(r.markdown, /\n## 小標\n/)
    assert.match(r.markdown, /\| 欄一\s+\| 欄二\s+\|\n\| --- \| --- \|\n\| 甲\s+\| 乙\s+\|/) // 空表頭已升級為首列
    assert.match(r.markdown, /## 嵌入圖片\n\n> 本文件含 1 張嵌入圖片（image1\.png），未啟用 VLM/)
    assert.equal(r.warnings.length, 1)
    assert.match(r.warnings[0], /嵌入圖片未轉換/)
  })
  test('副檔名 .docx 但內容不是 zip → DRM/文管提示', async () => {
    const d = tmpDir()
    const p = resolve(d, 'drm.docx')
    writeFileSync(p, Buffer.from(':OSR__DS_FILE_HDR' + '\0'.repeat(100)))
    const r = await convertFile(p)
    assert.equal(r.ok, false)
    assert.match(r.error, /DRM\/文管系統/)
  })
})

describe('簡報講者備註', () => {
  test('pptxSpeakerNotes 依頁序輸出、過濾純頁碼', async () => {
    const d = tmpDir()
    const p = await makePptxNotes(resolve(d, 'n.pptx'), ['第一頁的備註', '', '第三頁 <重點>'])
    const notes = await pptxSpeakerNotes(p)
    assert.equal(notes, '- 第 1 頁：第一頁的備註\n- 第 3 頁：第三頁 <重點>')
  })
})

describe('圖片（無 --vlm）', () => {
  test('輸出佔位、記 warning、不打網路', async () => {
    const d = tmpDir()
    const p = resolve(d, 'pic.png')
    writeFileSync(p, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))
    const r = await convertFile(p)
    assert.equal(r.ok, true)
    assert.equal(r.converter, 'image')
    assert.match(r.markdown, /未啟用 VLM/)
    assert.equal(r.warnings.length, 1)
  })
  test('--vlm 打不到端點時回 ok=false 而不是卡住', async () => {
    const d = tmpDir()
    const p = resolve(d, 'pic.png')
    writeFileSync(p, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))
    const r = await convertFile(p, { vlm: true, config: { vlmTimeoutMs: 3000 } })
    assert.equal(r.ok, false)
    assert.ok(r.error)
  })
})

describe('信件', () => {
  test('isOle 判斷檔頭', () => {
    assert.equal(isOle(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])), true)
    assert.equal(isOle(Buffer.from('From: a@b\r\n')), false)
  })
  test('.eml：信頭、內文、CSV 附件遞迴轉換、不支援附件列名', async () => {
    const d = tmpDir()
    const p = makeEml(resolve(d, 'm.eml'), {
      subject: '測試主旨', text: '哈囉\n第二行',
      attachments: [
        { name: 'data.csv', type: 'text/csv', content: 'a,b\n1,2\n' },
        { name: 'bin.xyz', content: 'zzz' },
        { name: 'pic.png', type: 'image/png', content: Buffer.from('iVBORw0KGgo=', 'base64') },
      ],
    })
    const r = await convertFile(p)
    assert.equal(r.ok, true, r.error)
    assert.equal(r.converter, 'mail')
    assert.match(r.markdown, /^# 測試主旨\n\n- 主旨：測試主旨\n- 寄件人：a@example\.com\n- 收件人：b@example\.com\n- 日期：2026-09-01 02:00\n\n哈囉\n第二行/)
    assert.match(r.markdown, /## 附件：data\.csv\n\n### 工作表：Sheet1\n\n\| a \| b \|\n\| --- \| --- \|\n\| 1 \| 2 \|/)
    assert.match(r.markdown, /## 其他附件（不支援的格式，未轉換）\n\n- bin\.xyz/)
    assert.match(r.markdown, /## 附件圖片（未啟用 VLM.*\n\n- pic\.png/)
    assert.equal(r.attachments.length, 3)
    const csv = r.attachments.find((a) => a.name === 'data.csv')
    assert.equal(csv.converted, true)
    assert.equal(csv.converter, 'sheet')
    assert.match(csv.markdown, /\| 1 \| 2 \|/)
    assert.equal(r.attachments.find((a) => a.name === 'pic.png').converted, false)
    assert.equal(r.attachments.find((a) => a.name === 'bin.xyz').converter, null)
  })
  test('--no-attachments：附件只列名', async () => {
    const d = tmpDir()
    const p = makeEml(resolve(d, 'm.eml'), { subject: 'S', text: 'T', attachments: [{ name: 'data.csv', content: 'a\n1\n' }] })
    const r = await convertFile(p, { attachments: false })
    assert.equal(r.ok, true)
    assert.match(r.markdown, /## 其他附件（未轉換）\n\n- data\.csv/)
    assert.equal(r.attachments[0].converted, false)
  })
  test('副檔名 .msg 但內容是 MIME → 改用 mailparser 並記 warning', async () => {
    const d = tmpDir()
    const p = makeEml(resolve(d, 'm.msg'), { subject: '  帶空白主旨 ', text: '內容' })
    const r = await convertFile(p)
    assert.equal(r.ok, true, r.error)
    assert.match(r.markdown, /^# 帶空白主旨\n/)
    assert.ok(r.warnings.some((w) => /不是 Outlook OLE/.test(w)))
  })
  test('parseMail 直接解析 buffer', async () => {
    const m = await parseMail(Buffer.from('From: x@y\r\nSubject: hi\r\n\r\nbody'), '.eml')
    assert.equal(m.subject, 'hi')
    assert.equal(m.bodyMd, 'body')
  })
})

describe('工具函式', () => {
  test('demoteHeadings 去掉首個 H1、其餘降一級、略過程式碼區塊', () => {
    assert.equal(demoteHeadings('# T\n\n## A\ntext\n```\n# not heading\n```\n### B'), '### A\ntext\n```\n# not heading\n```\n#### B')
  })
  test('marker 輸出收斂：過濾良性雜訊、翻譯 BRIDGE_OK 與表格統計', () => {
    const got = []
    const sink = markerLineSink((t) => got.push(t))
    sink.push('Warning: You are sending unauthenticated requests to the HF Hub\nBRIDGE_OK /x/out.md (12345 chars)\n')
    sink.push('Force-killed llamacpp (pid 123)\nreal error here')
    sink.flush()
    assert.deepEqual(got, ['   轉換完成：產出 12,345 字 → out.md\n', 'real error here\n'])
    assert.match(rewriteMarkerLine("Table processing stats: {'tables_pdftext': 3, 'tables_ocr': 1, 'tables_total': 4}"), /表格 4 個：3 個直接取文字、1 個需 OCR/)
  })
})

describe('CLI 參數解析', () => {
  test('完整參數', () => {
    const o = parseArgs(['a.pdf', '-o', 'out', '--json', '--vlm', '--max-rows', '50', '--quiet', '--no-attachments', 'b.docx'])
    assert.deepEqual(o.files, ['a.pdf', 'b.docx'])
    assert.equal(o.out, 'out'); assert.equal(o.json, true); assert.equal(o.vlm, true)
    assert.equal(o.maxRows, 50); assert.equal(o.quiet, true); assert.equal(o.attachments, false)
  })
  test('預設值與 = 形式', () => {
    const o = parseArgs(['--out=o', '--max-rows=7', 'x.pdf'])
    assert.equal(o.out, 'o'); assert.equal(o.maxRows, 7); assert.equal(o.vlm, false); assert.equal(o.json, false)
    assert.equal(o.frontmatter, null)
  })
  test('-- 之後全是檔名；錯誤參數丟例外', () => {
    assert.deepEqual(parseArgs(['--', '--weird.pdf']).files, ['--weird.pdf'])
    assert.throws(() => parseArgs(['--max-rows', '0']), /正整數/)
    assert.throws(() => parseArgs(['--bogus']), /未知的選項/)
    assert.throws(() => parseArgs(['-o']), /需要一個值/)
  })
})

describe('CLI 端對端（spawn）', () => {
  const env = { ...process.env, DOCCONVERT_BASE_URL: 'http://127.0.0.1:9' }
  test('--version / --help', () => {
    assert.match(execFileSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' }), /^docconvert \d+\.\d+\.\d+\n$/)
    assert.match(execFileSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' }), /用法：docconvert/)
  })
  test('沒有檔案 → exit 2', () => {
    const r = spawnSync(process.execPath, [BIN], { encoding: 'utf8' })
    assert.equal(r.status, 2)
  })
  test('不支援副檔名 → stderr 有訊息、exit 1、stdout 空', () => {
    const r = spawnSync(process.execPath, [BIN, 'nope.xyz'], { encoding: 'utf8', env })
    assert.equal(r.status, 1)
    assert.equal(r.stdout, '')
    assert.match(r.stderr, /不支援的副檔名「\.xyz」/)
  })
  test('--json：格式、單檔錯誤進 error、有一檔成功就 exit 0；全失敗 exit 1', async () => {
    const d = tmpDir()
    const csv = resolve(d, 'a.csv'); writeFileSync(csv, 'k,v\n1,2\n')
    const r = spawnSync(process.execPath, [BIN, '--json', csv, 'nope.xyz'], { encoding: 'utf8', env })
    assert.equal(r.status, 0, r.stderr)
    const j = JSON.parse(r.stdout)
    assert.equal(j.vlm, false)
    assert.equal(j.files.length, 2)
    assert.equal(j.files[0].ok, true)
    assert.equal(j.files[0].converter, 'sheet')
    assert.match(j.files[0].markdown, /\| k \| v \|/)
    assert.deepEqual(j.files[0].warnings, [])
    assert.equal(j.files[1].ok, false)
    assert.match(j.files[1].error, /不支援的副檔名/)
    const r2 = spawnSync(process.execPath, [BIN, '--json', 'nope.xyz'], { encoding: 'utf8', env })
    assert.equal(r2.status, 1)
    assert.equal(JSON.parse(r2.stdout).files[0].ok, false)
  })
  test('stdout 多檔以 --- 分隔；-o 寫檔並印路徑（含 frontmatter）', async () => {
    const d = tmpDir()
    const a = resolve(d, 'a.csv'); writeFileSync(a, 'x\n1\n')
    const b = resolve(d, 'b.csv'); writeFileSync(b, 'y\n2\n')
    const out = execFileSync(process.execPath, [BIN, '-q', a, b], { encoding: 'utf8', env })
    assert.match(out, /^# a\.csv\n[\s\S]*\n---\n\n# b\.csv\n/)
    const o = resolve(d, 'out')
    const printed = execFileSync(process.execPath, [BIN, '-q', '-o', o, a, a], { encoding: 'utf8', env }).trim().split('\n')
    assert.deepEqual(printed, [resolve(o, 'a.md'), resolve(o, 'a_csv.md')])
    assert.match(readFileSync(printed[0], 'utf8'), /^---\nsource: .*a\.csv\nconverted: \d{4}-\d{2}-\d{2}\nconverter: sheet\n---\n\n# a\.csv\n/)
  })
})
