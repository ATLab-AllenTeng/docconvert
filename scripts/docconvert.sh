#!/usr/bin/env bash
# docconvert 安裝與操作（macOS；bash 3.2 相容；比照 letta.kb 的 scripts/kb.sh 與 mail-agent 的 scripts/mail-agent.sh）
#
#   docconvert.sh install [--skip-marker]   檢查 Node 20+、npm install、檢查 soffice/pdftotext/textutil、
#                                           建 .venvs/marker 並安裝 marker_tools（--vlm 用，數 GB；可跳過）、
#                                           建 .env、在 ~/.local/bin/docconvert 建捷徑（一次性，可重跑）
#   docconvert.sh status                    外部工具、venv、.env、VLM 端點現況
#   docconvert.sh run <file...> [選項]      執行轉換（等同 node bin/docconvert.mjs）
#   docconvert.sh help
#
# 設定一律在專案目錄的 .env（lib/config.mjs 自行載入，既有環境變數優先）。
set -u

# ── 路徑 ─────────────────────────────────────────────────────────────
# 透過 ~/.local/bin/docconvert 符號連結執行時，BASH_SOURCE 是連結本身，
# 要先一路解析到真正的腳本位置，才能正確推算專案目錄（macOS 舊版沒有 readlink -f）
resolve_link() {
  local f="$1" d
  while [ -L "${f}" ]; do
    d="$(cd "$(dirname "${f}")" && pwd)"
    f="$(readlink "${f}")"
    case "${f}" in /*) ;; *) f="${d}/${f}" ;; esac
  done
  echo "${f}"
}
SCRIPT_PATH="$(resolve_link "${BASH_SOURCE[0]}")"
APP_DIR="$(cd "$(dirname "${SCRIPT_PATH}")/.." && pwd)"
ENV_FILE="${APP_DIR}/.env"
ENV_EXAMPLE="${APP_DIR}/.env.example"
MARKER_VENV="${APP_DIR}/.venvs/marker"
MARKER_PY="${MARKER_VENV}/bin/python"
MARKER_REPO="git+https://github.com/ATLab-AllenTeng/marker_tools.git"
BIN_LINK="${HOME}/.local/bin/docconvert"

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }
die()  { red "錯誤：$*"; exit 1; }
step() { printf '\n\033[36m[%s] %s\033[0m\n' "$1" "$2"; }

# ── .env 讀寫 ────────────────────────────────────────────────────────
# env_get KEY：環境變數優先，其次 .env（去掉成對引號與 export 前綴）
env_get() {
  local key="$1" val
  eval "val=\${${key}:-}"
  if [ -n "${val}" ]; then echo "${val}"; return; fi
  [ -f "${ENV_FILE}" ] || return 0
  sed -n -E "s/^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=[[:space:]]*//p" "${ENV_FILE}" \
    | head -n 1 | sed -E "s/^\"(.*)\"\$/\1/; s/^'(.*)'\$/\1/"
}
# env_set KEY VALUE：已有該行（含被註解掉的）就改，沒有就附加到檔尾
env_set() {
  local key="$1" tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/docconvert.XXXXXX")"
  NEWVAL="$2" awk -v k="${key}" '
    BEGIN { v = ENVIRON["NEWVAL"]; done = 0 }
    !done && $0 ~ ("^[[:space:]]*(#[[:space:]]*)?(export[[:space:]]+)?" k "[[:space:]]*=") {
      print k "=" v; done = 1; next
    }
    { print }
    END { if (!done) print k "=" v }
  ' "${ENV_FILE}" > "${tmp}" && mv "${tmp}" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
}
mask() { local s="$1"; if [ "${#s}" -le 4 ]; then echo "****"; else printf '****%s\n' "${s: -4}"; fi; }

