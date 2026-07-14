import fs from 'node:fs';
import { writeJsonLine } from '../lib/fs-utils.mjs';

function safeJsonParse(value) {
  if (!value) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function redact(value, redactKeys = []) {
  if (!value || redactKeys.length === 0) return value;

  const redactSet = new Set(redactKeys.map(key => key.toLowerCase()));

  if (Array.isArray(value)) {
    return value.map(item => redact(item, redactKeys));
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => {
        if (redactSet.has(String(key).toLowerCase())) {
          return [key, '[REDACTED]'];
        }
        return [key, redact(nestedValue, redactKeys)];
      })
    );
  }

  return value;
}

function cropBody(value, maxBodyLength) {
  if (typeof value !== 'string') return value;
  if (value.length <= maxBodyLength) return value;
  return `${value.slice(0, maxBodyLength)}… [truncated ${value.length - maxBodyLength} chars]`;
}

function shouldCapture(url, includePatterns = []) {
  if (!includePatterns.length) return true;
  return includePatterns.some(pattern => url.includes(pattern));
}

export function attachNetworkLogger(page, config, files, logger) {
  const stream = fs.createWriteStream(files.apiLogFile, { flags: 'a' });
  const events = [];

  page.on('request', request => {
    if (!shouldCapture(request.url(), config.urlIncludes)) return;

    const headers = config.includeHeaders ? redact(request.headers(), config.redactKeys) : undefined;
    const rawBody = request.postData();
    const parsedBody = safeJsonParse(rawBody);
    const body = config.includeBodies ? redact(parsedBody, config.redactKeys) : undefined;

    const requestRecord = {
      type: 'request',
      ts: new Date().toISOString(),
      method: request.method(),
      url: request.url(),
      headers,
      body: cropBody(typeof body === 'string' ? body : JSON.stringify(body), config.maxBodyLength)
    };

    pushEvent(requestRecord);
  });

  page.on('response', async response => {
    if (!shouldCapture(response.url(), config.urlIncludes)) return;

    let bodyText = null;
    if (config.includeBodies) {
      try {
        bodyText = await response.text();
      } catch (error) {
        bodyText = `[unavailable: ${error.message}]`;
      }
    }

    const parsed = safeJsonParse(bodyText);
    const redactedBody = config.includeBodies ? redact(parsed, config.redactKeys) : undefined;

    const responseRecord = {
      type: 'response',
      ts: new Date().toISOString(),
      url: response.url(),
      status: response.status(),
      ok: response.ok(),
      body: cropBody(typeof redactedBody === 'string' ? redactedBody : JSON.stringify(redactedBody), config.maxBodyLength)
    };

    pushEvent(responseRecord);
  });

  function pushEvent(event) {
    events.push(event);
    writeJsonLine(stream, event);
  }

  return {
    recordSyntheticExchange({ method, url, requestBody, responseBody, status = 200 }) {
      const requestEvent = {
        type: 'request',
        ts: new Date().toISOString(),
        method,
        url,
        headers: undefined,
        body: cropBody(typeof requestBody === 'string' ? requestBody : JSON.stringify(redact(requestBody, config.redactKeys)), config.maxBodyLength)
      };

      const responseEvent = {
        type: 'response',
        ts: new Date().toISOString(),
        url,
        status,
        ok: status >= 200 && status < 400,
        body: cropBody(typeof responseBody === 'string' ? responseBody : JSON.stringify(redact(responseBody, config.redactKeys)), config.maxBodyLength)
      };

      pushEvent(requestEvent);
      pushEvent(responseEvent);
    },
    buildSummary() {
      const byEndpoint = {};
      for (const event of events) {
        const key = event.url;
        byEndpoint[key] ??= {
          url: key,
          requests: 0,
          responses: 0,
          lastStatus: null
        };

        if (event.type === 'request') {
          byEndpoint[key].requests += 1;
        } else {
          byEndpoint[key].responses += 1;
          byEndpoint[key].lastStatus = event.status;
        }
      }

      const summary = {
        capturedEvents: events.length,
        endpoints: Object.values(byEndpoint)
      };

      logger?.info('Built API summary.', { capturedEvents: summary.capturedEvents, endpoints: summary.endpoints.length });
      stream.end();
      return summary;
    }
  };
}
