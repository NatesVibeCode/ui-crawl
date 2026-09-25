/**
 * Example OpenAI-compatible model ports for ui-crawl.
 *
 * Not imported by src/** — the harness only sees the port interfaces. Wire them
 * programmatically:
 *
 *   import { crawl } from '@aidev/ui-crawl';
 *   import { openAiCompatiblePorts } from './examples/model-ports-openai.mjs';
 *
 *   const ports = openAiCompatiblePorts({ apiKey: process.env.OPENAI_API_KEY });
 *   await crawl({ baseUrl, text: ports.text, vision: ports.vision, observeControls: true });
 *
 * Any OpenAI-compatible endpoint works (baseUrl + /chat/completions).
 * Empty string on any failure preserves the Noop/anti-spoof posture.
 */

/**
 * @param {{ apiKey: string, model?: string, visionModel?: string, baseUrl?: string }} opts
 */
export function openAiCompatiblePorts(opts) {
  const apiKey = opts.apiKey;
  const baseUrl = (opts.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = opts.model || 'gpt-4o-mini';
  const visionModel = opts.visionModel || model;

  async function chat(messages, useVision = false) {
    if (!apiKey) return '';
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: useVision ? visionModel : model,
          messages,
          temperature: 0,
        }),
      });
      if (!res.ok) return '';
      const data = await res.json();
      return data?.choices?.[0]?.message?.content ?? '';
    } catch {
      return '';
    }
  }

  return {
    text: {
      complete({ system, prompt }) {
        return chat([
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ]);
      },
    },
    vision: {
      async judge({ imageRef, system, prompt }) {
        // imageRef is a path relative to outDir; callers that need true VLM judging
        // should read + base64 the file here. Returning '' keeps findings in taste.
        void imageRef;
        void system;
        void prompt;
        return '';
      },
    },
  };
}