# ask VAR "提示" "預設"：互動式詢問；非 tty 時直接用預設
ask() {
  local __var="$1" prompt="$2" default="$3" input=""
  if [ -t 0 ]; then printf '%s [%s]: ' "${prompt}" "${default}"; IFS= read -r input; fi
  eval "${__var}=\"\${input:-\${default}}\""
}
# ask_secret VAR "提示" "既有值"：輸入不回顯；留空＝保留既有值
ask_secret() {
  local __var="$1" prompt="$2" existing="$3" input=""
  if [ -t 0 ]; then
    if [ -n "${existing}" ]; then printf '%s（目前 %s，直接 Enter 保留）: ' "${prompt}" "$(mask "${existing}")"
    else printf '%s（可留空，之後再填）: ' "${prompt}"; fi
    IFS= read -r -s input; echo
  fi
  eval "${__var}=\"\${input:-\${existing}}\""
}

# ── 外部工具偵測 ─────────────────────────────────────────────────────
soffice_path() {
  local c
  c="$(env_get SOFFICE_BIN)"; [ -n "${c}" ] && [ -x "${c}" ] && { echo "${c}"; return; }
  command -v soffice >/dev/null 2>&1 && { command -v soffice; return; }
  [ -x /Applications/LibreOffice.app/Contents/MacOS/soffice ] && { echo /Applications/LibreOffice.app/Contents/MacOS/soffice; return; }
  echo ""
}
alive() { curl -fsS --max-time 2 "$1" >/dev/null 2>&1; }
endpoint_ok() { local base="$1"; alive "${base%/}/models" || alive "${base%/v1}/health" || alive "${base%/v1/}/health"; }
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major; major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)"
  [ -n "${major}" ] && [ "${major}" -ge 20 ]
}

