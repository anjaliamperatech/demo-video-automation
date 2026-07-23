import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { attachNetworkLogger } from './media/network-logger.mjs';
import { writeJson, resolveFrom, ensureDir } from './lib/fs-utils.mjs';
import { writeSrt, writeAss } from './media/subtitles.mjs';
import { composeFinalVideo, getAudioDurationMs, buildNarrationTrack, cutVideoSegments, getVideoDimensions } from './media/ffmpeg-compose.mjs';
import { createAzureOpenAIClient } from './ai/azure-openai-client.mjs';
import { createAzureOpenAiTtsClient } from './ai/azure-openai-tts.mjs';
import { snapshotInteractiveElements } from './ai/page-snapshot.mjs';
import { planSceneActions } from './ai/scene-planner.mjs';
import { polishNarration } from './ai/narration-writer.mjs';
import { slugify } from './lib/fs-utils.mjs';
import { estimateReadingMs } from './lib/time.mjs';
import { waitForAnyCondition } from './lib/wait-until.mjs';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function resolveUrl(baseUrl, maybeRelativeUrl) {
  return new URL(maybeRelativeUrl, baseUrl).toString();
}

function nowMs(startEpochMs) {
  return Date.now() - startEpochMs;
}

// Maps a timestamp from the raw (uncut) recording to its position in the
// final video, after the recorder's long-wait cuts have been removed.
function buildTimeRemap(cuts) {
  const sortedCuts = [...cuts].sort((a, b) => a.atMs - b.atMs);
  return function remap(ms) {
    let removedMs = 0;
    for (const cut of sortedCuts) {
      if (ms <= cut.atMs) break;
      removedMs += Math.min(cut.removeMs, ms - cut.atMs);
    }
    return ms - removedMs;
  };
}

async function showBanner(page, { eyebrow, title, text }) {
  await page.evaluate(({ eyebrow, title, text }) => {
    const existing = document.getElementById('__demo_video_banner__');
    if (existing) existing.remove();

    const root = document.createElement('div');
    root.id = '__demo_video_banner__';
    root.style.position = 'fixed';
    root.style.top = '24px';
    root.style.left = '24px';
    root.style.zIndex = '2147483647';
    root.style.maxWidth = '40vw';
    root.style.background = 'rgba(15, 23, 42, 0.92)';
    root.style.color = '#fff';
    root.style.padding = '16px 20px';
    root.style.borderRadius = '14px';
    root.style.boxShadow = '0 12px 36px rgba(0,0,0,0.28)';
    root.style.fontFamily = 'Inter, ui-sans-serif, system-ui, sans-serif';
    root.innerHTML = `
      <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.7;margin-bottom:6px;">${eyebrow}</div>
      <div style="font-size:24px;font-weight:700;line-height:1.2;margin-bottom:8px;">${title}</div>
      <div style="font-size:14px;line-height:1.45;opacity:.92;">${text}</div>
    `;
    document.body.appendChild(root);
  }, { eyebrow, title, text });
}

async function hideBanner(page) {
  await page.evaluate(() => {
    const existing = document.getElementById('__demo_video_banner__');
    if (existing) existing.remove();
  });
}

async function ensureSceneBanner(page, scene, bannerDurationMs = 1200) {
  await showBanner(page, { eyebrow: 'Demo Scene', title: scene.name, text: scene.narration || '' });
  await sleep(bannerDurationMs);
  await hideBanner(page);
}

