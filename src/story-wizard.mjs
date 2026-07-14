#!/usr/bin/env node
import path from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';
import { ensureDir, slugify, writeJson } from './lib/fs-utils.mjs';

// A hand-rolled line reader is used instead of node:readline's question()
// helper, which can hang on a second prompt when stdin isn't a real TTY
// (observed on Windows). This reads stdin as a plain line queue instead.
function createLineReader(stream) {
  let buffer = '';
  const queue = [];
  let waiting = null; // { resolve, reject }
  let ended = false;

  function deliver(line) {
    if (waiting) {
      const { resolve } = waiting;
      waiting = null;
      resolve(line);
    } else {
      queue.push(line);
    }
  }

  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      deliver(line);
    }
  });
  stream.on('end', () => {
    ended = true;
    if (buffer) {
      deliver(buffer);
      buffer = '';
    }
    if (waiting) {
      const { reject } = waiting;
      waiting = null;
      reject(new Error('Input ended before the wizard finished. Run it in an interactive terminal and answer each prompt.'));
    }
  });

  return function nextLine() {
    if (queue.length) return Promise.resolve(queue.shift());
    if (ended) return Promise.reject(new Error('Input ended before the wizard finished. Run it in an interactive terminal and answer each prompt.'));
    return new Promise((resolve, reject) => { waiting = { resolve, reject }; });
  };
}

const nextLine = createLineReader(input);

async function ask(question, fallback = '') {
  const suffix = fallback ? ` (${fallback})` : '';
  output.write(`${question}${suffix}: `);
  const answer = (await nextLine()).trim();
  return answer || fallback;
}

async function askYesNo(question, defaultYes = true) {
  const suffix = defaultYes ? '(Y/n)' : '(y/N)';
  output.write(`${question} ${suffix}: `);
  const answer = (await nextLine()).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer.startsWith('y');
}

async function buildStep() {
  console.log(`
What should happen next?
  1) Click something (identify it by the text you see on it, e.g. a button or link)
  2) Type into a field (identify it by its label, e.g. "Email")
  3) Type into a field (identify it by its placeholder / greyed-out hint text)
  4) Go to a different page (by its path, e.g. /dashboard)
  5) Wait until some text appears on screen (useful after clicking submit)
  6) Pause for a moment
  7) Done with this scene`);

  const choice = await ask('Choose 1-7');

  switch (choice) {
    case '1': {
      const text = await ask('What text is on the thing to click?');
      return { type: 'clickText', text };
    }
    case '2': {
      const label = await ask("What is the field's label?");
      const value = await ask('What should be typed into it?');
      return { type: 'fillLabel', label, value };
    }
    case '3': {
      const placeholder = await ask("What is the field's placeholder text?");
      const value = await ask('What should be typed into it?');
      return { type: 'fillPlaceholder', placeholder, value };
    }
    case '4': {
      const url = await ask('What page path should we go to? (e.g. /dashboard)');
      return { type: 'goto', url };
    }
    case '5': {
      const text = await ask('What text should we wait for?');
      return { type: 'waitForText', text, timeoutMs: 15000 };
    }
    case '6': {
      const msRaw = await ask('Pause for how many milliseconds?', '1000');
      return { type: 'wait', ms: Number(msRaw) || 1000 };
    }
    default:
      return null;
  }
}

async function buildScene(index, leadingGotoUrl, useAi) {
  console.log(`\n--- Scene ${index + 1} ---`);
  const name = await ask('Short name for this scene', `Scene ${index + 1}`);
  const narration = await ask(
    useAi
      ? 'What should happen in this scene? Describe it in plain English (this also becomes the caption), e.g. "Log in with demo@example.com / hunter2"'
      : 'Narration text to caption this scene (what should the viewer be told?)'
  );
  const narrationAudioFile = await ask(
    'Path to a recorded narration audio file for this scene, if you have one (leave blank to just use captions)'
  );

  const scene = {
    id: slugify(name) || `scene-${index + 1}`,
    name,
    narration,
    pauseAfterMs: 1000
  };

  if (narrationAudioFile) scene.narrationAudioFile = narrationAudioFile;

  if (useAi) {
    // No "actions" list: the AI figures out the clicks/fills from narration at run time.
    return scene;
  }

  const actions = [];
  if (leadingGotoUrl) {
    actions.push({ type: 'goto', url: leadingGotoUrl });
    console.log(`(We'll start this scene by opening ${leadingGotoUrl})`);
  }

  while (true) {
    const step = await buildStep();
    if (!step) break;
    actions.push(step);
  }

  if (actions.length === 0) {
    console.log("A scene needs at least one step, let's add one.");
    const step = await buildStep();
    if (step) actions.push(step);
  }

  scene.actions = actions;
  return scene;
}

async function main() {
  console.log('Demo Video Config Wizard');
  console.log('=========================');
  console.log('Answer the questions below. You can edit the generated file afterwards too.\n');

  const title = await ask('What is this demo called?', 'My product demo');
  const baseUrl = await ask('What is the web address (URL) of the site to demo? (e.g. https://app.example.com)');
  const startPath = await ask('Which page should the video start on? (path after the domain, e.g. /login or /)', '/');

  console.log(`
How should each scene's steps be figured out?
  1) Let AI figure out the clicks/typing from your narration (recommended - needs an Azure OpenAI key in .env)
  2) I'll specify the exact clicks/fields myself, step by step`);
  const modeChoice = await ask('Choose 1 or 2', '1');
  const useAi = modeChoice !== '2';

  const scenes = [];
  let index = 0;
  let addMore = true;

  while (addMore) {
    const leadingGotoUrl = index === 0 ? startPath : null;
    scenes.push(await buildScene(index, leadingGotoUrl, useAi));
    index += 1;
    addMore = await askYesNo('\nAdd another scene?', true);
  }

  const story = {
    title,
    baseUrl,
    startPath,
    viewport: { width: 1440, height: 900 },
    video: {
      retainRawVideo: true,
      burnSubtitles: true,
      audioFile: null,
      bannerDurationMs: 1200
    },
    capture: {
      includeHeaders: false,
      includeBodies: true,
      maxBodyLength: 4000,
      urlIncludes: ['/api/'],
      redactKeys: ['password', 'token', 'authorization', 'cookie', 'set-cookie']
    },
    setup: [],
    scenes
  };

  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const storiesDir = ensureDir(path.join(projectRoot, 'stories'));
  const fileName = `${slugify(title) || 'my-demo'}.json`;
  const filePath = path.join(storiesDir, fileName);
  writeJson(filePath, story);

  console.log(`\nSaved your config to stories/${fileName}`);

  if (useAi) {
    console.log(
      '\nThis config relies on AI to figure out the clicks/typing, so make sure your .env file has ' +
      'AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY and AZURE_OPENAI_DEPLOYMENT filled in before running it.'
    );
  }

  console.log('\nNext, copy and paste these commands one at a time:\n');
  console.log(`  npm run demo:video -- --story ./stories/${fileName} --validate-only`);
  console.log(`  npm run demo:video -- --story ./stories/${fileName}\n`);

  process.exit(0);
}

main().catch(error => {
  console.error(`\nWizard failed: ${error.message}`);
  process.exitCode = 1;
});
