import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
    const child = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
    const subtitleFilter = `subtitles='${quoteSubtitlePathForFilter(path.resolve(subtitlesFile))}'`;
    args.push('-vf', subtitleFilter);
  }

  if (audioFile) {
    args.push('-map', '0:v:0', '-map', '1:a:0', '-shortest');
  }

  args.push(
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
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
