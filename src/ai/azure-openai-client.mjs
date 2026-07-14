/**
 * Minimal fetch-based Azure OpenAI chat completions client. No SDK
 * dependency, matching the rest of this scaffold's zero-dependency approach.
 */
export function createAzureOpenAIClient(env = process.env) {
  const endpoint = env.AZURE_OPENAI_ENDPOINT;
  const apiKey = env.AZURE_OPENAI_API_KEY;
  const deployment = env.AZURE_OPENAI_DEPLOYMENT;
  const apiVersion = env.AZURE_OPENAI_API_VERSION || '2024-10-21';

  if (!endpoint || !apiKey || !deployment) return null;

  const url = `${endpoint.replace(/\/$/, '')}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;

  return {
    async chatJson(messages) {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'api-key': apiKey
        },
        body: JSON.stringify({
          messages,
          response_format: { type: 'json_object' }
        })
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Azure OpenAI request failed (${response.status}): ${text.slice(0, 500)}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('Azure OpenAI response did not include any message content.');
      }

      try {
        return JSON.parse(content);
      } catch {
        throw new Error(`Azure OpenAI response was not valid JSON: ${content.slice(0, 300)}`);
      }
    }
  };
}
