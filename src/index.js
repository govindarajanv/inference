import * as core from '@actions/core';
import { runInference, parseFallbackModels } from './inference.js';

export async function run() {
  try {
    const prompt = core.getInput('prompt');
    const systemPrompt = core.getInput('system_prompt');
    const messages = core.getInput('messages');
    const model = core.getInput('model') || 'kilo-auto/free';
    const fallbackModelsRaw = core.getInput('fallback_models');
    const apiKey = core.getInput('api_key');
    const gatewayUrl = core.getInput('gateway_url') || 'https://api.kilo.ai/api/gateway';
    const maxTokens = parseInt(core.getInput('max_tokens') || '1024', 10);
    const temperature = parseFloat(core.getInput('temperature') || '0.7');
    const maxRetries = parseInt(core.getInput('max_retries') || '3', 10);
    const retryDelayMs = parseInt(core.getInput('retry_delay_ms') || '2000', 10);
    const timeoutMs = parseInt(core.getInput('timeout_ms') || '60000', 10);
    const saveToFile = core.getInput('save_to_file');

    let enforceFree = true;
    try {
      enforceFree = core.getBooleanInput('enforce_free');
    } catch {
      enforceFree = core.getInput('enforce_free') !== 'false';
    }

    let failOnError = false;
    try {
      failOnError = core.getBooleanInput('fail_on_error');
    } catch {
      failOnError = core.getInput('fail_on_error') === 'true';
    }

    if (apiKey && apiKey.trim()) {
      core.setSecret(apiKey.trim());
    }

    const fallbackModels = parseFallbackModels(
      fallbackModelsRaw ||
        'kilo-auto/free,deepseek/deepseek-v4-flash-0731:free,stepfun/step-3.7-flash:free,qwen/qwen3.8-27b:free,nvidia/nemotron-3-ultra-550b-a55b:free'
    );

    core.info('Starting inference action with free Kilo Gateway...');
    core.info(`Target model: ${model}`);
    core.info(`Fallback candidates: ${fallbackModels.join(', ') || 'None'}`);
    core.info(`Enforce free models: ${enforceFree}`);
    core.info(`Fail on error: ${failOnError}`);

    const result = await runInference(
      {
        prompt,
        systemPrompt,
        messages,
        model,
        fallbackModels,
        apiKey,
        gatewayUrl,
        maxTokens,
        temperature,
        maxRetries,
        retryDelayMs,
        timeoutMs,
        enforceFree,
        saveToFile,
      },
      {
        logger: {
          info: (msg) => core.info(msg),
          warn: (msg) => core.warning(msg),
          error: (msg) => core.error(msg),
        },
      }
    );

    // Set outputs
    core.setOutput('response', result.response);
    core.setOutput('success', String(result.success));
    core.setOutput('status', result.status);
    core.setOutput('error', result.error);
    core.setOutput('model_used', result.modelUsed);
    core.setOutput('total_tokens', String(result.totalTokens));
    core.setOutput('prompt_tokens', String(result.promptTokens));
    core.setOutput('completion_tokens', String(result.completionTokens));
    core.setOutput('finish_reason', result.finishReason);

    // Generate Step Summary
    await renderSummary(result, failOnError);

    if (!result.success) {
      if (failOnError) {
        core.setFailed(result.error || 'Inference failed.');
      } else {
        core.warning(
          `Inference encountered an issue (${result.status}): ${result.error}. Continuing gracefully because fail_on_error=false.`
        );
      }
    } else {
      core.info(`Inference completed successfully using model: ${result.modelUsed}`);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    core.setOutput('response', '');
    core.setOutput('success', 'false');
    core.setOutput('status', 'fatal_error');
    core.setOutput('error', errorMsg);
    core.setOutput('model_used', '');
    core.setOutput('total_tokens', '0');
    core.setOutput('prompt_tokens', '0');
    core.setOutput('completion_tokens', '0');
    core.setOutput('finish_reason', '');

    let failOnError = false;
    try {
      failOnError = core.getBooleanInput('fail_on_error');
    } catch {
      failOnError = false;
    }

    if (failOnError) {
      core.setFailed(errorMsg);
    } else {
      core.warning(`Fatal error during inference execution: ${errorMsg}. Continuing gracefully because fail_on_error=false.`);
    }
  }
}

/**
 * Builds GitHub Step Summary.
 */
async function renderSummary(result, failOnError) {
  try {
    const s = core.summary;
    s.addHeading('Kilo Gateway Inference Summary', 2);

    if (result.success) {
      s.addTable([
        [
          { data: 'Status', header: true },
          { data: 'Model Used', header: true },
          { data: 'Total Tokens', header: true },
          { data: 'Finish Reason', header: true },
        ],
        [
          '✅ Success',
          result.modelUsed || 'N/A',
          String(result.totalTokens || 0),
          result.finishReason || 'stop',
        ],
      ]);

      s.addHeading('Output Preview', 3);
      const preview =
        result.response.length > 500
          ? `${result.response.substring(0, 500)}...\n\n*(Truncated, full length: ${result.response.length} characters)*`
          : result.response;
      s.addCodeBlock(preview, 'markdown');
    } else {
      s.addTable([
        [
          { data: 'Status', header: true },
          { data: 'Failure Reason', header: true },
          { data: 'Step Behavior', header: true },
        ],
        [
          `⚠️ ${result.status}`,
          result.error,
          failOnError ? '❌ Workflow Job Failed' : '🛡️ Graceful Pass (fail_on_error=false)',
        ],
      ]);

      if (result.attempts && result.attempts.length > 0) {
        s.addHeading('Execution Attempts', 3);
        const attemptRows = result.attempts.map((a) => [
          a.model,
          String(a.attempt),
          String(a.status),
          a.ok ? 'OK' : (a.error || 'Failed'),
        ]);
        s.addTable([
          [
            { data: 'Model', header: true },
            { data: 'Attempt #', header: true },
            { data: 'HTTP Status', header: true },
            { data: 'Details', header: true },
          ],
          ...attemptRows,
        ]);
      }

      s.addRaw(
        '\n> [!NOTE]\n> Kilo Gateway free tier limits requests to 200 requests/hour per IP. Because `fail_on_error: false` was set, this workflow step exited gracefully without breaking dependent jobs.\n'
      );
    }

    await s.write();
  } catch (err) {
    core.info(`Could not generate GitHub step summary: ${err.message}`);
  }
}

if (process.env.NODE_ENV !== 'test') {
  run();
}
