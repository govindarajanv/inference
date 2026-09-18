import fs from 'node:fs';
import path from 'node:path';

/**
 * Checks whether a model is considered a free model on Kilo Gateway.
 * Free models typically have ':free' in their id or are 'kilo-auto/free'.
 *
 * @param {string} model
 * @param {string} gatewayUrl
 * @param {string} [apiKey]
 * @returns {Promise<boolean>}
 */
export async function isFreeModel(model, gatewayUrl = 'https://api.kilo.ai/api/gateway', apiKey = '') {
  if (!model) return false;
  const trimmed = model.trim().toLowerCase();
  if (trimmed === 'kilo-auto/free' || trimmed.endsWith(':free') || trimmed.includes(':free')) {
    return true;
  }

  // If not obvious from name, query /models endpoint
  try {
    const url = `${gatewayUrl.replace(/\/+$/, '')}/models`;
    const headers = { 'User-Agent': 'github-action-inference/1.0.0' };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return false;
    const json = await res.json();
    const list = Array.isArray(json) ? json : (Array.isArray(json?.data) ? json.data : []);
    const found = list.find((m) => m.id === model || m.id?.toLowerCase() === trimmed);
    return Boolean(found?.isFree);
  } catch {
    return false;
  }
}

/**
 * Parses and builds the OpenAI chat completions messages array.
 *
 * @param {Object} options
 * @param {string} [options.prompt]
 * @param {string} [options.systemPrompt]
 * @param {string} [options.messages]
 * @returns {Array<{role: string, content: string}>}
 */
export function buildMessages({ prompt, systemPrompt, messages }) {
  if (messages && messages.trim()) {
    try {
      const parsed = JSON.parse(messages.trim());
      if (Array.isArray(parsed)) {
        return parsed;
      }
      throw new Error('Provided "messages" input is not a JSON array');
    } catch (err) {
      throw new Error(`Failed to parse "messages" JSON: ${err.message}`);
    }
  }

  if (!prompt || !prompt.trim()) {
    throw new Error('Either "prompt" or "messages" must be provided.');
  }

  const msgs = [];
  if (systemPrompt && systemPrompt.trim()) {
    msgs.push({ role: 'system', content: systemPrompt.trim() });
  }
  msgs.push({ role: 'user', content: prompt.trim() });
  return msgs;
}

/**
 * Parses a comma-separated or JSON list of fallback models.
 *
 * @param {string} raw
 * @returns {string[]}
 */
export function parseFallbackModels(raw) {
  if (!raw || !raw.trim()) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((m) => String(m).trim()).filter(Boolean);
      }
    } catch {
      // fallback to comma-separated
    }
  }
  return trimmed
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
}

/**
 * Sleeps for a given duration.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sends a single chat completion request to Kilo Gateway.
 *
 * @param {Object} params
 * @returns {Promise<{ ok: boolean, status: number, data?: any, error?: string, retryAfter?: number }>}
 */
export async function sendChatRequest({
  gatewayUrl,
  apiKey,
  model,
  messages,
  maxTokens,
  temperature,
  timeoutMs = 60000,
  fetchFn = fetch,
}) {
  const endpoint = `${gatewayUrl.replace(/\/+$/, '')}/chat/completions`;
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'github-action-inference/1.0.0',
  };
  if (apiKey && apiKey.trim()) {
    headers['Authorization'] = `Bearer ${apiKey.trim()}`;
  }

  const body = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
  };

  try {
    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const status = res.status;
    const retryAfterHeader = res.headers.get('retry-after');
    const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : undefined;

    const rawText = await res.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      data = { rawText };
    }

    if (res.ok) {
      return { ok: true, status, data };
    }

    const errorMsg = data?.error?.message || data?.message || data?.rawText || `HTTP ${status}`;
    return { ok: false, status, error: errorMsg, retryAfter, data };
  } catch (err) {
    const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    return {
      ok: false,
      status: isTimeout ? 408 : 0,
      error: isTimeout ? `Request timed out after ${timeoutMs}ms` : (err.message || 'Network error'),
    };
  }
}

/**
 * Extracts completion text from chat response object.
 * Checks content first, then fallback to reasoning if content is empty.
 *
 * @param {Object} data
 * @returns {string}
 */
export function extractResponseText(data) {
  const choice = data?.choices?.[0];
  if (!choice) return '';
  if (typeof choice.message?.content === 'string' && choice.message.content.length > 0) {
    return choice.message.content;
  }
  if (typeof choice.message?.reasoning === 'string' && choice.message.reasoning.length > 0) {
    return choice.message.reasoning;
  }
  if (typeof choice.text === 'string') {
    return choice.text;
  }
  return '';
}

/**
 * Main inference executor with retries, backoff, and model fallback chains.
 *
 * @param {Object} config
 * @param {Object} [deps]
 * @returns {Promise<Object>}
 */
