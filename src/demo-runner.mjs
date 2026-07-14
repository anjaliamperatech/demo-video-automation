import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { attachNetworkLogger } from './media/network-logger.mjs';
import { writeJson, resolveFrom } from './lib/fs-utils.mjs';
import { writeSrt } from './media/subtitles.mjs';
import { composeFinalVideo, getAudioDurationMs, buildNarrationTrack } from './media/ffmpeg-compose.mjs';
import { createAzureOpenAIClient } from './ai/azure-openai-client.mjs';
import { snapshotInteractiveElements } from './ai/page-snapshot.mjs';
import { planSceneActions } from './ai/scene-planner.mjs';
import { slugify } from './lib/fs-utils.mjs';
import { estimateReadingMs } from './lib/time.mjs';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function resolveUrl(baseUrl, maybeRelativeUrl) {
  return new URL(maybeRelativeUrl, baseUrl).toString();
}

function nowMs(startEpochMs) {
  return Date.now() - startEpochMs;
}

async function ensureSceneBanner(page, scene, bannerDurationMs = 1200) {
  await page.evaluate(({ title, text }) => {
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
      <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.7;margin-bottom:6px;">Demo Scene</div>
      <div style="font-size:24px;font-weight:700;line-height:1.2;margin-bottom:8px;">${title}</div>
      <div style="font-size:14px;line-height:1.45;opacity:.92;">${text}</div>
    `;
    document.body.appendChild(root);
  }, {
    title: scene.name,
    text: scene.narration || ''
  });

  await sleep(bannerDurationMs);

  await page.evaluate(() => {
    const existing = document.getElementById('__demo_video_banner__');
    if (existing) existing.remove();
  });
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

async function executeAction(page, action, story, outputDir, logger, network) {
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
      await page.getByText(action.text, { exact: Boolean(action.exact) }).waitFor({ timeout, state: 'visible' });
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
      await page.getByText(action.text, { exact: Boolean(action.exact) }).click({ timeout });
      return;
    }
    case 'clickButton': {
      await page.getByRole('button', { name: action.text, exact: Boolean(action.exact) }).click({ timeout });
      return;
    }
    case 'fillLabel': {
      await page.getByLabel(action.label, { exact: Boolean(action.exact) }).fill(String(action.value ?? ''), { timeout });
      return;
    }
    case 'fillPlaceholder': {
      await page.getByPlaceholder(action.placeholder, { exact: Boolean(action.exact) }).fill(String(action.value ?? ''), { timeout });
      return;
    }
    case 'selectLabel': {
      await page.getByLabel(action.label, { exact: Boolean(action.exact) }).selectOption(action.value, { timeout });
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
    case 'log': {
      logger.info(action.message || 'Story log action');
      return;
    }
    default:
      throw new Error(`Unsupported action type: ${action.type}`);
  }
}

async function runSceneActions(page, scene, actions, story, outputDir, logger, network) {
  const [firstAction, ...remainingActions] = actions;

  if (firstAction?.type === 'goto') {
    await executeAction(page, firstAction, story, outputDir, logger, network);
    await ensureSceneBanner(page, scene, story.video?.bannerDurationMs ?? 1200);
    for (const action of remainingActions) {
      await executeAction(page, action, story, outputDir, logger, network);
    }
  } else {
    await ensureSceneBanner(page, scene, story.video?.bannerDurationMs ?? 1200);
    for (const action of actions) {
      await executeAction(page, action, story, outputDir, logger, network);
    }
  }
}

export async function runDemo({ story, storyPath, outputDir, headed = false, logger }) {
  const browser = await chromium.launch({ headless: !headed, slowMo: story.slowMoMs ?? 0 });
  const context = await browser.newContext({
    viewport: story.viewport || { width: 1440, height: 900 },
    recordVideo: {
      dir: outputDir,
      size: story.viewport || { width: 1440, height: 900 }
    }
  });

  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

  const page = await context.newPage();
  const pageVideo = page.video();
  const startedAt = Date.now();

  const files = {
    apiLogFile: path.join(outputDir, 'api-log.jsonl'),
    apiSummaryFile: path.join(outputDir, 'api-summary.json'),
    traceFile: path.join(outputDir, 'trace.zip'),
    subtitlesFile: path.join(outputDir, 'final-demo.srt'),
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
    await executeAction(page, action, story, outputDir, logger, network);
  }

  for (const [sceneIndex, scene] of story.scenes.entries()) {
    const sceneId = scene.id || slugify(scene.name || '') || `scene-${sceneIndex + 1}`;
    const sceneName = scene.name || `Scene ${sceneIndex + 1}`;
    logger.info('Starting scene.', { id: sceneId, name: sceneName });
    const sceneStartMs = nowMs(startedAt);

    const resolvedNarrationAudio = resolveFrom(storyPath, scene.narrationAudioFile);
    const narrationAudioFile = resolvedNarrationAudio && fs.existsSync(resolvedNarrationAudio) ? resolvedNarrationAudio : null;
    if (resolvedNarrationAudio && !narrationAudioFile) {
      logger.warn('Configured scene narration audio file was not found. Continuing without it.', { scene: sceneId, resolvedNarrationAudio });
    }
    // With no recorded audio, the caption's own reading time becomes the minimum dwell time,
    // so editing narration text (making it longer or shorter) reshapes the scene's timing too.
    const narrationDurationMs = narrationAudioFile
      ? await getAudioDurationMs(narrationAudioFile, logger)
      : estimateReadingMs(scene.narration);

    const hasManualActions = Array.isArray(scene.actions) && scene.actions.length > 0;

    if (hasManualActions) {
      await runSceneActions(page, scene, scene.actions, story, outputDir, logger, network);
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
        await runSceneActions(page, scene, plannedActions, story, outputDir, logger, network);
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
        await runSceneActions(page, scene, plannedActions, story, outputDir, logger, network);
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
      narration: scene.narration,
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

  const apiSummary = network.buildSummary();
  writeJson(files.apiSummaryFile, apiSummary);
  writeSrt(files.subtitlesFile, sceneTimeline);

  let audioFile = null;

  if (sceneAudioClips.length) {
    if (story.video?.audioFile) {
      logger.warn('Both per-scene narrationAudioFile clips and video.audioFile were provided. Using the per-scene clips and ignoring video.audioFile.');
    }
    const totalDurationMs = (sceneTimeline[sceneTimeline.length - 1]?.endMs ?? 0) + 500;
    audioFile = path.join(outputDir, 'narration-track.wav');
    await buildNarrationTrack({ clips: sceneAudioClips, totalDurationMs, outputFile: audioFile, logger });
  } else {
    const resolvedAudioFile = resolveFrom(storyPath, story.video?.audioFile);
    audioFile = resolvedAudioFile && fs.existsSync(resolvedAudioFile) ? resolvedAudioFile : null;

    if (resolvedAudioFile && !audioFile) {
      logger.warn('Configured audio file was not found. Continuing without audio.', { resolvedAudioFile });
    }
  }

  await composeFinalVideo({
    inputVideo: finalRawVideoPath,
    subtitlesFile: files.subtitlesFile,
    outputFile: files.finalVideoFile,
    audioFile,
    burnSubtitles: story.video?.burnSubtitles !== false,
    logger
  });

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
    scenes: sceneTimeline,
    apiSummary
  };

  writeJson(files.manifestFile, manifest);
  logger.info('Demo generation completed.', manifest.files);

  await browser.close();
  return manifest;
}
