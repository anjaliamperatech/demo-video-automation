/**
 * Estimates how long a viewer needs to read a caption, so a scene's on-screen
 * time tracks its narration length even when there's no narration audio file
 * to measure instead. Editing the narration text changes this automatically.
 */
export function estimateReadingMs(text, { wordsPerMinute = 170, minMs = 1200, maxMs = 8000 } = {}) {
  const wordCount = String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
  if (!wordCount) return minMs;
  const ms = Math.round((wordCount / wordsPerMinute) * 60000);
  return Math.min(maxMs, Math.max(minMs, ms));
}

export function toSrtTimestamp(milliseconds) {
  const totalMs = Math.max(0, Math.floor(milliseconds));
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const pad = (value, digits = 2) => String(value).padStart(digits, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(ms, 3)}`;
}