# ── install ──────────────────────────────────────────────────────────
cmd_install() {
  local skip_marker=0
  [ "${1:-}" = "--skip-marker" ] && skip_marker=1
  echo "docconvert 安裝"
  echo "專案位置：${APP_DIR}"

  step 1 "Node.js 20+"
  node_ok || die "需要 Node.js 20 以上（目前：$(node --version 2>/dev/null || echo 未安裝)）；macOS：brew install node"
  grn "  node $(node --version)、npm $(npm --version)"

  step 2 "npm 相依"
  # ~/.npm 快取裡若有舊版 npm 留下的 root 檔案，npm 會直接中止；退回暫存快取再試一次（不碰使用者的快取）
  ( cd "${APP_DIR}" && npm install --no-audit --no-fund ) \
    || { ylw "  npm install 失敗，改用暫存快取重試（若是 ~/.npm 權限問題，可另外執行 sudo chown -R \$(id -u):\$(id -g) ~/.npm）"
         ( cd "${APP_DIR}" && npm install --no-audit --no-fund --cache "$(mktemp -d "${TMPDIR:-/tmp}/docconvert-npm.XXXXXX")" ) \
           || die "npm install 失敗（看上方訊息）"; }
  grn "  node_modules 就緒"

  step 3 "外部工具"
  local so; so="$(soffice_path)"
  if [ -n "${so}" ]; then grn "  LibreOffice：${so}（.pptx/.ppt 與 .doc 退路需要）"
  else ylw "  找不到 LibreOffice：簡報無法轉換（brew install --cask libreoffice，或 .env 設 SOFFICE_BIN）"; fi
  if command -v pdftotext >/dev/null 2>&1; then grn "  pdftotext：$(command -v pdftotext)（PDF 預設抽字）"
  else ylw "  找不到 pdftotext：PDF 無法轉換（brew install poppler）"; fi
  if command -v textutil >/dev/null 2>&1; then grn "  textutil：$(command -v textutil)（.doc 舊格式；macOS 內建）"
  else ylw "  找不到 textutil（非 macOS 正常）：.doc 會改走 LibreOffice"; fi

  step 4 "PDF 解析環境 marker_tools（只有 --vlm 會用到）"
  if [ "${skip_marker}" = "1" ]; then
    ylw "  --skip-marker：跳過（之後要用 --vlm 再跑一次 install）"
  elif [ -x "${MARKER_PY}" ] && "${MARKER_PY}" -c 'import marker_tools' >/dev/null 2>&1; then
    grn "  已有 ${MARKER_VENV}（marker_tools $("${MARKER_PY}" -c 'import marker_tools; print(marker_tools.__version__)' 2>/dev/null)）"
  else
    command -v python3 >/dev/null 2>&1 || die "找不到 python3（brew install python）；或改用 install --skip-marker"
    python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' \
      || die "marker_tools 需要 Python 3.10 以上，目前是 $(python3 --version 2>&1)"
    echo "  建立 venv 並安裝 marker_tools（含 marker-pdf、torch，數 GB，第一次要幾分鐘）..."
    [ -x "${MARKER_PY}" ] || python3 -m venv "${MARKER_VENV}" || die "建立 venv 失敗"
    "${MARKER_PY}" -m pip install -q --upgrade pip >/dev/null 2>&1 || true
    if "${MARKER_PY}" -m pip install -q "${MARKER_REPO}"; then
      grn "  完成：${MARKER_PY}"
    else
      ylw "  marker_tools 安裝失敗：--vlm 的 PDF/簡報路徑不可用（其他格式與預設路徑不受影響）；稍後可重跑 install"
    fi
  fi

  step 5 "設定檔 .env"
  if [ ! -f "${ENV_FILE}" ]; then
    cp "${ENV_EXAMPLE}" "${ENV_FILE}" && chmod 600 "${ENV_FILE}"
    grn "  已從 .env.example 建立 ${ENV_FILE}"
  else
    chmod 600 "${ENV_FILE}"
    grn "  已有 ${ENV_FILE}，以下輸入會更新它（直接 Enter 保留目前值）"
  fi
  [ -x "${MARKER_PY}" ] && env_set MARKER_PYTHON "${MARKER_PY}"
  [ -n "${so}" ] && [ "${so}" != "$(command -v soffice 2>/dev/null)" ] && env_set SOFFICE_BIN "${so}"
  local base key model
  ask base  "VLM 端點 base URL（--vlm 用；llm-router 是 http://127.0.0.1:9001/v1；留空＝本機 ollama）" "$(env_get DOCCONVERT_BASE_URL)"
  ask model "VLM 模型名稱" "$(env_get DOCCONVERT_VISION_MODEL)"
  ask_secret key "VLM 端點 API 金鑰（輸入不回顯）" "$(env_get DOCCONVERT_API_KEY)"
  [ -n "${base}" ]  && env_set DOCCONVERT_BASE_URL "${base}"
  [ -n "${model}" ] && env_set DOCCONVERT_VISION_MODEL "${model}"
  case "${key}" in ""|"<"*) ;; *) env_set DOCCONVERT_API_KEY "${key}" ;; esac
  grn "  已寫入 ${ENV_FILE}（權限 600，只有本人可讀）"
  if [ -n "${base}" ]; then
    if endpoint_ok "${base}"; then grn "  ${base} 有回應"; else ylw "  ${base} 沒有回應（--vlm 時才需要；llm-router 請用 kb start 啟動）"; fi
  fi

  step 6 "指令捷徑"
  if [ -d "$(dirname "${BIN_LINK}")" ]; then
    ln -sfn "${APP_DIR}/scripts/docconvert.sh" "${BIN_LINK}"
    grn "  已建立 ${BIN_LINK} → 之後可直接輸入 docconvert <子命令>（docconvert run <檔案>）"
    case ":${PATH}:" in *":$(dirname "${BIN_LINK}"):"*) ;; *) ylw "  注意：$(dirname "${BIN_LINK}") 不在 PATH 中" ;; esac
  else
    echo "  （沒有 $(dirname "${BIN_LINK}")，略過；可直接用 ${APP_DIR}/scripts/docconvert.sh 或 node ${APP_DIR}/bin/docconvert.mjs）"
  fi

  echo
  grn "安裝完成。試跑："
  echo "  docconvert run <檔案.docx>"
  echo "  docconvert run --json <檔案.pdf>"
  echo "  node ${APP_DIR}/bin/docconvert.mjs --help"
}

