/**
 * Minimal fetch-based Azure OpenAI text-to-speech client, mirroring
 * azure-openai-client.mjs. Lets narration be auto-generated from scene
 * text instead of requiring a human recording.
 */
export function createAzureOpenAiTtsClient(env = process.env) {
  // TTS often lives on its own Azure resource (separate endpoint/key from the
  // main chat deployment), so its env vars are checked first with a fallback
  // to the shared AZURE_OPENAI_* ones for setups that reuse one resource.
  const endpoint = env.TTS_AZURE_OPENAI_ENDPOINT || env.AZURE_OPENAI_ENDPOINT;
  const apiKey = env.TTS_AZURE_OPENAI_API_KEY || env.AZURE_OPENAI_API_KEY;
  const deployment = env.TTS_AZURE_OPENAI_DEPLOYMENT || env.AZURE_OPENAI_TTS_DEPLOYMENT;
  const apiVersion = env.TTS_AZURE_OPENAI_API_VERSION || env.AZURE_OPENAI_API_VERSION || '2024-10-21';
  // "nova" reads as clear, warm and energetic — a better fit for product demo
  // narration than the flatter, more neutral default "alloy".
  const voice = env.TTS_AZURE_OPENAI_VOICE || env.AZURE_OPENAI_TTS_VOICE || 'nova';
  // gpt-4o-mini-tts (unlike older tts-1 models) is steerable: it accepts a
  // free-text delivery instruction alongside the voice preset. Defaulting
  // this to a demo-voiceover style gets a meaningfully more "presenter-like"
  // read than the voice preset alone.
  const instructions = env.TTS_AZURE_OPENAI_INSTRUCTIONS ||
    'Speak as a confident, upbeat product demo narrator: warm, clear, and enthusiastic, ' +
    'with natural pacing and light emphasis on key product capabilities. Not rushed, not flat.';

  if (!endpoint || !apiKey || !deployment) return null;

  const url = `${endpoint.replace(/\/$/, '')}/openai/deployments/${encodeURIComponent(deployment)}/audio/speech?api-version=${encodeURIComponent(apiVersion)}`;

  return {
    async synthesize(text) {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'api-key': apiKey
        },
        body: JSON.stringify({
          model: deployment,
          input: text,
          voice,
          instructions,
          response_format: 'mp3'
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Azure OpenAI TTS request failed (${response.status}): ${errorText.slice(0, 500)}`);
      }

      return Buffer.from(await response.arrayBuffer());
    }
  };
}
