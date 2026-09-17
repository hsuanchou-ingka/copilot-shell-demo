# Screenshots

Every image in the README is captured from a harness rather than from a real account, so no
private session ever ends up in the repository. `demo.html` loads the real interface and hands
it a fabricated `window.copilot`, which means the screenshots stay honest about the layout while
the content is invented.

Each state lives in `src/demo.jsx` under `SCENES`. To recapture:

```sh
npm run dev -- --port 5199
```

Then, for each scene:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --hide-scrollbars \
  --default-background-color=00000000 --virtual-time-budget=8000 \
  --window-size=1460,960 --force-device-scale-factor=2 \
  --screenshot=docs/screenshots/overview.png \
  "http://localhost:5199/demo.html?scene=overview&shot=1"
```

Scenes: `overview`, `queue`, `resources`, `artifact`, `background`, `permission`.

`shot=1` keeps the fixed 1420x920 window the screenshots are captured from. Without it, the
page is the public web demo: the window scales to fit the browser and a guided tour starts.

The window chrome and rounded corners come from `demo.html`, not from the app, so the output
looks like a real window without needing screen recording permission.
