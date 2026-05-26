#!/usr/bin/env python3
"""JSONL bridge for Kokoro-compatible grapheme-to-phoneme conversion."""

import json
import sys
import traceback

from kokorog2p import phonemize


def normalize_language(value):
    normalized = str(value or "").strip().lower().replace("_", "-")
    if normalized in {"en-gb", "en-uk", "gb"}:
        return "en-gb"
    return "en-us"


def token_payload(token):
    meta = getattr(token, "meta", {}) or {}
    return {
        "word": str(getattr(token, "text", "") or ""),
        "phoneme": str(meta.get("phonemes") or ""),
    }


def convert(payload):
    result = phonemize(
        str(payload.get("text") or ""),
        language=normalize_language(payload.get("language")),
        return_ids=False,
        return_phonemes=True,
        use_espeak_fallback=False,
        use_goruut_fallback=False,
        use_cli=False,
        use_spacy=False,
    )

    return {
        "id": payload.get("id"),
        "ok": True,
        "engine": "kokorog2p",
        "phonemes": str(getattr(result, "phonemes", "") or ""),
        "tokens": [token_payload(token) for token in getattr(result, "tokens", [])],
    }


def main():
    for line in sys.stdin:
        raw_line = line.strip()
        if not raw_line:
            continue

        try:
            payload = json.loads(raw_line)
            response = convert(payload)
        except Exception as error:
            response = {
                "id": payload.get("id") if isinstance(locals().get("payload"), dict) else None,
                "ok": False,
                "error": str(error),
                "trace": traceback.format_exc(limit=3),
            }

        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
