#!/bin/bash
# 국내 유니버스(shared/radar-universe.json 350종목) + 코스피의 2년 일봉을 받아 둔다.
# 사용: bash scripts/research/fetch-kr-bars.sh <저장폴더>
#   → node scripts/research/volume-accumulation.mjs <저장폴더>
# 이미 받은 파일은 건너뛴다. Yahoo 무인증 API — 저장소 밖(스크래치) 폴더에 받을 것.
set -e
OUT="${1:?저장 폴더를 주세요}"
mkdir -p "$OUT"
node -e "const u=require('./shared/radar-universe.json'); console.log([...u.map(x=>x.symbol),'^KS11'].join('\n'))" \
  | xargs -P 8 -I{} sh -c 'f="'"$OUT"'/$(echo {} | tr "^" "_").json"; [ -s "$f" ] || curl -s -A "Mozilla/5.0" "https://query1.finance.yahoo.com/v8/finance/chart/{}?range=2y&interval=1d" -o "$f"'
ls "$OUT" | wc -l
