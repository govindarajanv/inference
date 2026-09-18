import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  buildMessages,
  parseFallbackModels,
  isFreeModel,
  extractResponseText,
  runInference,
} from '../src/inference.js';

describe('buildMessages', () => {
  test('creates single user message from prompt', () => {
    const msgs = buildMessages({ prompt: 'Hello world' });
    assert.deepEqual(msgs, [{ role: 'user', content: 'Hello world' }]);
  });

  test('creates system and user messages when systemPrompt is provided', () => {
    const msgs = buildMessages({
      prompt: 'Summarize this',
      systemPrompt: 'You are a helpful summarizer',
    });
    assert.deepEqual(msgs, [
      { role: 'system', content: 'You are a helpful summarizer' },
      { role: 'user', content: 'Summarize this' },
    ]);
  });

  test('parses raw JSON messages array', () => {
    const raw = JSON.stringify([
      { role: 'system', content: 'Act like a pirate' },
      { role: 'user', content: 'Ahoy' },
    ]);
    const msgs = buildMessages({ messages: raw });
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, 'system');
    assert.equal(msgs[1].content, 'Ahoy');
  });

  test('throws if neither prompt nor messages is given', () => {
    assert.throws(() => buildMessages({}), /Either "prompt" or "messages" must be provided/);
  });

  test('throws if messages is not valid JSON array', () => {
    assert.throws(
      () => buildMessages({ messages: '{"role": "user"}' }),
      /Provided "messages" input is not a JSON array/
    );
  });
});

describe('parseFallbackModels', () => {
  test('parses comma-separated string', () => {
    const res = parseFallbackModels('model-a:free, model-b:free, model-c:free');
    assert.deepEqual(res, ['model-a:free', 'model-b:free', 'model-c:free']);
  });

  test('parses JSON array format', () => {
    const res = parseFallbackModels('["model-1:free", "model-2:free"]');
    assert.deepEqual(res, ['model-1:free', 'model-2:free']);
  });

  test('handles empty or whitespace strings', () => {
    assert.deepEqual(parseFallbackModels(''), []);
    assert.deepEqual(parseFallbackModels('   '), []);
  });
});

describe('isFreeModel', () => {
  test('identifies kilo-auto/free as free', async () => {
    assert.equal(await isFreeModel('kilo-auto/free'), true);
  });

  test('identifies :free suffixed models as free', async () => {
    assert.equal(await isFreeModel('deepseek/deepseek-v4-flash-0731:free'), true);
    assert.equal(await isFreeModel('stepfun/step-3.7-flash:free'), true);
  });

  test('rejects obvious paid models when mock models endpoint is empty', async () => {
    assert.equal(await isFreeModel('anthropic/claude-sonnet-4.5', 'http://invalid-mock'), false);
    assert.equal(await isFreeModel('openai/gpt-4.5', 'http://invalid-mock'), false);
  });
});

describe('extractResponseText', () => {
  test('extracts message content when available', () => {
    const text = extractResponseText({
      choices: [{ message: { content: 'Generated text output' } }],
    });
    assert.equal(text, 'Generated text output');
  });

  test('falls back to message reasoning when content is null', () => {
    const text = extractResponseText({
      choices: [{ message: { content: null, reasoning: 'Reasoning chain steps' } }],
    });
    assert.equal(text, 'Reasoning chain steps');
  });

  test('falls back to choice.text if present', () => {
    const text = extractResponseText({
      choices: [{ text: 'Legacy text format' }],
    });
    assert.equal(text, 'Legacy text format');
  });

  test('returns empty string on empty choices', () => {
    assert.equal(extractResponseText({ choices: [] }), '');
    assert.equal(extractResponseText(null), '');
  });
});