# ── status ───────────────────────────────────────────────────────────
cmd_status() {
  echo "docconvert 狀態"
  echo "專案位置：${APP_DIR}"
  echo
  if node_ok; then grn "● node        $(node --version)"; else red "○ node        需要 20+（目前 $(node --version 2>/dev/null || echo 未安裝)）"; fi
  if [ -d "${APP_DIR}/node_modules/mammoth" ]; then grn "● npm 相依    已安裝"; else red "○ npm 相依    未安裝（執行 install）"; fi
  local so; so="$(soffice_path)"
  if [ -n "${so}" ]; then grn "● LibreOffice ${so}"; else red "○ LibreOffice 找不到（簡報不可轉）"; fi
  if command -v pdftotext >/dev/null 2>&1; then grn "● pdftotext   $(command -v pdftotext)"; else red "○ pdftotext   找不到（PDF 不可轉）"; fi
  if command -v textutil >/dev/null 2>&1; then grn "● textutil    $(command -v textutil)"; else ylw "－ textutil    無（.doc 走 LibreOffice）"; fi
  local mp; mp="$(env_get MARKER_PYTHON)"; mp="${mp:-${MARKER_PY}}"
  if [ -x "${mp}" ] && "${mp}" -c 'import marker_tools' >/dev/null 2>&1; then
    grn "● marker      ${mp}（marker_tools $("${mp}" -c 'import marker_tools; print(marker_tools.__version__)' 2>/dev/null)；--vlm 可用）"
  else
    ylw "○ marker      未安裝（--vlm 的 PDF/簡報路徑不可用；install 可補）"
  fi
  if [ -f "${ENV_FILE}" ]; then
    local perm; perm="$(stat -f '%Lp' "${ENV_FILE}" 2>/dev/null || echo '?')"
    if [ "${perm}" = "600" ]; then grn "● .env        ${ENV_FILE}（權限 600）"; else ylw "● .env        ${ENV_FILE}（權限 ${perm}，建議 chmod 600）"; fi
  else
    ylw "○ .env        未建立（執行 install；沒有也能跑預設路徑）"
  fi
  echo
  local base key model
  base="$(env_get DOCCONVERT_BASE_URL)"; [ -z "${base}" ] && base="$(env_get OPENAI_BASE_URL)"
  model="$(env_get DOCCONVERT_VISION_MODEL)"; key="$(env_get DOCCONVERT_API_KEY)"; [ -z "${key}" ] && key="$(env_get OPENAI_API_KEY)"
  echo "VLM 設定（只有 --vlm 會用到；.env，環境變數可覆蓋）："
  echo "  DOCCONVERT_BASE_URL     = ${base:-（未設定，--vlm 時打本機 ollama http://localhost:11434/v1）}"
  echo "  DOCCONVERT_VISION_MODEL = ${model:-（未設定，預設 KB-Vision；無端點時 qwen3-vl）}"
  case "${key}" in "") echo "  DOCCONVERT_API_KEY      = 未設定" ;; *) echo "  DOCCONVERT_API_KEY      = $(mask "${key}")" ;; esac
  echo "  DOCCONVERT_XLSX_MAX_ROWS= $(env_get DOCCONVERT_XLSX_MAX_ROWS)"
  if [ -n "${base}" ]; then
    if endpoint_ok "${base}"; then grn "● VLM 端點    ${base} 有回應"; else red "○ VLM 端點    ${base} 沒有回應"; fi
  fi
  if [ -L "${BIN_LINK}" ]; then grn "● 捷徑        ${BIN_LINK} → $(readlink "${BIN_LINK}")"; else echo "○ 捷徑        無（install 會建 ${BIN_LINK}）"; fi
}

cmd_run() {
  [ -d "${APP_DIR}/node_modules/mammoth" ] || die "npm 相依未安裝，請先執行：$0 install"
  exec node "${APP_DIR}/bin/docconvert.mjs" "$@"
}

usage() { sed -n '2,11p' "${SCRIPT_PATH}" | sed 's/^# \{0,1\}//'; }

case "${1:-help}" in
  install)        shift; cmd_install "$@" ;;
  status|st)      cmd_status ;;
  run)            shift; cmd_run "$@" ;;
  help|-h|--help) usage ;;
  *)              cmd_run "$@" ;;   # 直接接檔名／選項也行：docconvert <file> --json
esac
