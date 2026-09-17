/**
 * Injected model ports. Both default to Noop so the deterministic core runs with
 * nothing wired (v1). v2 supplies real adapters (an OpenRouter VLM behind VisionPort,
 * a cheap DeepSeek-class model behind TextTriagePort) WITHOUT changing the bucketing.
 *
 * `VisionPort` is defined locally — structurally identical to `@aidev/ports`' VisionPort
 * (`judge({imageRef, system, prompt}) => string`) — so the harness stays self-contained
 * (only a `playwright` dependency) while a canon adapter remains drop-in compatible.
 *
 * Anti-spoof posture (inherited from the canon): an empty model reply means "no judgement",
 * which keeps a finding in `taste`. A model never silently promotes a thing to `defect`.
 */

/** Judge an image given a system + user prompt; return the raw model text. */
export interface VisionPort {
  judge(args: { imageRef: string; system: string; prompt: string }): string;
}

/** Default that binds no vision model. Empty reply => no escalation. */
export class NoopVisionPort implements VisionPort {
  judge(_args: { imageRef: string; system: string; prompt: string }): string {
    return '';
  }
}

/** Minimal text-completion port: prompt in, text (or JSON) out. */
export interface TextTriagePort {
  complete(args: { system: string; prompt: string }): string;
}

/** Default that binds no text model. Empty reply => deterministic bucketing stands. */
export class NoopTextTriagePort implements TextTriagePort {
  complete(_args: { system: string; prompt: string }): string {
    return '';
  }
}