describe('runInference execution and resilience', () => {
  const silentLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  const fastSleep = async () => {};

  test('succeeds on first attempt with primary model', async () => {
    const mockSend = async ({ model }) => ({
      ok: true,
      status: 200,
      data: {
        model,
        choices: [{ message: { content: 'Success response' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    });

    const res = await runInference(
      {
        prompt: 'Say hi',
        model: 'kilo-auto/free',
      },
      {
        logger: silentLogger,
        sleep: fastSleep,
        sendChatRequest: mockSend,
      }
    );

    assert.equal(res.success, true);
    assert.equal(res.status, 'success');
    assert.equal(res.response, 'Success response');
    assert.equal(res.totalTokens, 15);
    assert.equal(res.modelUsed, 'kilo-auto/free');
  });

  test('retries on HTTP 429 and succeeds when retry resolves', async () => {
    let callCount = 0;
    const mockSend = async ({ model }) => {
      callCount++;
      if (callCount === 1) {
        return { ok: false, status: 429, error: 'Rate limit exceeded for free models.' };
      }
      return {
        ok: true,
        status: 200,
        data: {
          model,
          choices: [{ message: { content: 'Recovered after retry' } }],
          usage: { total_tokens: 20 },
        },
      };
    };

    const res = await runInference(
      {
        prompt: 'Ping',
        model: 'kilo-auto/free',
        maxRetries: 2,
      },
      {
        logger: silentLogger,
        sleep: fastSleep,
        sendChatRequest: mockSend,
      }
    );

    assert.equal(res.success, true);
    assert.equal(res.response, 'Recovered after retry');
    assert.equal(callCount, 2);
  });

  test('falls back to secondary model if primary exhausts retries with 429', async () => {
    const attemptedModels = [];
    const mockSend = async ({ model }) => {
      attemptedModels.push(model);
      if (model === 'kilo-auto/free') {
        return { ok: false, status: 429, error: 'Throttled' };
      }
      return {
        ok: true,
        status: 200,
        data: {
          model,
          choices: [{ message: { content: 'Success from fallback model' } }],
          usage: { total_tokens: 30 },
        },
      };
    };

    const res = await runInference(
      {
        prompt: 'Generate code',
        model: 'kilo-auto/free',
        fallbackModels: ['deepseek/deepseek-v4-flash-0731:free'],
        maxRetries: 1,
      },
      {
        logger: silentLogger,
        sleep: fastSleep,
        sendChatRequest: mockSend,
      }
    );

    assert.equal(res.success, true);
    assert.equal(res.response, 'Success from fallback model');
    assert.equal(res.modelUsed, 'deepseek/deepseek-v4-flash-0731:free');
    assert(attemptedModels.includes('kilo-auto/free'));
    assert(attemptedModels.includes('deepseek/deepseek-v4-flash-0731:free'));
  });

  test('gracefully fails with status rate_limited when all models and retries fail', async () => {
    const mockSend = async () => ({
      ok: false,
      status: 429,
      error: 'Rate limit exceeded for free models. Please try again later.',
    });

    const res = await runInference(
      {
        prompt: 'Test prompt',
        model: 'kilo-auto/free',
        fallbackModels: ['stepfun/step-3.7-flash:free'],
        maxRetries: 1,
      },
      {
        logger: silentLogger,
        sleep: fastSleep,
        sendChatRequest: mockSend,
      }
    );

    assert.equal(res.success, false);
    assert.equal(res.status, 'rate_limited');
    assert.equal(res.response, '');
    assert(res.error.includes('Rate limit exceeded'));
    assert.equal(res.attempts.length, 4); // (1 + 1 retries) * 2 models
  });

  test('enforceFree skips paid models and prevents charges', async () => {
    const res = await runInference(
      {
        prompt: 'Test',
        model: 'openai/gpt-4.5',
        fallbackModels: [],
        enforceFree: true,
      },
      {
        logger: silentLogger,
        sleep: fastSleep,
        isFreeModel: async () => false,
      }
    );

    assert.equal(res.success, false);
    assert.equal(res.status, 'no_valid_free_models');
    assert(res.error.includes('No valid free models available'));
  });

  test('saves output to file if saveToFile path is provided', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inference-test-'));
    const outFile = path.join(tmpDir, 'subdir', 'result.md');

    const mockSend = async ({ model }) => ({
      ok: true,
      status: 200,
      data: {
        model,
        choices: [{ message: { content: '# Output heading\n\nResult text' } }],
      },
    });

    const res = await runInference(
      {
        prompt: 'Write markdown',
        model: 'kilo-auto/free',
        saveToFile: outFile,
      },
      {
        logger: silentLogger,
        sleep: fastSleep,
        sendChatRequest: mockSend,
      }
    );

    assert.equal(res.success, true);
    assert(fs.existsSync(outFile));
    assert.equal(fs.readFileSync(outFile, 'utf8'), '# Output heading\n\nResult text');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
