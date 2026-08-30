# Social cards

`gap-card.html` renders the headline stat as a 1600x900 image for X.

It reads `data/tape.json`, so the numbers are whatever the last indexer run
measured. Re-render whenever you post; the pool moves.

## Render

Serve the repo root, then point headless Chrome at the card:

```bash
python -m http.server 3040

chrome --headless --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=2 --window-size=1600,900 \
  --default-background-color=ffffff --virtual-time-budget=8000 \
  --screenshot=squeeze-gap-card.png \
  "http://127.0.0.1:3040/assets/social/gap-card.html"
```

Output is 3200x1800 (2x), which X downsamples cleanly.

## ETH price

The card converts pool ETH to dollars. It defaults to 2450. Override it so
the dollar figures are honest at posting time:

```
gap-card.html?eth=2610
```

## What is measured and what is derived

Market cap, pool reserves and holder counts are read. The "selling that
moves it 10%" figure is a constant-product estimate from the pool's quote
reserve, which is exact for a full range position and the right order of
magnitude otherwise. The footer says so on the card itself.
