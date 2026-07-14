import fs from 'node:fs';
import { toSrtTimestamp } from '../lib/time.mjs';

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
