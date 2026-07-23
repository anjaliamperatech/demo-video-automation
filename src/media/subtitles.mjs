import fs from 'node:fs';
import { toSrtTimestamp, toAssTimestamp } from '../lib/time.mjs';

export function buildSrt(sceneTimeline) {
  return sceneTimeline
    .map((scene, index) => {
      const start = toSrtTimestamp(scene.startMs);
      const end = toSrtTimestamp(scene.endMs);
      const text = scene.narration?.trim() || scene.name;
      return `${index + 1}\n${start} --> ${end}\n${text}\n`;
    })
    .join('\n');
}

export function writeSrt(filePath, sceneTimeline) {
  const srt = buildSrt(sceneTimeline);
  fs.writeFileSync(filePath, srt);
  return filePath;
}

// ffmpeg's `subtitles` filter, when fed a plain .srt, converts it to ASS
// internally using its own guessed script resolution (not the real video
// size) and only lets `original_size`/`force_style` apply a *relative*
// correction on top of that guess — so on a real (non-toy) resolution video
// the captions still render far larger than the requested FontSize. Writing
// a real .ass file sidesteps the guessing entirely: PlayResX/PlayResY here
// are declared to be the actual video's pixel dimensions, so a Style
// FontSize is exactly that many pixels tall, no hidden rescale.
function escapeAssText(text) {
  return String(text ?? '')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r?\n/g, '\\N');
}

export function buildAss(sceneTimeline, { width, height, fontSize } = {}) {
  const resolvedFontSize = fontSize ?? Math.max(14, Math.round(height * 0.032));
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
ScaledBorderAndShadow: yes
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,${resolvedFontSize},&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,1.4,0,2,20,20,${Math.round(height * 0.035)},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  const events = sceneTimeline.map(scene => {
    const start = toAssTimestamp(scene.startMs);
    const end = toAssTimestamp(scene.endMs);
    const text = escapeAssText(scene.narration?.trim() || scene.name);
    return `Dialogue: 0,${start},${end},Default,,0,0,0,,${text}`;
  });

  return [header, ...events].join('\n') + '\n';
}

export function writeAss(filePath, sceneTimeline, dims) {
  const ass = buildAss(sceneTimeline, dims);
  fs.writeFileSync(filePath, ass);
  return filePath;
}
