// 真實檔案整合測試：讀 tests/fixtures/local/（公司內部文件，整個目錄 gitignore，絕不 commit）。
// 檔案不存在就 skip。一律在無 --vlm 下跑：不呼叫任何模型；DOCCONVERT_BASE_URL 指向關閉的 port，
// 任何意外的模型呼叫都會立刻失敗而被測出來。
// 注意：.pptx 與含 Office 附件的 .eml 需要 LibreOffice（soffice）。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { convertFile } from '../lib/index.mjs'

process.env.DOCCONVERT_BASE_URL = 'http://127.0.0.1:9'
process.env.DOCCONVERT_API_KEY = 'unused'

const DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'local')
const fx = (name) => resolve(DIR, name)
const SLOW = { timeout: 240_000 } // soffice 第一次啟動要建 profile

/** 有檔才跑；回傳成功結果（失敗直接 assert） */
function withFixture(name, opts, fn) {
  const p = fx(name)
  return test(name, { ...SLOW, skip: existsSync(p) ? false : `缺 fixture：${p}` }, async () => {
    const r = await convertFile(p, opts)
    assert.equal(r.ok, true, r.error)
    assert.ok(r.markdown.trim().length > 50, '輸出過短')
    await fn(r)
  })
}
const has = (md, ...kws) => { for (const k of kws) assert.ok(md.includes(k), `缺關鍵字「${k}」`) }

describe('Word', () => {
  withFixture('網宣文.docx', {}, async (r) => {
    assert.equal(r.converter, 'word')
    has(r.markdown, '# 網宣文.docx', '新竹AIoT加速器', '九十米', '睿騰能源')
    assert.deepEqual(r.warnings, []) // 這份沒有嵌入圖
  })
  withFixture('20261019_Staff Mtg_9月.doc', {}, async (r) => {
    assert.equal(r.converter, 'word')
    has(r.markdown, '9月月會', 'Lingo', '經營月會會議記錄')
    assert.match(r.markdown, /\| \*\*Meeting\*\* \| 9月月會/) // textutil → HTML → GFM 表格
  })
})

describe('試算表', () => {
  withFixture('2027年度預算編製時程.xlsx', {}, async (r) => {
    assert.equal(r.converter, 'sheet')
    has(r.markdown, '## 工作表：2027年度編制時程-CPT', '## 工作表：2026年度編制時程-CPT', '預算項目', '財會處')
    has(r.markdown, '## 嵌入圖片', '1 張嵌入圖片（image1.jpeg）', '未啟用 VLM')
    assert.equal(r.warnings.length, 1)
  })
  withFixture('D表_需HMI或Controller搭配項目標註.xlsx', {}, async (r) => {
    has(r.markdown, '## 工作表：D表測項標註', '韌體更新', 'HMI + Controller')
    assert.doesNotMatch(r.markdown, /僅轉出前/) // 列數在預設 300 以內
  })
  withFixture('cost-analysis.csv', {}, async (r) => {
    has(r.markdown, '| UsageDate | Product | CostUSD | Cost | Currency |', '| 2026-09-01 |', 'Azure OpenAI')
    assert.match(r.markdown, /僅轉出前 300 列（原始共 \d+ 列）/)
  })
  withFixture('cost-analysis.csv', { maxRows: 5 }, async (r) => {
    assert.match(r.markdown, /僅轉出前 5 列/)
    assert.equal(r.markdown.split('\n').filter((l) => l.startsWith('| 2026-')).length, 4)
  })
})

describe('PDF（pdftotext，零模型）', () => {
  withFixture('回覆 Hyena H30  HAP 30 Protocol .pdf', {}, async (r) => {
    assert.equal(r.converter, 'pdf')
    has(r.markdown, '# 回覆 Hyena H30  HAP 30 Protocol .pdf', 'HAP 3.0 Protocol', 'Brian Lin')
  })
  withFixture('Hyena C360 FW A41.pdf', {}, async (r) => {
    has(r.markdown, 'C360 FW A41', 'Bootloader', 'A41')
    assert.match(r.markdown, /\n---\n/) // 多頁以 --- 分隔
  })
})

describe('簡報（soffice → PDF → pdftotext + 講者備註）', () => {
  withFixture('電池異常偵測：Cell 不平衡與內阻偏高.pptx', {}, async (r) => {
    assert.equal(r.converter, 'ppt')
    has(r.markdown, '# 電池異常偵測：Cell 不平衡與內阻偏高.pptx', 'Cell 不平衡', '內阻', '## 講者備註', '- 第 1 頁：', 'balancing')
  })
  withFixture('KG_Redmine_專案管理提案.pptx', {}, async (r) => {
    has(r.markdown, 'Redmine', 'Excel', '## 講者備註')
  })
})

describe('信件', () => {
  withFixture('郵件附件-1.eml', {}, async (r) => {
    assert.equal(r.converter, 'mail')
    has(r.markdown, '# BB1攜車架電池 6S1P EP 試作說明Meeting Minutes',
      '- 寄件人：', 'Kevin_Tuanmu@celxpert.com.tw', '- 日期：2026-10-02 08:47', '請查收')
    // 附件：2 張 inline 圖片（未啟用 VLM 只列名）、1 份 pptx 與 1 份 xlsx 都被 DRM/文管系統包裝（檔頭不是 zip）：
    // 要清楚回報失敗原因，而不是像 sheetjs 硬解亂碼那樣假成功
    assert.equal(r.attachments.length, 4)
    for (const ext of ['.pptx', '.xlsx']) {
      const a = r.attachments.find((x) => x.name.endsWith(ext))
      assert.equal(a.converted, false, a.name)
      assert.ok(r.warnings.some((w) => w.includes(a.name) && /DRM\/文管系統/.test(w)), JSON.stringify(r.warnings))
      has(r.markdown, `## 附件：${a.name}`, '（轉換失敗：不是有效的')
    }
    assert.equal(r.attachments.filter((a) => a.converter === 'image').length, 2)
    has(r.markdown, '## 附件圖片（未啟用 VLM', '- image001.png')
  })
  withFixture('_[Triton 主電池] 電充飽燈號問題 補充.msg', {}, async (r) => {
    assert.equal(r.converter, 'mail')
    // 這份 .msg 其實是 MIME 文字（非 Outlook OLE），應自動改用 mailparser
    assert.ok(r.warnings.some((w) => /不是 Outlook OLE/.test(w)))
    has(r.markdown, '# [Triton 主電池] 電充飽燈號問題 補充', 'citty@endex.com.tw', 'V1.2.5', '- 日期：2026-08-03 04:02')
    assert.equal(r.attachments.filter((a) => a.converter === 'image').length, 10)
  })
})
