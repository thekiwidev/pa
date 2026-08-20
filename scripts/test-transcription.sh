#!/usr/bin/env bash
# Prove the voice-note path without recording one.
#
# Synthesises speech, encodes it as Opus in an Ogg container — byte-for-byte
# the format Telegram sends for a voice note — and runs it through the real
# TRANSCRIBE tier on the dev deployment.
#
#   ./scripts/test-transcription.sh
#   ./scripts/test-transcription.sh "some other sentence to say"
set -euo pipefail

PHRASE="${1:-Remind me to call Paul tomorrow at ten in the morning}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

command -v ffmpeg >/dev/null || { echo "needs ffmpeg (brew install ffmpeg)" >&2; exit 1; }

say -o "$WORK/vn.aiff" "$PHRASE"
ffmpeg -y -loglevel error -i "$WORK/vn.aiff" -c:a libopus -b:a 24k -ar 48000 -ac 1 "$WORK/vn.ogg"

echo "said:      $PHRASE"
echo "encoded:   $(wc -c < "$WORK/vn.ogg" | tr -d ' ') bytes of Opus/Ogg"

python3 -c "
import base64, json, sys
data = base64.b64encode(open(sys.argv[1],'rb').read()).decode()
print(json.dumps({'task':'TRANSCRIBE_VOICE','audioBase64':data,'audioMime':'audio/ogg'}))
" "$WORK/vn.ogg" > "$WORK/args.json"

bunx convex run debug:pingAI "$(cat "$WORK/args.json")" 2>/dev/null \
  | python3 -c "import json,sys; r=json.load(sys.stdin); print('model:    ', r['model']); print('heard:    ', r['text'])"