// Shows a small pill-shaped hint (styled like a labeled input field) pointing
// at a form element, e.g. "Enter your credentials" above the login fields.
async function showCallout(page, { text, rect }) {
  await page.evaluate(({ text, rect }) => {
    const existing = document.getElementById('__demo_video_callout__');
    if (existing) existing.remove();

    const root = document.createElement('div');
    root.id = '__demo_video_callout__';
    root.style.position = 'fixed';
    root.style.zIndex = '2147483647';
    root.style.background = '#fff';
    root.style.color = '#0f172a';
    root.style.padding = '10px 16px';
    root.style.borderRadius = '10px';
    root.style.boxShadow = '0 8px 24px rgba(0,0,0,0.22)';
    root.style.border = '1px solid rgba(15,23,42,0.12)';
    root.style.fontFamily = 'Inter, ui-sans-serif, system-ui, sans-serif';
    root.style.fontSize = '14px';
    root.style.fontWeight = '600';
    root.style.pointerEvents = 'none';

    if (rect) {
      root.style.top = `${Math.max(rect.top - 48, 8)}px`;
      root.style.left = `${rect.left}px`;
    } else {
      root.style.top = '24px';
      root.style.left = '24px';
    }
    root.textContent = text;
    document.body.appendChild(root);
  }, { text, rect });
}

async function hideCallout(page) {
  await page.evaluate(() => {
    const existing = document.getElementById('__demo_video_callout__');
    if (existing) existing.remove();
  });
}

// Recognizes "type your credentials here" fields across any story (email,
// username or password, targeted by selector, label, or placeholder) so the
// "Enter your credentials" hint shows up automatically for every login-like
// scene, not just ones a story author remembered to annotate by hand.
const CREDENTIAL_FIELD_PATTERN = /email|username|user name|password/i;

function isCredentialFillAction(action) {
  if (!['fill', 'fillLabel', 'fillPlaceholder'].includes(action.type)) return false;
  const descriptor = action.selector || action.label || action.placeholder || '';
  return CREDENTIAL_FIELD_PATTERN.test(descriptor);
}

function locatorForFillAction(page, action) {
  if (action.type === 'fill') return page.locator(action.selector);
  if (action.type === 'fillLabel') return page.getByLabel(action.label, { exact: Boolean(action.exact) });
  if (action.type === 'fillPlaceholder') return page.getByPlaceholder(action.placeholder, { exact: Boolean(action.exact) });
  return null;
}

async function maybeShowCredentialCallout(page, action) {
  if (!isCredentialFillAction(action)) return;
  let rect = null;
  try {
    const box = await locatorForFillAction(page, action)?.first().boundingBox({ timeout: 2000 });
    if (box) rect = { top: box.y, left: box.x };
  } catch {
    // Field not resolvable/visible yet — fall back to the default corner placement.
  }
  await showCallout(page, { text: 'Enter your credentials', rect });
  await sleep(900);
  await hideCallout(page);
}

// Native `scrollTo({ behavior: 'smooth' })` is a no-op in a lot of apps: the
// real scroll container often isn't document.body (it's some inner div with
// overflow:auto), and some browsers skip the animation entirely under
// reduced-motion settings. Find the element that actually has the most room
// to scroll and animate it by hand so the video always shows real motion.
async function scrollPageToBottom(page) {
  await page.evaluate(async () => {
    function findScrollable() {
      // Compare the document itself against a bounded set of likely inner
      // scroll containers (not every element — calling getComputedStyle on
      // every node in a content-heavy page forces a synchronous layout per
      // element and can visibly freeze the tab for seconds) and pick
      // whichever actually has the most room to scroll. A layout with a
      // scrollable page shell that only wiggles a little while the real
      // content lives in a nested overflow container would otherwise get
      // stuck on the shell and stop short of the real content.
      const doc = document.scrollingElement || document.documentElement;
      let best = doc;
      let bestRange = doc.scrollHeight - doc.clientHeight;

      const candidates = document.querySelectorAll(
        'main, [role="main"], [class*="overflow-y"], [class*="overflow-auto"], [style*="overflow"]'
      );
      candidates.forEach(el => {
        const range = el.scrollHeight - el.clientHeight;
        if (range > bestRange) {
          best = el;
          bestRange = range;
        }
      });
      return best;
    }

    const el = findScrollable();
    const start = el.scrollTop;
    const end = el.scrollHeight - el.clientHeight;
    if (end <= start) return;

    const duration = 900;
    const startTime = performance.now();
    await new Promise(resolve => {
      function step(now) {
        const progress = Math.min(1, (now - startTime) / duration);
        const eased = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;
        el.scrollTop = start + (end - start) * eased;
        if (progress < 1) requestAnimationFrame(step);
        else resolve();
      }
      requestAnimationFrame(step);
    });
  });
}

