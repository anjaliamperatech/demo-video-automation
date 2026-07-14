export function validateStory(story) {
  const errors = [];

  if (!story || typeof story !== 'object') {
    errors.push('Story must be a JSON object.');
    return errors;
  }

  if (!story.title) errors.push('Story must include a title.');
  if (!story.baseUrl) errors.push('Story must include baseUrl.');
  if (!Array.isArray(story.scenes) || story.scenes.length === 0) {
    errors.push('Story must include at least one scene.');
  }

  for (const [sceneIndex, scene] of (story.scenes ?? []).entries()) {
    const label = scene.id ?? scene.name ?? sceneIndex + 1;
    const hasActions = Array.isArray(scene.actions) && scene.actions.length > 0;
    const hasNarration = typeof scene.narration === 'string' && scene.narration.trim().length > 0;

    if (!hasActions && !hasNarration) {
      errors.push(`Scene ${label} needs a "narration" line (so the AI can figure out the steps) or an explicit "actions" list.`);
    }
  }

  return errors;
}
