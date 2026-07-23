#!/usr/bin/env node
// A tiny local dialog for the demo tool: builds/edits a story config through
// a browser form instead of the terminal wizard's sequential stdin prompts,
// and lets a non-technical user pick which optional scenes to include before
// running the CLI, watching live progress instead of a terminal.
import http from 'node:http';
import { spawn, exec } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson, ensureDir, slugify } from '../lib/fs-utils.mjs';
import { validateStory } from '../lib/validate.mjs';
import { loadDotEnv } from '../lib/env.mjs';

const studioDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(studioDir, '..', '..');
const storiesDir = path.join(projectRoot, 'stories');
const indexHtmlPath = path.join(studioDir, 'public', 'index.html');

loadDotEnv(projectRoot);

const PORT = Number(process.env.PORT || process.env.STUDIO_PORT) || 4278;
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');

// Tracks in-flight/finished `cli.mjs` subprocesses so their log output can be
// replayed to a browser tab that (re)connects, and streamed live via SSE.
const runs = new Map();

function listStories() {
  ensureDir(storiesDir);
  return fs.readdirSync(storiesDir)
    .filter(name => name.endsWith('.json'))
    .map(name => {
      const filePath = path.join(storiesDir, name);
      try {
        const story = readJson(filePath);
        return {
          file: name,
          title: story.title || name,
          baseUrl: story.baseUrl || '',
          scenes: (story.scenes || []).map((scene, index) => ({
            id: scene.id || slugify(scene.name || '') || `scene-${index + 1}`,
            name: scene.name || `Scene ${index + 1}`,
            optional: Boolean(scene.optional)
          }))
        };
      } catch (error) {
        return { file: name, title: name, error: `Could not read this story: ${error.message}`, scenes: [] };
      }
    });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 5_000_000) req.destroy(new Error('Request body too large.'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function startRun({ storyPath, selectedSceneIds, headed }) {
  const runId = randomUUID();
  const emitter = new EventEmitter();
  const run = { emitter, lines: [], done: false, success: null, finalVideo: null };
  runs.set(runId, run);

  const args = ['./src/cli.mjs', '--story', storyPath];
  if (headed) args.push('--headed');
  if (Array.isArray(selectedSceneIds) && selectedSceneIds.length) {
    args.push('--scenes', selectedSceneIds.join(','));
  }

  const child = spawn(process.execPath, args, { cwd: projectRoot });

  function pushLine(line) {
    run.lines.push(line);
    emitter.emit('line', line);
  }

  // Buffer partial chunks into whole lines rather than naively splitting each
  // `data` event on '\n' — a single log line can arrive across two chunks.
  let buffer = '';
  function handleChunk(chunk) {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line) pushLine(line);
    }
  }

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', handleChunk);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', handleChunk);

  child.on('close', code => {
    if (buffer) pushLine(buffer);
    run.done = true;
    run.success = code === 0;
    const finalVideoLine = run.lines.find(line => line.includes('Final video:'));
    run.finalVideo = finalVideoLine ? finalVideoLine.split('Final video:')[1]?.trim() : null;
    emitter.emit('done', { success: run.success, finalVideo: run.finalVideo });
  });

  return runId;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(indexHtmlPath, 'utf8'));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/stories') {
      sendJson(res, 200, { stories: listStories() });
      return;
    }

    const storyFileMatch = url.pathname.match(/^\/api\/stories\/([^/]+)$/);
    if (req.method === 'GET' && storyFileMatch) {
      const fileName = path.basename(decodeURIComponent(storyFileMatch[1]));
      const filePath = path.join(storiesDir, fileName);
      if (!fs.existsSync(filePath)) {
        sendJson(res, 404, { ok: false, error: 'Story file not found.' });
        return;
      }
      sendJson(res, 200, { ok: true, file: fileName, story: readJson(filePath) });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/stories') {
      const payload = JSON.parse(await readBody(req));
      const { fileName: requestedFileName, ...story } = payload;
      const errors = validateStory(story);
      if (errors.length) {
        sendJson(res, 400, { ok: false, errors });
        return;
      }
      ensureDir(storiesDir);
      const fileName = requestedFileName ? path.basename(requestedFileName) : `${slugify(story.title) || 'my-demo'}.json`;
      writeJson(path.join(storiesDir, fileName), story);
      sendJson(res, 200, { ok: true, file: fileName });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/run') {
      const body = JSON.parse(await readBody(req));
      if (!body.storyPath) {
        sendJson(res, 400, { ok: false, error: 'storyPath is required.' });
        return;
      }
      const storyPath = path.join(storiesDir, path.basename(body.storyPath));
      if (!fs.existsSync(storyPath)) {
        sendJson(res, 404, { ok: false, error: 'Story file not found.' });
        return;
      }
      const runId = startRun({ storyPath, selectedSceneIds: body.selectedSceneIds, headed: Boolean(body.headed) });
      sendJson(res, 200, { ok: true, runId });
      return;
    }

    const eventsMatch = url.pathname.match(/^\/api\/run\/([^/]+)\/events$/);
    if (req.method === 'GET' && eventsMatch) {
      const run = runs.get(eventsMatch[1]);
      if (!run) {
        sendJson(res, 404, { ok: false, error: 'Unknown run.' });
        return;
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });

      for (const line of run.lines) {
        res.write(`event: line\ndata: ${JSON.stringify(line)}\n\n`);
      }
      if (run.done) {
        res.write(`event: done\ndata: ${JSON.stringify({ success: run.success, finalVideo: run.finalVideo })}\n\n`);
        res.end();
        return;
      }

      const onLine = line => res.write(`event: line\ndata: ${JSON.stringify(line)}\n\n`);
      const onDone = payload => {
        res.write(`event: done\ndata: ${JSON.stringify(payload)}\n\n`);
        res.end();
      };
      run.emitter.on('line', onLine);
      run.emitter.on('done', onDone);
      req.on('close', () => {
        run.emitter.off('line', onLine);
        run.emitter.off('done', onDone);
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message });
  }
});

function openBrowser(url) {
  const platform = process.platform;
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start ""' : 'xdg-open';
  exec(`${command} ${url}`, () => {
    // Non-fatal if this fails (e.g. a headless/SSH environment) — the
    // server keeps running and the URL below can be opened manually.
  });
}

server.listen(PORT, HOST, () => {
  const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
  console.log(`\nDemo Studio running at ${url}\n`);
  if (HOST === '127.0.0.1') {
    console.log('Opening it in your browser...\n');
    openBrowser(url);
  }
});
