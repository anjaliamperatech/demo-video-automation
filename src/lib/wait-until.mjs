/**
 * Races several independent "did the human/system finish this?" conditions
 * against each other so a step can say "continue as soon as ANY of these
 * happen" (a URL change, an element/text appearing, an API call landing)
 * instead of hardcoding a single signal. Only rejects once every condition
 * has timed out.
 */
function buildConditionPromise(page, condition, timeoutMs) {
  switch (condition.kind) {
    case 'url':
      return page.waitForURL(condition.pattern, { timeout: timeoutMs });
    case 'text':
      return page.getByText(condition.text, { exact: Boolean(condition.exact) }).first().waitFor({ timeout: timeoutMs, state: 'visible' });
    case 'selector':
      return page.locator(condition.selector).waitFor({ timeout: timeoutMs, state: condition.state ?? 'visible' });
    case 'response':
      return page.waitForResponse(response => {
        if (condition.urlIncludes && !response.url().includes(condition.urlIncludes)) return false;
        if (condition.status && response.status() !== condition.status) return false;
        return true;
      }, { timeout: timeoutMs });
    default:
      throw new Error(`Unsupported waitForUser condition kind: ${condition.kind}`);
  }
}

export async function waitForAnyCondition(page, conditions, timeoutMs) {
  if (!Array.isArray(conditions) || conditions.length === 0) {
    throw new Error('waitForUser needs at least one condition in "until".');
  }

  try {
    return await Promise.any(conditions.map(condition => buildConditionPromise(page, condition, timeoutMs)));
  } catch (error) {
    const reasons = (error.errors ?? [error]).map(inner => inner.message).join('; ');
    throw new Error(`Timed out waiting for any of the expected conditions: ${reasons}`);
  }
}
