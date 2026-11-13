const api = 'https://api.anthropic.com/v1';
const model = 'claude-haiku-5-5';
const apiVersion = '2026-10-21';

const apiErrors = new Map([
  [401, 'Claude rejected the API key. Check it in Claude settings.'],
  [402, 'Claude reported a billing issue. Check billing in the Claude Console.'],
  [403, 'This API key cannot access Claude Haiku. Check its workspace permissions.'],
  [404, 'Claude Haiku is unavailable for this API key.'],
  [413, 'This conversation is too large. Start a new chat and try again.'],
  [429, 'Claude reached a rate or spend limit. Check limits in the Claude Console.'],
  [504, 'Claude took too long to respond. Try again.'],
]);

function requestFailure(signal, timeout, fallback) {
  if (signal?.aborted) return new DOMException('Claude request canceled.', 'AbortError');
  if (timeout.aborted) return new Error('Claude took too long to respond. Try again.');
  return new Error(fallback);
}

async function requestJson(endpoint, key, options, signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const headers = {
    authorization: `Bearer ${key}`,
    'anthropic-version': apiVersion,
    accept: 'application/json',
  };
  if (options.body) headers['content-type'] = 'application/json';

  let response;
  try {
    response = await fetch(`${api}${endpoint}`, {
      ...options,
      headers,
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch {
    throw requestFailure(signal, timeout, 'Could not connect to Claude. Check your connection.');
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    const message = apiErrors.get(response.status);
    if (message) throw new Error(message);
    if (response.status >= 500) throw new Error('Claude is temporarily unavailable. Try again.');
    if (response.status === 400 && options.method === 'GET') {
      throw new Error(
        'Claude could not verify this key. Use a key scoped to one Claude workspace.',
      );
    }
    throw new Error(`Claude rejected the request (HTTP ${response.status}).`);
  }

  try {
    return await response.json();
  } catch {
    throw requestFailure(signal, timeout, 'Claude returned an invalid response.');
  }
}

export async function verifyClaudeKey(key, signal) {
  const result = await requestJson(`/models/${model}`, key, { method: 'GET' }, signal, 15_000);
  if (result?.type !== 'model' || typeof result.id !== 'string') {
    throw new Error('Claude returned an invalid response while verifying the key.');
  }
}

export async function requestClaude(key, { system, messages, tools }, signal) {
  const result = await requestJson(
    '/messages',
    key,
    {
      method: 'POST',
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        thinking: { type: 'disabled' },
        system,
        messages,
        tools,
      }),
    },
    signal,
    45_000,
  );
  if (!Array.isArray(result?.content) || typeof result.stop_reason !== 'string') {
    throw new Error('Claude returned an invalid response.');
  }
  return result;
}