export async function runInference(
  {
    prompt,
    systemPrompt,
    messages: rawMessages,
    model = 'kilo-auto/free',
    fallbackModels = [],
    apiKey = '',
    gatewayUrl = 'https://api.kilo.ai/api/gateway',
    maxTokens = 1024,
    temperature = 0.7,
    maxRetries = 3,
    retryDelayMs = 2000,
    timeoutMs = 60000,
    enforceFree = true,
    saveToFile = '',
  },
  deps = {}
) {
  const logger = deps.logger || console;
  const sleepFn = deps.sleep || sleep;
  const isFreeFn = deps.isFreeModel || isFreeModel;
  const sendRequestFn = deps.sendChatRequest || sendChatRequest;

  // 1. Build messages
  const messages = buildMessages({ prompt, systemPrompt, messages: rawMessages });

  // 2. Build candidate model chain
  const candidateModels = [model, ...fallbackModels].filter(Boolean);
  // Deduplicate preserving order
  const uniqueModels = Array.from(new Set(candidateModels));

  // 3. Filter / Validate models if enforceFree is on
  const validModels = [];
  for (const m of uniqueModels) {
    if (enforceFree) {
      const free = await isFreeFn(m, gatewayUrl, apiKey);
      if (!free) {
        logger.warn(`Model "${m}" is not recognized as free; skipping because enforce_free=true.`);
        continue;
      }
    }
    validModels.push(m);
  }

  if (validModels.length === 0) {
    return {
      success: false,
      status: 'no_valid_free_models',
      error: `No valid free models available among candidates: ${uniqueModels.join(', ')}. Set enforce_free=false only if you intend to use paid models with your own API key.`,
      modelUsed: '',
      response: '',
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      finishReason: '',
      attempts: [],
    };
  }

  const allAttempts = [];

  // 4. Try candidate models in order
  for (let modelIdx = 0; modelIdx < validModels.length; modelIdx++) {
    const currentModel = validModels[modelIdx];
    logger.info(`Attempting inference with model: "${currentModel}" (candidate ${modelIdx + 1}/${validModels.length})`);

    let attempt = 0;
    while (attempt <= maxRetries) {
      attempt++;
      logger.info(`[${currentModel}] Request attempt ${attempt}/${maxRetries + 1}...`);

      const result = await sendRequestFn({
        gatewayUrl,
        apiKey,
        model: currentModel,
        messages,
        maxTokens,
        temperature,
        timeoutMs,
      });

      allAttempts.push({
        model: currentModel,
        attempt,
        status: result.status,
        ok: result.ok,
        error: result.error,
      });

      if (result.ok) {
        const text = extractResponseText(result.data);
        const usage = result.data?.usage || {};
        const finishReason = result.data?.choices?.[0]?.finish_reason || 'stop';

        if (saveToFile && saveToFile.trim()) {
          const resolvedPath = path.resolve(saveToFile.trim());
          fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
          fs.writeFileSync(resolvedPath, text, 'utf8');
          logger.info(`Response successfully saved to file: ${resolvedPath}`);
        }

        return {
          success: true,
          status: 'success',
          error: '',
          modelUsed: result.data?.model || currentModel,
          response: text,
          totalTokens: usage.total_tokens || 0,
          promptTokens: usage.prompt_tokens || 0,
          completionTokens: usage.completion_tokens || 0,
          finishReason,
          attempts: allAttempts,
        };
      }

      // Check failure nature
      const isRateLimit = result.status === 429;
      const isServerThrottling = result.status >= 500 && result.status < 600;
      const isTimeout = result.status === 408;

      logger.warn(
        `[${currentModel}] Attempt ${attempt} failed with HTTP ${result.status}: ${result.error}`
      );

      // If this is a client error other than 429 (e.g. 400 bad format, 404 model not found),
      // retrying the exact same request on the exact same model won't help; break to fallback model.
      if (!isRateLimit && !isServerThrottling && !isTimeout) {
        logger.warn(`[${currentModel}] Non-retryable error HTTP ${result.status}. Skipping remaining retries on this model.`);
        break;
      }

      // If we still have retries for this model
      if (attempt <= maxRetries) {
        // Calculate delay with exponential backoff and jitter
        let delay = result.retryAfter || retryDelayMs * Math.pow(2, attempt - 1);
        // Add random jitter +/- 20%
        delay = Math.round(delay * (0.8 + Math.random() * 0.4));
        logger.info(`[${currentModel}] Retrying in ${delay}ms...`);
        await sleepFn(delay);
      }
    }

    logger.warn(`[${currentModel}] All retries exhausted or model failed.`);
  }

  // If we reach here, all models and retries failed
  const isAnyRateLimited = allAttempts.some((a) => a.status === 429);
  const isAnyTimeout = allAttempts.some((a) => a.status === 408);
  const status = isAnyRateLimited
    ? 'rate_limited'
    : isAnyTimeout
    ? 'timeout'
    : 'service_unavailable';

  const lastError = allAttempts[allAttempts.length - 1]?.error || 'Unknown inference failure';
  const summaryError = `Inference failed across all attempted models (${validModels.join(', ')}). Status: ${status}. Last error: ${lastError}`;

  return {
    success: false,
    status,
    error: summaryError,
    modelUsed: '',
    response: '',
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    finishReason: '',
    attempts: allAttempts,
  };
}
