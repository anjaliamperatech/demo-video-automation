# Demo Video Generator

Turns a small config file into a narrated product demo video: it drives your web app in a real browser, captures the API calls happening behind the scenes, and renders a captioned MP4.

You only need two things to generate a video: **the web address of the site** and **a line of narration for each step**. An AI fills in the actual clicks and typing for you. (You can also write exact steps by hand if you want full control — see [Advanced: manual steps](#advanced-manual-steps).)

---

## If someone sent you this as a zip file

Follow this section top to bottom in a terminal. Every grey box is something you copy and paste.

### 1. Install the one-time requirements

You need **Node.js** and **ffmpeg** installed on your computer. If you're not sure whether you have them, open PowerShell and run:

```powershell
node --version
ffmpeg -version
```

If either command says it isn't recognized, install the missing one:

**Windows (PowerShell):**

```powershell
winget install OpenJS.NodeJS.LTS
winget install Gyan.FFmpeg
```

**Mac:**

```bash
brew install node ffmpeg
```

After installing, **close and reopen your terminal** so it picks up the new programs, then re-run the two version checks above to confirm they work.

### 2. Unzip and install the project

Unzip the file you were sent, then open a terminal **inside that unzipped folder** and run:

```powershell
npm run setup
```

This installs the project's dependencies and downloads the Chromium browser it drives (a few hundred MB, one-time).

### 3. Add your API key

Copy the example settings file:

```powershell
copy .env.example .env
```

Open `.env` in Notepad (or any text editor) and fill in the `AZURE_OPENAI_...` values. Ask whoever manages your Azure OpenAI resource for:

- `AZURE_OPENAI_ENDPOINT` — looks like `https://your-resource-name.openai.azure.com`
- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_DEPLOYMENT` — the deployment name they set up (e.g. `gpt-4o` or `gpt-5-nano`)

You only need this if you want the AI to figure out the clicks/typing for you (the default, recommended path). If you plan to write every step by hand instead, you can skip this.

### 4. Build your config by answering questions

```powershell
npm run story:new
```

This asks you a few questions in plain English:

- What's the demo called?
- What's the web address of the site?
- What page should the video start on?
- For each scene: a short name, and **narration describing what should happen** — e.g. *"Log in with demo@example.com and password hunter2, then wait for the dashboard to appear."*

That's it. No code, no CSS selectors. It saves a config file into the `stories/` folder and prints the exact commands to run next.

### 5. Generate the video

```powershell
npm run demo:video -- --story ./stories/your-demo-name.json
```

Watch the browser window (or run headless, see below) as it performs the steps and narrates each scene. When it finishes, it prints the location of the final video.

### 6. Find your video

Look in the `output/` folder for a new subfolder named after your demo and the date/time. Inside is `final-demo.mp4` — that's your video, with burned-in captions from your narration.

---

## Providing narration

You have three options, and you can mix them scene by scene:

1. **Just type it (default).** Whatever narration text you give a scene is burned into the video as captions. No audio.
2. **Record narration per scene.** Record a short MP3/WAV for each scene (even on your phone) and give its file path when the wizard asks, or add `"narrationAudioFile": "./narration/scene1.mp3"` to a scene by hand. The tool automatically times each clip to when its scene starts, stitches them into one track, and mutes nothing else — you don't have to get the timing perfect yourself. Captions still show alongside the audio.
3. **One full voiceover file.** If you'd rather record one continuous voiceover for the whole video, set `"video": { "audioFile": "./narration/full-voiceover.mp3" }` in the story file. (If any scene has its own `narrationAudioFile`, that takes priority over this.)

You can open the generated config file at any point and edit the narration text directly. If a scene has no recorded audio, its on-screen time automatically stretches or shrinks to give viewers enough time to read the caption (about 170 words/minute) — you don't need to hand-tune pauses when you reword something. If a scene does have `narrationAudioFile`, the recording's actual length is used instead.

---

## How the AI figures out the steps

When a scene has narration but no explicit `actions`, the tool:

1. Looks at what's currently visible on the page (buttons, links, form fields and their labels).
2. Sends that list plus your narration sentence to your Azure OpenAI deployment.
3. Gets back a short list of steps (click this, type that, wait for this text) and runs them.
4. If a step fails, it shows the AI what went wrong and lets it try once more before giving up.

Because it only sees what's actually on the page, it works on essentially **any** website without you touching HTML, CSS selectors, or `data-testid` attributes. It only performs safe actions (clicking, typing, waiting, navigating) — it cannot run arbitrary code or call unrelated APIs.

Tips for narration that gets good results:
- Be specific about values: *"Create a customer named Acme Demo Pvt Ltd with email buyer@acme-demo.test"* works better than *"add a customer."*
- One scene = one goal. If a step opens a modal or a new page, that's a good place to start a new scene.
- Mention what confirms success (*"...then wait for 'Customer created' to appear"*) — this gives the AI a natural place to end the scene.

---

## Packaging this up to send to someone else

From a machine that already has the project set up, zip up the source only (not `node_modules`, `output`, or your `.env` — the recipient installs/configures those themselves):

**Windows (PowerShell):**

```powershell
Compress-Archive -Path .\src, .\stories, .\package.json, .\package-lock.json, .\README.md, .\.env.example, .\.gitignore -DestinationPath demo-video-generator.zip -Force
```

**Mac/Linux:**

```bash
zip -r demo-video-generator.zip src stories package.json package-lock.json README.md .env.example .gitignore
```

Send the resulting `demo-video-generator.zip`. Whoever receives it should follow the "If someone sent you this as a zip file" section above.

---

## What this generates

For each run, a folder like this is created under `output/`:

```text
output/customer-onboarding-20260714-153000/
  api-log.jsonl        # every captured API request/response, one per line
  api-summary.json     # per-endpoint counts and last status
  final-demo.mp4        # the finished, captioned video
  final-demo.srt        # the caption file, same content, standard subtitle format
  manifest.json         # a summary of the whole run (files, scene timings, API summary)
  narration-track.wav   # only present if you used per-scene narration audio
  raw-video.webm        # the unedited browser recording
  run.log                # a log of everything the tool did
  trace.zip              # a Playwright trace — open with `npx playwright show-trace trace.zip` to debug a scene visually
```

---

## Advanced: manual steps

If you want exact control instead of AI-driven scenes (or don't have an Azure OpenAI key), give a scene an explicit `actions` list and it's used as-is — no AI call happens for that scene. The `story:new` wizard offers this as an alternate mode ("I'll specify the exact clicks/fields myself").

```json
{
  "title": "Customer onboarding demo",
  "baseUrl": "${env.BASE_URL}",
  "video": {
    "retainRawVideo": true,
    "burnSubtitles": true,
    "audioFile": null
  },
  "capture": {
    "includeHeaders": false,
    "includeBodies": true,
    "maxBodyLength": 4000,
    "urlIncludes": ["/api/"],
    "redactKeys": ["password", "token", "authorization", "cookie"]
  },
  "scenes": [
    {
      "id": "login",
      "name": "Login",
      "narration": "First, we log in as a demo account.",
      "pauseAfterMs": 800,
      "actions": [
        { "type": "goto", "url": "/login" },
        { "type": "fillLabel", "label": "Email", "value": "${env.DEMO_EMAIL}" },
        { "type": "fillLabel", "label": "Password", "value": "${env.DEMO_PASSWORD}" },
        { "type": "clickButton", "text": "Sign in" },
        { "type": "waitForText", "text": "Dashboard" }
      ]
    }
  ]
}
```

`${env.SOME_VAR}` anywhere in the story pulls from your `.env` file — handy for keeping credentials out of the config file itself.

### Supported actions

Friendly (identify things the way a person would describe them):

- `clickText` — click something by its visible text
- `clickButton` — click a button by its visible label
- `fillLabel` — type into a field identified by its label
- `fillPlaceholder` — type into a field identified by its placeholder text
- `selectLabel` — choose a dropdown option, field identified by its label
- `waitForText` — wait for text to appear on screen
- `goto` — navigate to a path relative to `baseUrl`
- `wait` — pause for a fixed number of milliseconds

CSS-selector based (for precise/advanced control):

- `click`, `fill`, `press`, `waitForSelector`, `select`, `check`, `uncheck`, `hover`, `setInputFiles`

Other:

- `apiRequest` — call an API directly, useful for seeding state before the UI flow begins
- `screenshot` — save a PNG at that point in the run
- `evaluate` — run arbitrary JavaScript in the page (only use this with story files you trust; it isn't available to AI-planned steps)
- `log` — write a note into `run.log`

### CLI flags

```powershell
npm run demo:video -- --story ./stories/customer-onboarding.json
npm run demo:video -- --story ./stories/customer-onboarding.json --headed
npm run demo:video -- --story ./stories/customer-onboarding.json --output ./output
npm run demo:video -- --story ./stories/customer-onboarding.json --validate-only
```

- `--headed` shows the browser window while it runs (useful when building/debugging a new demo)
- `--validate-only` checks the story file's structure without launching a browser

---

## Requirements (for reference)

- Node.js 20+
- `ffmpeg` (and `ffprobe`, which ships alongside it) on your PATH
- An Azure OpenAI resource with a `gpt-4o` or `gpt-5-nano` deployment, if you're using AI-planned scenes
