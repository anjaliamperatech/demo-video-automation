const ALLOWED_ACTION_TYPES = new Set([
  'goto',
  'clickText',
  'clickButton',
  'fillLabel',
  'fillPlaceholder',
  'selectLabel',
  'waitForText',
  'wait'
]);

const SYSTEM_PROMPT = `You control a web browser with Playwright to record a product demo video. You will be given a plain-English instruction describing what should happen next, and a list of the interactive elements currently visible on the page. Turn the instruction into a short list of actions.

Only use these action types, referencing elements by the visible text/label you were given (never CSS selectors, never invent text that isn't in the visible elements list):
- {"type":"goto","url":"/some/path"} - navigate to a path relative to the site's base URL
- {"type":"clickText","text":"..."} - click an element by its visible text
- {"type":"clickButton","text":"..."} - click a button by its visible label
- {"type":"fillLabel","label":"...","value":"..."} - type into a field identified by its label
- {"type":"fillPlaceholder","placeholder":"...","value":"..."} - type into a field identified by its placeholder text
- {"type":"selectLabel","label":"...","value":"..."} - choose an option in a dropdown identified by its label
- {"type":"waitForText","text":"..."} - wait for text to appear, e.g. right after a form submit
- {"type":"wait","ms":500} - pause briefly

Rules:
- Keep the plan minimal: only the steps needed to carry out the instruction.
- Only reference elements that were actually given to you in the visible elements list.
- If the instruction implies a clear success signal, end the plan with a waitForText action for it.
- If the instruction mentions a specific email, password, or other value to type, use it exactly.
- Respond with ONLY a JSON object of the shape {"actions": [...]}. No prose, no markdown.`;

function buildMessages({ sceneName, narration, elements, currentUrl, baseUrl, priorError }) {
  const userPayload = {
    sceneName,
    instruction: narration,
    baseUrl,
    currentUrl,
    visibleElements: elements
  };

  if (priorError) {
    userPayload.previousAttemptFailed = true;
    userPayload.previousAttemptError = priorError;
  }

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(userPayload) }
  ];
}

export async function planSceneActions({ client, sceneName, narration, elements, currentUrl, baseUrl, priorError, logger }) {
  if (!client) {
    throw new Error(
      'This scene has no "actions" list, so it needs AI planning, but no Azure OpenAI credentials were found. ' +
      'Set AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY and AZURE_OPENAI_DEPLOYMENT in your .env file, or add an explicit "actions" list to the scene.'
    );
  }

  const messages = buildMessages({ sceneName, narration, elements, currentUrl, baseUrl, priorError });
  logger?.info('Asking the AI to plan this scene.', { sceneName, elements: elements.length, retry: Boolean(priorError) });

  const result = await client.chatJson(messages);
  const rawActions = Array.isArray(result?.actions) ? result.actions : [];

  const actions = rawActions.filter(action => {
    const isValid = action && typeof action === 'object' && ALLOWED_ACTION_TYPES.has(action.type);
    if (!isValid) logger?.warn('Ignoring an AI-planned step with an unsupported type.', { action });
    return isValid;
  });

  if (!actions.length) {
    throw new Error(`The AI did not return any usable steps for scene "${sceneName}". Try making the narration more specific about what to click or type.`);
  }

  logger?.info('AI planned scene actions.', { sceneName, actions });
  return actions;
}
