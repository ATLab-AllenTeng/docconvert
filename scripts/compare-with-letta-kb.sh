#!/usr/bin/env bash
# 把同一批檔用 letta.kb 的 convert.mjs 與 docconvert 各轉一次並 diff，供人工確認行為一致。
#
#   scripts/compare-with-letta-kb.sh [檔案...]       預設：tests/fixtures/local/ 下所有支援的檔
#   環境變數 LETTA_KB_DIR（預設 ~/src/letta.kb）、OUT_DIR（預設 ./.compare-out）
#
# 只比 VLM 以外的路徑：letta.kb 的 PDF 一律走 marker+VLM、圖片一律打 VLM，這兩種這裡不比
# （docconvert 預設 PDF 走 pdftotext、圖片只列名，本來就不同）。簡報在 letta.kb 也走 marker，同樣跳過。
# 兩邊的 frontmatter / 分段（split）/ kb_* 旗標都不同，diff 時去掉 frontmatter、只看內容。
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LETTA_KB_DIR="${LETTA_KB_DIR:-${HOME}/src/letta.kb}"
OUT_DIR="${OUT_DIR:-${HERE}/.compare-out}"
[ -f "${LETTA_KB_DIR}/convert.mjs" ] || { echo "找不到 ${LETTA_KB_DIR}/convert.mjs（設 LETTA_KB_DIR）"; exit 1; }

if [ "$#" -eq 0 ]; then
  set -- "${HERE}"/tests/fixtures/local/*.docx "${HERE}"/tests/fixtures/local/*.doc \
         "${HERE}"/tests/fixtures/local/*.xlsx "${HERE}"/tests/fixtures/local/*.csv \
         "${HERE}"/tests/fixtures/local/*.eml "${HERE}"/tests/fixtures/local/*.msg \
         "${HERE}"/tests/fixtures/local/*.html
fi

A="${OUT_DIR}/letta-kb"; B="${OUT_DIR}/docconvert"
rm -rf "${OUT_DIR}"; mkdir -p "${A}" "${B}"
# letta.kb 的 convert 會寫增量狀態到它的 data/convert-state.json：先備份、跑完還原，不留痕跡；
# 用 --force 確保真的重轉，輸出導到我們的資料夾（不碰 letta.kb 的 imported/）；KB_CONVERT_PART_CHARS=0 關掉分段。
# 預設把 letta.kb 的 OPENAI_BASE_URL 指向關閉的 port，確保這支腳本不會把任何內容送到模型
# （letta.kb 對嵌入圖/附件圖一律打 VLM，所以含圖的檔在 letta.kb 那邊會失敗——預期行為）。
# 要讓 letta.kb 用它自己 .env 的端點真打模型：COMPARE_ALLOW_VLM=1
STATE="${LETTA_KB_DIR}/data/convert-state.json"; STATE_BAK=""
if [ -f "${STATE}" ]; then STATE_BAK="$(mktemp "${TMPDIR:-/tmp}/convert-state.XXXXXX")"; cp "${STATE}" "${STATE_BAK}"; fi
restore_state() {
  if [ -n "${STATE_BAK}" ]; then cp "${STATE_BAK}" "${STATE}"; rm -f "${STATE_BAK}"; else rm -f "${STATE}"; fi
}
trap restore_state EXIT
KB_ENV=(KB_CONVERT_PART_CHARS=0)
[ "${COMPARE_ALLOW_VLM:-0}" = "1" ] || KB_ENV+=(OPENAI_BASE_URL=http://127.0.0.1:9 OPENAI_API_KEY=unused DOCCONVERT_BASE_URL=http://127.0.0.1:9)
strip_fm() { awk 'NR==1 && $0=="---" {fm=1; next} fm && $0=="---" {fm=0; next} !fm {print}' "$1"; }

n=0; same=0
for f in "$@"; do
  [ -f "${f}" ] || continue
  case "${f}" in *.pdf|*.png|*.jpg|*.jpeg|*.webp|*.pptx|*.ppt) echo "跳過（letta.kb 走 VLM）：$(basename "${f}")"; continue ;; esac
  n=$((n + 1))
  name="$(basename "${f}")"; stem="${name%.*}"
  echo "── ${name}"
  ( cd "${LETTA_KB_DIR}" && env "${KB_ENV[@]}" node convert.mjs "${f}" --out "${A}" --force >"${OUT_DIR}/letta-kb.${stem}.log" 2>&1 ) \
    || echo "   letta.kb 轉換失敗（$(grep -m1 '失敗' "${OUT_DIR}/letta-kb.${stem}.log" | sed 's/^ *//' | cut -c1-80)）"
  ( cd "${HERE}" && env "${KB_ENV[@]}" node bin/docconvert.mjs -q --out "${B}" "${f}" >"${OUT_DIR}/docconvert.${stem}.log" 2>&1 ) \
    || echo "   docconvert 轉換失敗（$(grep -m1 '✗' "${OUT_DIR}/docconvert.${stem}.log" | cut -c1-80)）"
  a="$(ls "${A}/${stem}"*.md 2>/dev/null | head -n 1)"; b="$(ls "${B}/${stem}"*.md 2>/dev/null | head -n 1)"
  if [ -z "${a}" ] || [ -z "${b}" ]; then echo "   有一邊沒有輸出（letta.kb: ${a:-無}；docconvert: ${b:-無}）"; continue; fi
  if diff -q <(strip_fm "${a}") <(strip_fm "${b}") >/dev/null; then
    echo "   內容一致"; same=$((same + 1))
  else
    echo "   有差異（$(diff <(strip_fm "${a}") <(strip_fm "${b}") | grep -c '^[<>]') 行）→ diff \"${a}\" \"${b}\""
  fi
done
echo
echo "比對 ${n} 份，內容一致 ${same} 份；輸出在 ${OUT_DIR}/（letta-kb/ 與 docconvert/）"
echo "已知的刻意差異：日期格式（docconvert 一律 yyyy-mm-dd）、Word 表格空表頭升級、.msg 非 OLE 時改走 mailparser、"
echo "DRM 包裝的 Office 檔會明確回報失敗、信件附件遞迴轉換（letta.kb 只列名）。"
