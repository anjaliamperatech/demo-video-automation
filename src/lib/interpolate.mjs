function replaceTokens(text) {
  if (typeof text !== 'string') return text;

  return text.replace(/\$\{([^}]+)\}/g, (_match, token) => {
    const trimmed = token.trim();

    if (trimmed.startsWith('env.')) {
      const envKey = trimmed.slice(4);
      return process.env[envKey] ?? '';
    }

    return process.env[trimmed] ?? '';
  });
}

export function interpolateValue(value) {
  if (Array.isArray(value)) {
    return value.map(interpolateValue);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nestedValue]) => [key, interpolateValue(nestedValue)]));
  }

  return replaceTokens(value);
}
