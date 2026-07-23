const WAIT_FOR_USER_CONDITION_KINDS = new Set(['url', 'text', 'selector', 'response']);

function validateWaitForUserActions(actions, label, errors) {
  for (const action of actions ?? []) {
    if (action?.type !== 'waitForUser') continue;
    if (!Array.isArray(action.until) || action.until.length === 0) {
      errors.push(`Scene ${label} has a "waitForUser" step with no "until" conditions to watch for.`);
      continue;
    }
    for (const condition of action.until) {
      if (!condition || !WAIT_FOR_USER_CONDITION_KINDS.has(condition.kind)) {
        errors.push(`Scene ${label} has a "waitForUser" condition with an unrecognized "kind" (expected one of: ${[...WAIT_FOR_USER_CONDITION_KINDS].join(', ')}).`);
      }
    }
  }
}

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

  validateWaitForUserActions(story.setup, 'setup', errors);

  for (const [sceneIndex, scene] of (story.scenes ?? []).entries()) {
    const label = scene.id ?? scene.name ?? sceneIndex + 1;
    const hasActions = Array.isArray(scene.actions) && scene.actions.length > 0;
    const hasNarration = typeof scene.narration === 'string' && scene.narration.trim().length > 0;

    if (!hasActions && !hasNarration) {
      errors.push(`Scene ${label} needs a "narration" line (so the AI can figure out the steps) or an explicit "actions" list.`);
    }

    validateWaitForUserActions(scene.actions, label, errors);
  }

  return errors;
}