// Real backend work (content generation, a human doing something out-of-band,
// etc.) behind a wait can legitimately take minutes, but nobody wants to
// watch a loading spinner or an idle screen that long in the final video.
// Keep a short clip of the start and end of the wait and mark the boring
// middle for removal during video composition, so the on-screen time roughly
// matches the narration.
function recordLongWaitCut(recorder, waitStartMs, elapsedMs) {
  if (!recorder) return;
  const keepHeadMs = 4000;
  const keepTailMs = 3000;
  const minWorthCuttingMs = 20000;
  if (elapsedMs > minWorthCuttingMs + keepHeadMs + keepTailMs) {
    recorder.cuts.push({
      atMs: waitStartMs + keepHeadMs,
      removeMs: elapsedMs - keepHeadMs - keepTailMs
    });
  }
}

async function executeApiRequest(action, story, logger, network) {
  const url = resolveUrl(story.baseUrl, action.url);
  const method = action.method || 'GET';
  const headers = action.headers || {};
  const body = action.body ? JSON.stringify(action.body) : undefined;

  logger.info('Executing apiRequest action.', { method, url });

  const response = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...headers
    },
    body
  });

  const text = await response.text();
  network?.recordSyntheticExchange({
    method,
    url,
    requestBody: action.body ?? null,
    responseBody: text,
    status: response.status
  });

  logger.info('apiRequest completed.', {
    method,
    url,
    status: response.status,
    preview: text.slice(0, 200)
  });
}

