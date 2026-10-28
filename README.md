# docconvert

把常見的辦公文件轉成 Markdown 的獨立工具：PDF、Word（.docx/.doc）、PowerPoint（.pptx/.ppt）、Excel/CSV、HTML、郵件（.eml/.msg，含附件）、圖片。
從 [letta.kb](https://github.com/ATLab-AllenTeng/letta.kb) 的 `convert.mjs` 抽出，去掉知識庫耦合，讓 letta.kb 與 [mail-agent](https://github.com/ATLab-AllenTeng/mail-agent) 都能透過 CLI（subprocess）或 Node import 呼叫。

**核心原則：預設不呼叫任何模型。** 所有格式都有零模型的確定性路徑；只有加 `--vlm` 才會把 PDF/簡報交給 marker_tools + 視覺模型、替圖片產生描述。

## 支援格式與路徑

| 格式 | 預設（零模型、離線） | 加 `--vlm` |
| --- | --- | --- |
| `.pdf` | `pdftotext -layout` 純抽字，逐頁以 `---` 分隔 | marker_tools（逐頁轉換 + VLM 組稿、OCR、圖片描述） |
| `.docx` | mammoth → HTML → turndown（GFM 表格）；嵌入圖片只列清單 | 同左，嵌入圖片逐張 VLM 描述附在文末 |
| `.doc` | macOS `textutil` → HTML → Markdown；沒有 textutil 時 LibreOffice 轉 .docx 再走上列 | 同左 |
| `.pptx` / `.ppt` | LibreOffice 轉 PDF → `pdftotext`；`.pptx` 另抽講者備註附在文末 | LibreOffice 轉 PDF → marker_tools |
| `.xlsx` / `.xls` / `.csv` | SheetJS → 每工作表一個 Markdown 表格（公式取算好的值、日期 `yyyy-mm-dd`）；嵌入圖片只列清單 | 同左，嵌入圖片 VLM 描述 |
| `.html` / `.htm` | turndown（GFM 表格），圖片僅留來源註記 | 同左 |
| `.eml` / `.msg` | 信頭 + 內文；**附件遞迴轉換**（Office/PDF/CSV…照各自路徑）；圖片附件只列清單 | 同左，圖片附件 VLM 描述 |
| `.png` / `.jpg` / `.jpeg` / `.webp` | 輸出佔位並回報「未啟用 VLM」 | VLM 產生描述筆記（類型自路由：電路圖、波形圖、流程圖…） |

不支援的副檔名會明確報錯（非零結束碼），不會靜默跳過。

### VLM 使用政策（重要）

- 預設 **不送任何內容到任何模型**。mail-agent 讀 Exchange 信件時**一律不加 `--vlm`**（信件附件隱私）。
- letta.kb 匯入知識庫時**加 `--vlm`**：PDF 走 marker（表格/掃描件品質遠勝 pdftotext），圖片與嵌入圖有描述可供檢索。
- `--vlm` 的端點由 `DOCCONVERT_BASE_URL` 決定（建議指向 llm-router 的 `KB-Vision` chain）；未設定時打本機 ollama，資料仍不出機器。

## 安裝

需求：Node.js 20+、[LibreOffice](https://www.libreoffice.org/)（簡報、.doc 退路）、poppler 的 `pdftotext`（PDF 預設路徑）。macOS：

```bash
brew install node poppler && brew install --cask libreoffice
```

然後：

```bash
git clone https://github.com/ATLab-AllenTeng/docconvert.git ~/src/docconvert
cd ~/src/docconvert
scripts/docconvert.sh install          # 加 --skip-marker 可跳過 marker venv（數 GB 的 torch）
```

`install` 會：檢查 Node 20+ → `npm install` → 檢查 soffice/pdftotext/textutil → 建 `.venvs/marker` 並從
[marker_tools](https://github.com/ATLab-AllenTeng/marker_tools) 安裝（`--vlm` 用）→ 建 `.env`（互動填 VLM 端點/金鑰，可留空）→
在 `~/.local/bin/docconvert` 建捷徑。可重跑。`scripts/docconvert.sh status` 看現況。

## CLI 用法

```
docconvert <file> [more files...] [選項]

  -o, --out <dir>      寫到目錄（檔名 <原檔名>.md，撞名自動改 <名>_<副檔名>.md、再撞加序號），stdout 印出產生的路徑
      --json           stdout 改輸出 JSON（見下）
      --vlm            允許呼叫視覺模型（PDF/簡報走 marker_tools、圖片與嵌入圖產生描述）
      --max-rows <n>   試算表每工作表最多轉出 n 列（預設 DOCCONVERT_XLSX_MAX_ROWS 或 300）
      --no-attachments 信件附件只列名、不遞迴轉換
      --frontmatter    輸出前加 source / converted / converter 的 YAML frontmatter（-o 模式預設開）
  -q, --quiet          不印進度（進度一律走 stderr，stdout 只有結果）
  -V, --version / -h, --help
```

透過捷徑：`docconvert run <file>`（或直接 `docconvert <file>`）；沒裝捷徑就 `node ~/src/docconvert/bin/docconvert.mjs <file>`。

- 多檔輸出到 stdout 時以 `\n---\n` 分隔；進度與錯誤一律走 stderr。
- 結束碼：`0` 成功；`1` 有檔案失敗；`2` 參數錯誤。`--json` 模式下單檔錯誤進各自的 `error`，只有**全部**失敗才回 `1`。

### `--json` 格式

```json
{
  "version": "0.1.0",
  "vlm": false,
  "files": [
    {
      "source": "/abs/path/報告.pdf",
      "converter": "pdf",            // pdf | word | ppt | sheet | html | mail | image | null（不支援）
      "ok": true,
      "markdown": "# 報告.pdf\n\n...",
      "warnings": ["1 張嵌入圖片未轉換：未啟用 VLM（加 --vlm 才會呼叫模型產生描述）"],
      "error": "…",                  // 只有 ok=false 時出現
      "attachments": [               // 只有信件（converter=mail）有
        { "name": "minutes.xlsx", "size": 53248, "converter": "sheet", "converted": true,
          "warnings": [], "markdown": "# minutes.xlsx\n\n## 工作表：..." },
        { "name": "image001.png", "size": 193727, "converter": "image", "converted": false,
          "warnings": ["未啟用 VLM（加 --vlm 才會呼叫模型產生描述）"] }
      ],
      "output": "/out/報告.md"        // 只有 -o 模式有
    }
  ]
}
```

信件的 `markdown` 已把成功轉換的附件以 `## 附件：<檔名>` 區段接在內文後（附件內的標題自動降一級）；
失敗/未轉換的附件在 `## 附件圖片…` 或 `## 其他附件…` 列名。`attachments` 另提供每個附件的獨立結果。

## 程式介面（Node）

```js
import { convertFile } from 'docconvert'   // 或 import from '/path/to/docconvert/lib/index.mjs'

const r = await convertFile('/path/報告.docx', { vlm: true, log: console.error })
// r = { source, converter, ok, markdown, warnings, error?, attachments? }
if (!r.ok) throw new Error(r.error)
```

`convertFile(path, opts)` 永不 throw（失敗時 `ok:false` + `error`）。opts：`vlm`、`maxRows`、`attachments`（預設 true）、`log(msg)`、`quiet`、`config`（覆蓋 `getConfig()` 欄位，測試用）。
另外匯出 `convertFiles`、`outNameFor`、`finalizeOutput`、`htmlToMd`、`pptxSpeakerNotes`、`parseMail`、`SUPPORTED_EXT`、`converterFor` 等（見 `lib/index.mjs`）。

## 環境變數

由專案的 `.env` 載入（`.env.example` 有說明）；**既有環境變數優先**。全部選配。

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `DOCCONVERT_BASE_URL` | （退回 `OPENAI_BASE_URL`，再無則本機 ollama `http://localhost:11434/v1`） | `--vlm` 的 OpenAI 相容端點；接 llm-router 填 `http://127.0.0.1:9001/v1` |
| `DOCCONVERT_API_KEY` | （退回 `OPENAI_API_KEY`） | 端點金鑰（llm-router 的 `LLM_ROUTER_API_KEY`） |
| `DOCCONVERT_VISION_MODEL` | 有端點時 `KB-Vision`；無端點時 `qwen3-vl` | 視覺模型名稱 |
| `DOCCONVERT_VLM_TIMEOUT_MS` | `900000` | 單張圖片描述逾時 |
| `MARKER_PYTHON` | Windows `python`，其他 `python3` | 裝好 marker_tools 的 venv python（install 會填成 `.venvs/marker/bin/python`） |
| `SOFFICE_BIN` | 自動偵測 `/Applications/LibreOffice.app/...`、`C:\Program Files\LibreOffice\...`、PATH | LibreOffice 執行檔 |
| `PDFTOTEXT_BIN` | `pdftotext` | poppler 的 pdftotext |
| `DOCCONVERT_XLSX_MAX_ROWS` | `300` | 試算表每工作表列數上限 |
| `DOCCONVERT_TMP` | `<系統暫存區>/docconvert` | 中繼檔、LibreOffice 獨立 profile、marker 失敗時保留的中繼檔 |

## 呼叫範例

### mail-agent（Python，subprocess，**不加 `--vlm`**）

```python
import json, subprocess

DOCCONVERT = ["node", "/Users/you/src/docconvert/bin/docconvert.mjs"]  # 或 ~/.local/bin/docconvert

def to_markdown(path: str) -> dict:
    """信件附件 → Markdown。絕不加 --vlm：附件內容不送任何模型。"""
    p = subprocess.run([*DOCCONVERT, "--json", "--quiet", path], capture_output=True, text=True, timeout=600)
    data = json.loads(p.stdout)
    f = data["files"][0]
    if not f["ok"]:
        raise RuntimeError(f["error"])
    return f  # f["markdown"], f["warnings"], f.get("attachments")
```

也可以直接把整封 `.eml` 丟給它：信頭、內文與可轉換的附件一次變成一份 Markdown。

### letta.kb（Node import，**加 `--vlm`**）

```js
import { convertFile } from '../docconvert/lib/index.mjs'   // 或 npm link 後 import 'docconvert'

const r = await convertFile(src, { vlm: true, log: (m) => console.log(m) })
if (!r.ok) { console.error(`   失敗：${r.error}`); continue }
writeFileSync(outMd, `---\nsource_${r.converter}: ${src}\nconverted: ${today}\n---\n\n${r.markdown}`)
// 之後照常 split / finalize / ingest；kb_* 旗標、分段、增量狀態都留在 letta.kb
```

用 CLI 也行：`docconvert --vlm --json <file>`，`DOCCONVERT_BASE_URL`/`DOCCONVERT_API_KEY` 沒設時會沿用 letta.kb 環境裡的 `OPENAI_BASE_URL`/`OPENAI_API_KEY`。

## 與 letta.kb `convert.mjs` 的差異

抽出的功能：試算表（SheetJS）、Word（mammoth / textutil / soffice）、簡報（soffice → PDF，講者備註）、PDF（marker_bridge）、圖片與嵌入圖（VLM）、HTML（turndown+gfm）、郵件（mailparser / msgreader，附件）、zip 讀取、輸出檔名規則（`outNameFor`）、frontmatter 整理（`finalizeOutput`）、soffice 偵測、marker 輸出收斂。
留在 letta.kb 的：輸出目錄（`KB_CONVERT_OUT`/`KB_DATA_DIR`）、增量狀態（`data/convert-state.json`）、`kb_*` frontmatter 旗標與 content-flags、split 分段、jsonl 剪報、`KB_TEXT_MODEL` 文字摘要。

刻意不同的行為：

- **模型 opt-in**：letta.kb 的 PDF 一律 marker+VLM、圖片一律打 VLM；docconvert 預設 PDF 走 `pdftotext`、圖片只列名，`--vlm` 才一樣。
- **簡報**：無 `--vlm` 時 soffice → PDF → pdftotext（letta.kb 一律 marker）。
- **信件附件遞迴轉換**：letta.kb 只對圖片附件做 VLM、其他附件列名；docconvert 把 Office/PDF/CSV 附件各自轉成 Markdown 接在信後。
- **`.msg` 檔頭偵測**：Outlook 另存的 `.msg` 若其實是 MIME 文字（實測有），自動改用 mailparser（letta.kb 會讀成空信而失敗）。
- **DRM/文管包裝的 Office 檔**：檔頭不是 zip 就明確回報失敗原因（letta.kb 的 sheetjs 會把亂碼硬解成「成功」）。
- **試算表日期**：一律 `yyyy-mm-dd`（有時間加 `hh:mm`），其他儲存格取 Excel 顯示文字（letta.kb 用原始值，日期變成 JS `Date.toString()`）。
- **Word 表格**：mammoth 不產生 `<th>`，GFM 表頭列會全空；docconvert 把第一列資料升為表頭。
- **講者備註**：解開 XML 實體（`&lt;` → `<`）。
- **LibreOffice 獨立 profile**：soffice 一律帶 `-env:UserInstallation=<DOCCONVERT_TMP>/lo-profile`，避免與開著的 LibreOffice 視窗共用 profile 而靜默失敗。
- 進度訊息走 stderr（letta.kb 走 stdout）；暫存檔在系統暫存區而不是專案內 `.convert-tmp/`。

`scripts/compare-with-letta-kb.sh` 把同一批檔兩邊各轉一次並 diff（去掉 frontmatter 只比內容），供人工確認。
它把 letta.kb 的 `OPENAI_BASE_URL` 指向關閉的 port 以確保不打模型，所以含圖片的檔在 letta.kb 那邊會失敗——這是預期的。

## 測試

```bash
npm test
```

- `tests/unit.test.mjs`：純邏輯，fixture 在測試內用 SheetJS/JSZip 動態產生，不依賴外部檔、不打網路。
- `tests/integration.test.mjs`：讀 `tests/fixtures/local/`（公司內部文件，整個目錄 gitignore，**絕不 commit**），檔不存在就 skip；在無 `--vlm` 下跑，並把 `DOCCONVERT_BASE_URL` 指向關閉的 port，任何意外的模型呼叫都會立刻失敗。需要 LibreOffice。

## 已知限制

- `.ppt`（舊格式）沒有講者備註抽取；`.xls` 沒有嵌入圖片。
- 嵌入圖片不解析在原文中的位置，統一附在文末「嵌入圖片」一節；Excel 原生圖表沒有圖檔可取。
- 掃描件 PDF 在預設路徑會回報「沒有可抽取的文字」，要 `--vlm`（marker 含 OCR）。
- 信件附件遞迴最多 3 層；`.msg`（Outlook OLE）附件取不到內容時只列名。
- marker 第一次執行要下載模型權重（HF Hub），之後離線可用。
- Windows：保留了 soffice 路徑偵測與 `MARKER_PYTHON` 預設 `python` 的邏輯，但本版**尚未在 Windows 實測**；`textutil` 不存在時 `.doc` 走 LibreOffice。

## 授權

與 letta.kb 相同（私有、未公開授權）。marker_tools 為 GPL-3.0，透過獨立 Python 子行程呼叫，不連結進本專案。
