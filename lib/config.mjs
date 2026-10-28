// 設定與環境變數：專案 .env 載入（既有環境變數優先）、DOCCONVERT_* 讀取、~ 展開
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, tmpdir } from 'node:os'

// 跨平台：Windows 的 URL.pathname 會多前導斜線，一律走 fileURLToPath
export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

// 引號包住的 "~/..." 不會被 shell 展開，這裡自己展開（.env 是照字面讀的）
export const expandTilde = (p) =>
  (p === '~' || p.startsWith('~/')) ? resolve(homedir(), p.slice(2)) : p

/** 極簡 .env 載入：KEY=VALUE 一行一個；已存在的環境變數不覆蓋 */
export function loadDotEnv(file = resolve(ROOT, '.env')) {
  if (!existsSync(file)) return false
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (!m || m[1] in process.env) continue
    process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
  }
  return true
}
loadDotEnv()

const DEFAULT_PYTHON = process.platform === 'win32' ? 'python' : 'python3'

/**
 * 取得本次轉換的設定。每次呼叫重新讀環境變數（測試可改 env 再呼叫）。
 * overrides 由 CLI / 程式介面傳入（例如 --max-rows）。
 */
export function getConfig(overrides = {}) {
  const env = process.env
  // 端點與金鑰：DOCCONVERT_* 優先；沿用 letta.kb 既有的 OPENAI_* 當退路（父行程繼承時免重設）
  const baseUrl = (env.DOCCONVERT_BASE_URL || env.OPENAI_BASE_URL || '').replace(/\/$/, '')
  const cfg = {
    markerPython: expandTilde(env.MARKER_PYTHON || DEFAULT_PYTHON),
    sofficeBin: env.SOFFICE_BIN ? expandTilde(env.SOFFICE_BIN) : null,
    pdftotextBin: env.PDFTOTEXT_BIN ? expandTilde(env.PDFTOTEXT_BIN) : 'pdftotext',
    baseUrl,
    apiKey: env.DOCCONVERT_API_KEY || env.OPENAI_API_KEY || '',
    // 走 router 時預設 KB-Vision；沒有端點就打本機 ollama 的 OpenAI 相容端點（qwen3-vl）
    visionModel: env.DOCCONVERT_VISION_MODEL || (baseUrl ? 'KB-Vision' : 'qwen3-vl'),
    xlsxMaxRows: parseInt(env.DOCCONVERT_XLSX_MAX_ROWS || '300', 10),
    tmpRoot: expandTilde(env.DOCCONVERT_TMP || resolve(tmpdir(), 'docconvert')),
    // VLM 逾時（毫秒）：圖片描述 15 分鐘（本機模型慢）
    vlmTimeoutMs: parseInt(env.DOCCONVERT_VLM_TIMEOUT_MS || '900000', 10),
  }
  for (const [k, v] of Object.entries(overrides)) if (v !== undefined && v !== null) cfg[k] = v
  return cfg
}

/** VLM 實際會打的端點（未設定端點＝本機 ollama） */
export const vlmEndpoint = (cfg) => cfg.baseUrl || 'http://localhost:11434/v1'