async function executeAction(page, action, story, outputDir, logger, network, recorder, waitForTextMinMs = 0) {
  const timeout = action.timeoutMs ?? 15000;
  const selector = action.selector;

  switch (action.type) {
    case 'goto': {
      await page.goto(resolveUrl(story.baseUrl, action.url), { waitUntil: action.waitUntil ?? 'networkidle', timeout });
      return;
    }
    case 'click': {
      await page.locator(selector).click({ timeout });
      return;
    }
    case 'fill': {
      await maybeShowCredentialCallout(page, action);
      await page.locator(selector).fill(String(action.value ?? ''), { timeout });
      return;
    }
    case 'press': {
      await page.locator(selector).press(action.key, { timeout });
      return;
    }
    case 'wait': {
      await sleep(action.ms ?? 1000);
      return;
    }
    case 'waitForSelector': {
      await page.locator(selector).waitFor({ timeout, state: action.state ?? 'visible' });
      return;
    }
    case 'waitForText': {
      // Some scenes wait on something genuinely slow (a real multi-stage
      // content generation pipeline, etc.) where the generic 15s default
      // would time out while work is still legitimately in progress. Rather
      // than hardcoding a long floor for every story, a scene can opt in via
      // its own "waitForTextMinMs" — see runSceneActions, which threads that
      // value through as waitForTextMinMs. Stories that don't set it get the
      // same fast-fail behavior as every other action.
      const waitForTextTimeout = action.timeoutMs ?? Math.max(15000, waitForTextMinMs);
      const waitStartMs = recorder ? nowMs(recorder.startedAt) : null;
      await page.getByText(action.text, { exact: Boolean(action.exact) }).waitFor({ timeout: waitForTextTimeout, state: 'visible' });
      if (recorder) {
        recordLongWaitCut(recorder, waitStartMs, nowMs(recorder.startedAt) - waitStartMs);
      }
      return;
    }
    case 'waitForUser': {
      // A step that needs a human (or an external system) to do something
      // before the demo can continue. Rather than pausing the whole workflow
      // on a terminal prompt, show an on-page instruction and keep the
      // browser live: whichever of the given conditions happens first (a URL
      // change, an element/text appearing, a matching API response) resumes
      // the run automatically, without restarting anything before this step.
      const conditionTimeout = action.timeoutMs ?? 900000;
      const waitStartMs = recorder ? nowMs(recorder.startedAt) : null;
      await showBanner(page, {
        eyebrow: 'Waiting for you',
        title: action.instruction || 'Complete the required action to continue',
        text: 'This demo will automatically continue once that happens.'
      });
      try {
        await waitForAnyCondition(page, action.until, conditionTimeout);
      } finally {
        await hideBanner(page);
      }
      if (recorder) {
        recordLongWaitCut(recorder, waitStartMs, nowMs(recorder.startedAt) - waitStartMs);
      }
      return;
    }
    case 'select': {
      await page.locator(selector).selectOption(action.value, { timeout });
      return;
    }
    case 'check': {
      await page.locator(selector).check({ timeout });
      return;
    }
    case 'uncheck': {
      await page.locator(selector).uncheck({ timeout });
      return;
    }
    case 'hover': {
      await page.locator(selector).hover({ timeout });
      return;
    }
    case 'clickText': {
      // The same text often appears more than once (a nav item plus a page
      // breadcrumb/heading, etc.) — take the first match instead of letting
      // Playwright's strict mode throw and abort the whole run over it.
      await page.getByText(action.text, { exact: Boolean(action.exact) }).first().click({ timeout });
      return;
    }
    case 'clickButton': {
      await page.getByRole('button', { name: action.text, exact: Boolean(action.exact) }).first().click({ timeout });
      return;
    }
    case 'fillLabel': {
      await maybeShowCredentialCallout(page, action);
      await page.getByLabel(action.label, { exact: Boolean(action.exact) }).fill(String(action.value ?? ''), { timeout });
      return;
    }
    case 'fillPlaceholder': {
      await maybeShowCredentialCallout(page, action);
      await page.getByPlaceholder(action.placeholder, { exact: Boolean(action.exact) }).fill(String(action.value ?? ''), { timeout });
      return;
    }
    case 'selectLabel': {
      await page.getByLabel(action.label, { exact: Boolean(action.exact) }).selectOption(action.value, { timeout });
      return;
    }
    case 'checkLabel': {
      // Scoped to <label> elements only, since the same text (e.g. a keyword
      // name) can also appear elsewhere on the page (tables, summaries),
      // which would make a page-wide text match ambiguous.
      await page.locator('label').filter({ hasText: action.text }).first().click({ timeout });
      return;
    }
    case 'scrollToBottom': {
      await scrollPageToBottom(page);
      await sleep(action.ms ?? 400);
      return;
    }
    case 'downloadAndOpen': {
      // Clicks a download link/button, saves the file, then navigates the
      // page to it so the downloaded HTML becomes the final thing shown
      // (and captured) in the video. Some apps silently no-op this click
      // (e.g. a backend feature flag disabling it) without any visible
      // error, so this doesn't let a missing download crash the whole run
      // — it just logs a warning and leaves the current page on screen.
      try {
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout }),
          page.getByText(action.text, { exact: Boolean(action.exact) }).click({ timeout })
        ]);
        const savedPath = path.join(outputDir, action.saveAs || download.suggestedFilename() || 'download.html');
        await download.saveAs(savedPath);
        logger.info('Saved download and opening it as the final page.', { savedPath });
        await page.goto(`file:///${savedPath.replace(/\\/g, '/')}`, { waitUntil: 'networkidle', timeout });
        // This downloaded page is the actual final output of the demo, so
        // scroll through the whole thing instead of leaving the video
        // sitting on just the top of it.
        await sleep(500);
        await scrollPageToBottom(page);
        await sleep(600);
      } catch (error) {
        logger.warn('No download happened after clicking; the app may not have produced a file. Staying on the current page.', { text: action.text, error: error.message });
      }
      return;
    }
    case 'screenshot': {
      const name = action.name || `shot-${Date.now()}.png`;
      const screenshotPath = path.join(outputDir, name);
      await page.screenshot({ path: screenshotPath, fullPage: Boolean(action.fullPage) });
      logger.info('Saved screenshot.', { screenshotPath });
      return;
    }
    case 'setInputFiles': {
      await page.locator(selector).setInputFiles(action.files);
      return;
    }
    case 'apiRequest': {
      await executeApiRequest(action, story, logger, network);
      return;
    }
    case 'evaluate': {
      await page.evaluate(expression => {
        // Local-only convenience hook for custom one-off demo tweaks.
        // eslint-disable-next-line no-eval
        return eval(expression);
      }, action.expression);
      return;
    }
    case 'callout': {
      let rect = null;
      if (action.selector) {
        try {
          const box = await page.locator(action.selector).first().boundingBox({ timeout: 2000 });
          if (box) rect = { top: box.y, left: box.x };
        } catch {
          // Field not resolvable/visible yet — fall back to the default corner placement.
        }
      }
      await showCallout(page, { text: action.text, rect });
      await sleep(action.durationMs ?? 1500);
      await hideCallout(page);
      return;
    }
    case 'log': {
      logger.info(action.message || 'Story log action');
      return;
    }
    default:
      throw new Error(`Unsupported action type: ${action.type}`);
  }
}

