#!/usr/bin/env python3
"""docconvert ↔ marker_tools 橋接：單一 PDF → 單一 Markdown。

由 lib/pdf.mjs 以 MARKER_PYTHON（裝有 marker-tools 的 venv python）呼叫。只在 --vlm 下使用。
走 library 模式（不清空 workdir），VLM 可指向 llm-router 的 KB-Vision chain。
"""
import argparse
import sys
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("out_md")
    ap.add_argument("--workdir", required=True, help="逐頁轉換的中繼資料夾")
    ap.add_argument("--model", default="qwen3-vl")
    ap.add_argument("--api-base", default=None, help="OpenAI 相容端點（如 llm-router）")
    ap.add_argument("--api-key", default=None)
    a = ap.parse_args()

    try:
        from marker_tools import convert_pdf, process_folder, assemble_markdown
    except ImportError:
        print("找不到 marker_tools：請確認 MARKER_PYTHON 指向裝好 marker-tools 的 venv", file=sys.stderr)
        return 2

    # 任何轉換例外都收斂成一行錯誤（不噴 Traceback）；pdf.mjs 以非零 exit code 判定失敗
    try:
        wd = Path(a.workdir)
        wd.mkdir(parents=True, exist_ok=True)

        convert_pdf(a.pdf, output_dir=str(wd), paginate=True)

        kwargs = {}
        if a.api_base:
            kwargs["api_base"] = a.api_base
            if a.api_key:
                kwargs["api_key"] = a.api_key
        context = process_folder(wd, model=a.model, **kwargs)

        md = assemble_markdown(context)
        out = Path(a.out_md)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(md, encoding="utf-8")
        print(f"BRIDGE_OK {out} ({len(md)} chars)")
        return 0
    except KeyboardInterrupt:
        raise
    except Exception as e:  # noqa: BLE001 —— CLI 邊界，收斂為單行訊息
        print(f"轉換失敗（{type(e).__name__}）：{e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
