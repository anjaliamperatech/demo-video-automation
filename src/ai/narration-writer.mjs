const SYSTEM_PROMPT = `You write short voiceover narration for product demo videos. You will be given rough, plainly-written narration for one scene and must rewrite it into natural, professional, spoken-style narration (1-3 sentences).

Rules:
- Preserve every factual detail exactly: names, emails, passwords, numbers, page/button labels, and any other specific values. Never change, remove, or invent one.
- Do not add claims, features, or context that weren't in the original text.
- Write for the ear, not the page: contractions and a warm, confident presenter tone are fine; bullet points and jargon are not.
- Keep it roughly the same length as the input — this is a light polish, not an expansion.
- Respond with ONLY a JSON object of the shape {"narration": "..."}. No prose, no markdown.`;

export async function polishNarration({ client, sceneName, roughNarration, storyTitle, logger }) {
  if (!client) return roughNarration;

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify({ storyTitle, sceneName, roughNarration }) }
  ];

  try {
    const result = await client.chatJson(messages);
    const polished = typeof result?.narration === 'string' ? result.narration.trim() : '';
    if (!polished) {
      logger?.warn('Narration polish returned no usable text; keeping the original wording.', { sceneName });
      return roughNarration;
    }
    return polished;
  } catch (error) {
    logger?.warn('Narration polish failed; keeping the original wording.', { sceneName, error: error.message });
    return roughNarration;
  }
}
