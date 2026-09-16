#!/usr/bin/env bash
# Télécharge les modèles ONNX qui ne sont pas livrés par npm.
# Les modèles chinois PP-OCRv4 viennent de @gutenye/ocr-models ; ceux-ci sont
# les exports ONNX officiels PaddlePaddle nécessaires au français.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODELS="$HERE/server/models"
mkdir -p "$MODELS"

get() { # url  destination
    [ -s "$2" ] && { echo "  déjà là : $(basename "$2")"; return; }
    echo "  téléchargement : $(basename "$2")"
    curl -fsSL -o "$2.part" "$1"
    mv "$2.part" "$2"
}

HF=https://huggingface.co
get "$HF/PaddlePaddle/PP-OCRv5_mobile_det_onnx/resolve/main/inference.onnx" \
    "$MODELS/PP-OCRv5_mobile_det.onnx"
get "$HF/PaddlePaddle/latin_PP-OCRv5_mobile_rec_onnx/resolve/main/inference.onnx" \
    "$MODELS/latin_PP-OCRv5_mobile_rec.onnx"
get "$HF/cycloneboy/latin_PP-OCRv3_rec_infer/resolve/main/model.onnx" \
    "$MODELS/latin_PP-OCRv3_rec_infer.onnx"

# Le dictionnaire v3 est publié en CRLF ; la lib découpe sur \n, il faut du LF
# et surtout pas de saut de ligne final (il décalerait l'index du caractère espace).
if [ ! -s "$MODELS/latin_dict.txt" ]; then
    echo "  dictionnaire latin v3"
    curl -fsSL "$HF/cycloneboy/latin_PP-OCRv3_rec_infer/resolve/main/latin_dict.txt" \
        | sed 's/\r$//' | perl -0pe 's/\n\z//' > "$MODELS/latin_dict.txt"
fi

# Le dictionnaire v5 n'est publié que dans le YAML d'inférence.
if [ ! -s "$MODELS/latin_v5_dict.txt" ]; then
    echo "  dictionnaire latin v5"
    curl -fsSL -o /tmp/ocr-snip-v5.yml \
        "$HF/PaddlePaddle/latin_PP-OCRv5_mobile_rec_onnx/resolve/main/inference.yml"
    python3 - "$MODELS/latin_v5_dict.txt" <<'PY'
import sys, yaml
conf = yaml.safe_load(open('/tmp/ocr-snip-v5.yml', encoding='utf-8'))
chars = [str(c) for c in conf['PostProcess']['character_dict']]
open(sys.argv[1], 'w', encoding='utf-8').write('\n'.join(chars))
PY
    rm -f /tmp/ocr-snip-v5.yml
fi