async function runSceneActions(page, scene, actions, story, outputDir, logger, network, recorder) {
  const [firstAction, ...remainingActions] = actions;
  const waitForTextMinMs = scene.waitForTextMinMs ?? 0;

  if (firstAction?.type === 'goto') {
    await executeAction(page, firstAction, story, outputDir, logger, network, recorder, waitForTextMinMs);
    await ensureSceneBanner(page, scene, story.video?.bannerDurationMs ?? 1200);
    for (const action of remainingActions) {
      await executeAction(page, action, story, outputDir, logger, network, recorder, waitForTextMinMs);
    }
  } else {
    await ensureSceneBanner(page, scene, story.video?.bannerDurationMs ?? 1200);
    for (const action of actions) {
      await executeAction(page, action, story, outputDir, logger, network, recorder, waitForTextMinMs);
    }
  }
}

function containsWaitForUser(actions) {
  return Array.isArray(actions) && actions.some(action => action.type === 'waitForUser');
}

// A scene marked `optional: true` is a toggleable "feature" (surfaced as a
// checkbox in the Studio UI, or via the CLI's --scenes flag); everything
// else always runs. Selecting no optional scenes still runs the full core
// story, so an empty/omitted selectedSceneIds means "everything".
function selectScenes(scenes, selectedSceneIds) {
  if (!selectedSceneIds) return scenes;
  const selected = new Set(selectedSceneIds);
  return scenes.filter((scene, index) => {
    if (!scene.optional) return true;
    const id = scene.id || slugify(scene.name || '') || `scene-${index + 1}`;
    return selected.has(id);
  });
}

