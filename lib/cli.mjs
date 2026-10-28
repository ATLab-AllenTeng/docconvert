// CLI 參數解析（抽出來方便測試）
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ROOT } from './config.mjs'

export const VERSION = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version

export const USAGE = `用法：docconvert <file> [more files...] [選項]

把 PDF / Word / PowerPoint / Excel / CSV / HTML / 郵件（.eml .msg）/ 圖片 轉成 Markdown。
預設不呼叫任何模型：PDF 用 pdftotext 抽字、圖片只列名；加 --vlm 才走 marker + VLM。

選項：
  -o, --out <dir>      寫到目錄（檔名 <原檔名>.md，撞名自動加 _<副檔名>/序號），stdout 印出產生的路徑
      --json           stdout 改輸出 JSON { files: [{ source, converter, ok, markdown, warnings, ... }] }
      --vlm            允許呼叫視覺模型：PDF/簡報走 marker_tools（MARKER_PYTHON），圖片與嵌入圖產生描述
      --max-rows <n>   試算表每工作表最多轉出 n 列（預設 DOCCONVERT_XLSX_MAX_ROWS 或 300）
      --no-attachments 信件附件只列名、不遞迴轉換
      --frontmatter    輸出前面加 source / converted / converter 的 YAML frontmatter（-o 模式預設開）
  -q, --quiet          不印進度訊息（進度一律走 stderr，不影響 stdout）
  -V, --version        版本
  -h, --help           本說明

結束碼：0 成功；1 有檔案失敗（--json 模式下只有「全部失敗」才回 1，單檔錯誤進各自的 error/warnings）；2 參數錯誤
`

export function parseArgs(argv) {
  const o = { files: [], out: null, json: false, vlm: false, maxRows: undefined, attachments: true, frontmatter: null, quiet: false, help: false, version: false }
  const needVal = (flag, i) => {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('-')) throw new Error(`${flag} 需要一個值`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { o.files.push(...argv.slice(i + 1)); break }
    else if (a === '-o' || a === '--out') o.out = needVal(a, i++)
    else if (a.startsWith('--out=')) o.out = a.slice(6)
    else if (a === '--json') o.json = true
    else if (a === '--vlm') o.vlm = true
    else if (a === '--no-vlm') o.vlm = false
    else if (a === '--max-rows') {
      const v = parseInt(needVal(a, i++), 10)
      if (!Number.isInteger(v) || v < 1) throw new Error('--max-rows 需要正整數')
      o.maxRows = v
    } else if (a.startsWith('--max-rows=')) {
      const v = parseInt(a.slice(11), 10)
      if (!Number.isInteger(v) || v < 1) throw new Error('--max-rows 需要正整數')
      o.maxRows = v
    } else if (a === '--no-attachments') o.attachments = false
    else if (a === '--frontmatter') o.frontmatter = true
    else if (a === '--no-frontmatter') o.frontmatter = false
    else if (a === '-q' || a === '--quiet') o.quiet = true
    else if (a === '-h' || a === '--help') o.help = true
    else if (a === '-V' || a === '--version') o.version = true
    else if (a.startsWith('-') && a !== '-') throw new Error(`未知的選項：${a}`)
    else o.files.push(a)
  }
  return o
}
