import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE_BIN = process.env.FFPROBE_PATH || 'ffprobe';

function quoteSubtitlePathForFilter(subtitlePath) {
  return subtitlePath
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

function runFfmpeg(args, logger) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';

    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      if (text.trim()) logger?.info('ffmpeg stdout', { text: text.trim() });
    });

    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      stderr += text;
    });

    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
    });
  });
}

export function getAudioDurationMs(filePath, logger) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath];
    const child = spawn(FFPROBE_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`ffprobe exited with code ${code}: ${stderr}`));
      const seconds = parseFloat(stdout.trim());
      if (Number.isNaN(seconds)) return reject(new Error(`Could not read audio duration for: ${filePath}`));
      resolve(Math.round(seconds * 1000));
    });

    logger?.info('Probing narration audio duration.', { filePath });
  });
}

/**
 * Removes a set of time ranges from a video (e.g. the boring middle of a
 * multi-minute real-world wait for content generation) by keeping only the
 * segments in between and concatenating them back together. `cuts` is a list
 * of { atMs, removeMs } ranges to drop, in the input video's own timeline.
 */
export async function cutVideoSegments({ inputVideo, outputVideo, cuts, logger }) {
  if (!cuts || !cuts.length) {
    fs.copyFileSync(inputVideo, outputVideo);
    return outputVideo;
  }

  const totalDurationMs = await getAudioDurationMs(inputVideo, logger);
  const sortedCuts = [...cuts].sort((a, b) => a.atMs - b.atMs);

  const filterParts = [];
  const segmentLabels = [];
  let cursorMs = 0;

  sortedCuts.forEach((cut, index) => {
    const segStartMs = cursorMs;
    const segEndMs = Math.min(cut.atMs, totalDurationMs);
    if (segEndMs > segStartMs) {
      const label = `v${index}`;
      filterParts.push(
        `[0:v]trim=start=${(segStartMs / 1000).toFixed(3)}:end=${(segEndMs / 1000).toFixed(3)},setpts=PTS-STARTPTS[${label}]`
      );
      segmentLabels.push(label);
    }
    cursorMs = cut.atMs + cut.removeMs;
  });

  if (cursorMs < totalDurationMs) {
    const label = `v${sortedCuts.length}`;
    filterParts.push(
      `[0:v]trim=start=${(cursorMs / 1000).toFixed(3)}:end=${(totalDurationMs / 1000).toFixed(3)},setpts=PTS-STARTPTS[${label}]`
    );
    segmentLabels.push(label);
  }

  filterParts.push(`${segmentLabels.map(label => `[${label}]`).join('')}concat=n=${segmentLabels.length}:v=1:a=0[outv]`);

  const args = [
    '-y', '-i', inputVideo,
    '-filter_complex', filterParts.join(';'),
    '-map', '[outv]',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    // This is an intermediate that composeFinalVideo re-encodes again right
    // after (to burn subtitles/mix audio) — keep it high quality (low crf)
    // so that second pass isn't compounding loss on top of loss.
    '-crf', '16',
    '-pix_fmt', 'yuv420p',
    outputVideo
  ];

  logger?.info('Cutting long real-time waits out of the raw video.', { cuts: sortedCuts, outputVideo });
  await runFfmpeg(args, logger);
  return outputVideo;
}

/**
 * Combines one narration clip per scene into a single track the length of the
 * whole video, each clip starting at that scene's timestamp. This lets a
 * narrator record short per-scene clips instead of one perfectly-timed take.
 */
export async function buildNarrationTrack({ clips, totalDurationMs, outputFile, logger }) {
  const totalSeconds = Math.max(1, totalDurationMs / 1000);
  const args = ['-y', '-f', 'lavfi', '-t', totalSeconds.toFixed(3), '-i', 'anullsrc=r=44100:cl=stereo'];

  for (const clip of clips) {
    args.push('-i', clip.filePath);
  }

  const filterParts = [];
  const mixLabels = ['0:a'];

  clips.forEach((clip, index) => {
    const inputIndex = index + 1;
    const label = `a${inputIndex}`;
    const delayMs = Math.max(0, Math.round(clip.startMs));
    filterParts.push(`[${inputIndex}:a]adelay=${delayMs}|${delayMs}[${label}]`);
    mixLabels.push(label);
  });

  const mixInputs = mixLabels.map(label => `[${label}]`).join('');
  filterParts.push(`${mixInputs}amix=inputs=${mixLabels.length}:duration=first:dropout_transition=0:normalize=0[aout]`);

  args.push('-filter_complex', filterParts.join(';'), '-map', '[aout]', '-c:a', 'pcm_s16le', outputFile);

  logger?.info('Building combined per-scene narration track.', { clips: clips.length, totalDurationMs, outputFile });
  await runFfmpeg(args, logger);
  return outputFile;
}

export function getVideoDimensions(filePath, logger) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=s=x:p=0',
      filePath
    ];
    const child = spawn(FFPROBE_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`ffprobe exited with code ${code}: ${stderr}`));
      const [width, height] = stdout.trim().split('x').map(Number);
      if (!width || !height) return reject(new Error(`Could not read video dimensions for: ${filePath}`));
      resolve({ width, height });
    });

    logger?.info('Probing video dimensions.', { filePath });
  });
}

export async function composeFinalVideo({
  inputVideo,
  subtitlesFile,
  outputFile,
  audioFile,
  burnSubtitles,
  logger
}) {
  if (!fs.existsSync(inputVideo)) {
    throw new Error(`Input video not found: ${inputVideo}`);
  }

  const args = ['-y', '-i', inputVideo];

  if (audioFile) {
    args.push('-i', audioFile);
  }

  if (burnSubtitles && subtitlesFile) {
    // The caller is expected to pass an .ass file with its own PlayResX/
    // PlayResY/Style already sized for the real video (see media/subtitles.mjs
    // buildAss) — a plain .srt here would get ffmpeg's internal SRT->ASS
    // conversion, which guesses its own (much smaller) script resolution and
    // renders captions far larger than intended on a real-size video.
    const subtitleFilter = `subtitles='${quoteSubtitlePathForFilter(path.resolve(subtitlesFile))}'`;
    args.push('-vf', subtitleFilter);
  }

  if (audioFile) {
    args.push('-map', '0:v:0', '-map', '1:a:0', '-shortest');
  }

  // This is the actual deliverable and only gets encoded once per run, so
  // it's worth spending more encode time for meaningfully better quality per
  // byte than the "veryfast" preset used for intermediates.
  args.push(
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', '20',
    '-pix_fmt', 'yuv420p'
  );

  if (audioFile) {
    args.push('-c:a', 'aac', '-b:a', '192k');
  }

  args.push(outputFile);

  logger?.info('Composing final video with ffmpeg.', {
    inputVideo,
    subtitlesFile,
    audioFile: audioFile ?? null,
    outputFile,
    burnSubtitles: Boolean(burnSubtitles)
  });

  await runFfmpeg(args, logger);
  return outputFile;
}