export async function runDemo({ story, storyPath, outputDir, headed = false, selectedSceneIds = null, logger }) {
  const scenes = selectScenes(story.scenes, selectedSceneIds);
  story = { ...story, scenes };

  const needsHumanInteraction = containsWaitForUser(story.setup) || story.scenes.some(scene => containsWaitForUser(scene.actions));
  if (needsHumanInteraction && !headed) {
    logger.info('This story has a waitForUser step, which needs a visible browser for a human to interact with. Forcing headed mode.');
    headed = true;
  }

  const browser = await chromium.launch({ headless: !headed, slowMo: story.slowMoMs ?? 0 });
  const context = await browser.newContext({
    viewport: story.viewport || { width: 1440, height: 900 },
    recordVideo: {
      dir: outputDir,
      size: story.viewport || { width: 1440, height: 900 }
    }
  });

  // `sources: true` embeds the full JS/CSS/source-maps of every page loaded
  // during the run into trace.zip — for a content-heavy SPA that's routinely
  // the single largest contributor to trace size (hundreds of MB), while
  // screenshots+snapshots already cover the vast majority of debugging needs
  // in the Playwright Trace Viewer.
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });

  const page = await context.newPage();
  const pageVideo = page.video();
  const startedAt = Date.now();
  // Tracks long real-time waits (e.g. content generation) so their boring
  // middle can be cut out of the final video during composition.
  const recorder = { startedAt, cuts: [] };

  const files = {
    apiLogFile: path.join(outputDir, 'api-log.jsonl'),
    apiSummaryFile: path.join(outputDir, 'api-summary.json'),
    traceFile: path.join(outputDir, 'trace.zip'),
    subtitlesFile: path.join(outputDir, 'final-demo.srt'),
    burnedSubtitlesFile: path.join(outputDir, 'final-demo.ass'),
    finalVideoFile: path.join(outputDir, 'final-demo.mp4'),
    manifestFile: path.join(outputDir, 'manifest.json')
  };

  const network = attachNetworkLogger(page, {
    includeHeaders: Boolean(story.capture?.includeHeaders),
    includeBodies: story.capture?.includeBodies !== false,
    maxBodyLength: story.capture?.maxBodyLength ?? 4000,
    urlIncludes: story.capture?.urlIncludes ?? [],
    redactKeys: story.capture?.redactKeys ?? []
  }, files, logger);

  const sceneTimeline = [];
  const sceneAudioClips = [];
  const aiClient = createAzureOpenAIClient();
  const ttsClient = createAzureOpenAiTtsClient();

  const scenesNeedingAi = story.scenes.filter(scene => !(Array.isArray(scene.actions) && scene.actions.length));
  if (scenesNeedingAi.length && !aiClient) {
    throw new Error(
      `${scenesNeedingAi.length} scene(s) have no "actions" list and rely on AI planning from narration, ` +
      'but no Azure OpenAI credentials were found. Set AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY and ' +
      'AZURE_OPENAI_DEPLOYMENT in your .env file, or add explicit "actions" to those scenes.'
    );
  }

  page.on('console', message => {
    logger.info('Browser console message.', { type: message.type(), text: message.text() });
  });

  logger.info('Running setup actions.', { count: story.setup?.length ?? 0 });
  for (const action of story.setup ?? []) {
    await executeAction(page, action, story, outputDir, logger, network, recorder);
  }

  for (const [sceneIndex, scene] of story.scenes.entries()) {
    const sceneId = scene.id || slugify(scene.name || '') || `scene-${sceneIndex + 1}`;
    const sceneName = scene.name || `Scene ${sceneIndex + 1}`;
    logger.info('Starting scene.', { id: sceneId, name: sceneName });
    const sceneStartMs = nowMs(startedAt);

    // A scene's audio file either comes from an explicit narrationAudioFile
    // path, or (if that's unset) defaults to stories/<story>/narration/<id>.mp3
    // — the same place a TTS-generated clip for that scene gets cached.
    const defaultNarrationAudioPath = path.join(path.dirname(storyPath), 'narration', `${sceneId}.mp3`);
    const resolvedNarrationAudio = resolveFrom(storyPath, scene.narrationAudioFile) || defaultNarrationAudioPath;
    let narrationAudioFile = fs.existsSync(resolvedNarrationAudio) ? resolvedNarrationAudio : null;

    // What actually gets spoken/captioned can differ from scene.narration:
    // scene.narration stays the raw instruction fed to the AI scene-planner
    // below (it needs the specific, literal wording), while spokenNarration is
    // an optionally AI-polished, more natural-sounding version used only for
    // the on-page banner, TTS audio, and subtitles. A narration-cache.txt file
    // next to the narration mp3 cache lets a human read/hand-edit the polished
    // wording and have it stick, the same way a dropped-in mp3 overrides TTS.
    const narrationCachePath = path.join(path.dirname(storyPath), 'narration', `${sceneId}.txt`);
    let spokenNarration = scene.narration;
    const wantsPolish = scene.narrationPolish !== false && Boolean(scene.narration) && Boolean(aiClient);

    if (wantsPolish && fs.existsSync(narrationCachePath)) {
      spokenNarration = fs.readFileSync(narrationCachePath, 'utf8').trim() || scene.narration;
    } else if (wantsPolish && !narrationAudioFile && ttsClient) {
      logger.info('Polishing narration wording before synthesizing audio.', { scene: sceneId });
      spokenNarration = await polishNarration({ client: aiClient, sceneName, roughNarration: scene.narration, storyTitle: story.title, logger });
      ensureDir(path.dirname(narrationCachePath));
      fs.writeFileSync(narrationCachePath, spokenNarration);
    }

    if (!narrationAudioFile && scene.narration && ttsClient) {
      logger.info('No recorded narration found for this scene; synthesizing it with TTS.', { scene: sceneId, destination: resolvedNarrationAudio });
      const audioBuffer = await ttsClient.synthesize(spokenNarration);
      ensureDir(path.dirname(resolvedNarrationAudio));
      fs.writeFileSync(resolvedNarrationAudio, audioBuffer);
      narrationAudioFile = resolvedNarrationAudio;
    } else if (!narrationAudioFile && scene.narrationAudioFile) {
      logger.warn('Configured scene narration audio file was not found, and no TTS credentials were set to generate it. Continuing without it.', { scene: sceneId, resolvedNarrationAudio });
    }

    // With no recorded/synthesized audio, the caption's own reading time becomes the
    // minimum dwell time, so editing narration text (making it longer or shorter)
    // reshapes the scene's timing too.
    const narrationDurationMs = narrationAudioFile
      ? await getAudioDurationMs(narrationAudioFile, logger)
      : estimateReadingMs(spokenNarration);

    const sceneForDisplay = spokenNarration === scene.narration ? scene : { ...scene, narration: spokenNarration };
    const hasManualActions = Array.isArray(scene.actions) && scene.actions.length > 0;

    if (hasManualActions) {
      await runSceneActions(page, sceneForDisplay, scene.actions, story, outputDir, logger, network, recorder);
    } else {
      if (page.url() === 'about:blank') {
        await page.goto(resolveUrl(story.baseUrl, story.startPath || '/'), { waitUntil: 'networkidle', timeout: 15000 });
      }

      const elements = await snapshotInteractiveElements(page);
      let plannedActions = await planSceneActions({
        client: aiClient,
        sceneName,
        narration: scene.narration,
        elements,
        currentUrl: page.url(),
        baseUrl: story.baseUrl,
        logger
      });

      try {
        await runSceneActions(page, sceneForDisplay, plannedActions, story, outputDir, logger, network, recorder);
      } catch (firstError) {
        logger.warn('AI-planned steps failed, asking the AI to retry once with the error.', { scene: sceneId, error: firstError.message });
        const retryElements = await snapshotInteractiveElements(page);
        plannedActions = await planSceneActions({
          client: aiClient,
          sceneName,
          narration: scene.narration,
          elements: retryElements,
          currentUrl: page.url(),
          baseUrl: story.baseUrl,
          priorError: firstError.message,
          logger
        });
        await runSceneActions(page, sceneForDisplay, plannedActions, story, outputDir, logger, network, recorder);
      }
    }

    if (scene.pauseAfterMs) {
      await sleep(scene.pauseAfterMs);
    }

    if (narrationDurationMs) {
      const elapsedMs = nowMs(startedAt) - sceneStartMs;
      const remainingMs = narrationDurationMs - elapsedMs;
      if (remainingMs > 0) {
        await sleep(remainingMs);
      }
    }

    const sceneEndMs = nowMs(startedAt);
    sceneTimeline.push({
      id: sceneId,
      name: sceneName,
      narration: spokenNarration,
      startMs: sceneStartMs,
      endMs: sceneEndMs
    });

    if (narrationAudioFile) {
      sceneAudioClips.push({ filePath: narrationAudioFile, startMs: sceneStartMs });
    }
  }

  await context.tracing.stop({ path: files.traceFile });
  await context.close();

  const rawVideoPath = await pageVideo.path();
  const finalRawVideoPath = path.join(outputDir, 'raw-video.webm');
  fs.copyFileSync(rawVideoPath, finalRawVideoPath);

  // Cut the boring middle out of any long real-time waits recorded during the
  // run, then remap every downstream timestamp (scene timeline, subtitles,
  // narration clip offsets) from raw-recording time to cut-video time so
  // captions and audio still land on the right moment.
  const remapMs = buildTimeRemap(recorder.cuts);
  const remappedSceneTimeline = sceneTimeline.map(scene => ({
    ...scene,
    startMs: remapMs(scene.startMs),
    endMs: remapMs(scene.endMs)
  }));
  const remappedAudioClips = sceneAudioClips.map(clip => ({
    ...clip,
    startMs: remapMs(clip.startMs)
  }));

  let composedInputVideo = finalRawVideoPath;
  if (recorder.cuts.length) {
    composedInputVideo = path.join(outputDir, 'cut-video.mp4');
    await cutVideoSegments({
      inputVideo: finalRawVideoPath,
      outputVideo: composedInputVideo,
      cuts: recorder.cuts,
      logger
    });
  }

  const apiSummary = network.buildSummary();
  writeJson(files.apiSummaryFile, apiSummary);
  writeSrt(files.subtitlesFile, remappedSceneTimeline);
  // Burn from a real .ass (not the .srt above) so captions are sized against
  // the actual video's own pixel dimensions instead of ffmpeg's internal
  // SRT->ASS guess — see media/subtitles.mjs buildAss for why.
  const videoDims = await getVideoDimensions(composedInputVideo, logger);
  writeAss(files.burnedSubtitlesFile, remappedSceneTimeline, videoDims);

  let audioFile = null;

  if (remappedAudioClips.length) {
    if (story.video?.audioFile) {
      logger.warn('Both per-scene narrationAudioFile clips and video.audioFile were provided. Using the per-scene clips and ignoring video.audioFile.');
    }
    const totalDurationMs = (remappedSceneTimeline[remappedSceneTimeline.length - 1]?.endMs ?? 0) + 500;
    audioFile = path.join(outputDir, 'narration-track.wav');
    await buildNarrationTrack({ clips: remappedAudioClips, totalDurationMs, outputFile: audioFile, logger });
  } else {
    const resolvedAudioFile = resolveFrom(storyPath, story.video?.audioFile);
    audioFile = resolvedAudioFile && fs.existsSync(resolvedAudioFile) ? resolvedAudioFile : null;

    if (resolvedAudioFile && !audioFile) {
      logger.warn('Configured audio file was not found. Continuing without audio.', { resolvedAudioFile });
    }
  }

  await composeFinalVideo({
    inputVideo: composedInputVideo,
    subtitlesFile: files.burnedSubtitlesFile,
    outputFile: files.finalVideoFile,
    audioFile,
    burnSubtitles: story.video?.burnSubtitles !== false,
    logger
  });

  // cut-video.mp4 (if created) was only ever a stepping stone to
  // final-demo.mp4 above — drop it so it doesn't sit around as dead weight.
  if (composedInputVideo !== finalRawVideoPath && fs.existsSync(composedInputVideo)) {
    fs.unlinkSync(composedInputVideo);
  }

  // raw-video.webm is the uncut, unedited screen capture — useful for
  // debugging but otherwise redundant with final-demo.mp4. story.video.
  // retainRawVideo defaults to true (keep it) so existing stories that don't
  // set it see no change in behavior.
  if (story.video?.retainRawVideo === false && fs.existsSync(finalRawVideoPath)) {
    fs.unlinkSync(finalRawVideoPath);
  }

  const manifest = {
    title: story.title,
    generatedAt: new Date().toISOString(),
    storyPath,
    outputDir,
    files: {
      rawVideo: finalRawVideoPath,
      trace: files.traceFile,
      subtitles: files.subtitlesFile,
      apiSummary: files.apiSummaryFile,
      apiLog: files.apiLogFile,
      finalVideo: files.finalVideoFile
    },
    scenes: remappedSceneTimeline,
    apiSummary
  };

  writeJson(files.manifestFile, manifest);
  logger.info('Demo generation completed.', manifest.files);

  await browser.close();
  return manifest;
}
