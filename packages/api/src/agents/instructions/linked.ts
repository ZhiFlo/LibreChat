import { scopedCacheKey } from '@librechat/data-schemas';
import type {
  FiltersConfig,
  AgentInstructionsPrompt,
  AgentInstructionsPromptSelection,
} from 'librechat-data-provider';
import type { PromptService, ResolvedPrompt } from '~/prompts';
import { assertModelBoundContent } from '~/middleware/modelBoundContent';
import { ContentFilterError } from '~/middleware/contentFilter';
import { inspectPromptContent } from '~/prompts';

/** Facts about a resolved link, retained on the initialized agent. Never persisted. */
export type LinkedInstructionsFacts = {
  source: 'native';
  groupId: string;
  promptId: string;
};

export type LinkedInstructionsUnavailableReason =
  | 'unavailable_selection'
  | 'blocked_content'
  | 'timeout'
  | 'error';

export type LinkedInstructionsResult =
  | { status: 'resolved'; prompt: string; facts: LinkedInstructionsFacts }
  | { status: 'unavailable'; reason: LinkedInstructionsUnavailableReason };

/**
 * Resolves an agent's linked native prompt-group instructions. Usage is no
 * longer recorded here — call `.recordUse(facts)` (below) once the caller's
 * own initialization that used a `resolved` result has itself succeeded.
 */
export type ResolveLinkedInstructions = ((input: {
  link: AgentInstructionsPrompt;
  signal?: AbortSignal;
  filters?: FiltersConfig;
  config?: { timeoutMs?: number; native?: { cacheTtlMs?: number } };
}) => Promise<LinkedInstructionsResult>) & {
  /**
   * Records a usage generation for a resolved link's prompt group. The
   * resolver never calls this itself: `resolve` only reads and caches
   * content, so a caller that never calls `recordUse` records no usage at
   * all. Fire-and-forget — errors are caught and logged, never thrown, and
   * this returns before the increment settles.
   */
  recordUse(facts: LinkedInstructionsFacts): void;
};

/** Minimal cache contract the resolver needs; a Keyv instance already satisfies this shape. */
export interface LinkedInstructionsCache {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, ttl?: number): Promise<unknown>;
}

export interface LinkedInstructionsLogger {
  warn(msg: string, meta?: object): void;
  error(msg: string, meta?: object): void;
}

export interface CreateLinkedInstructionsResolverDeps {
  promptService: Pick<PromptService, 'resolvePrompt' | 'incrementPromptGroupUsage'>;
  cache: LinkedInstructionsCache;
  logger: LinkedInstructionsLogger;
}

/**
 * Mirrors the `linkedInstructions` block defaults in the data-provider agents
 * endpoint schema (`packages/data-provider/src/config.ts`). Those defaults
 * are inline zod literals, not exported constants, so this is the one place
 * that carries the runtime copy — nothing else in the resolver hardcodes
 * either number.
 */
const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_CACHE_TTL_MS = 300_000;

/** The shape written to and read from the content cache. */
interface CachedLinkedPrompt {
  readonly groupId: string;
  readonly promptId: string;
  readonly prompt: string;
  readonly type: ResolvedPrompt['type'];
}

class LinkedInstructionsTimeoutError extends Error {
  constructor() {
    super('Linked instructions resolution timed out');
    this.name = 'LinkedInstructionsTimeoutError';
  }
}

function buildCacheKey(groupId: string, selection: AgentInstructionsPromptSelection): string {
  const selectionKey =
    selection.type === 'production' ? 'production' : `exact:${selection.promptId}`;
  return `native:${groupId}:${selectionKey}`;
}

function isCachedLinkedPrompt(value: unknown): value is CachedLinkedPrompt {
  if (value == null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<CachedLinkedPrompt>;
  return (
    typeof candidate.groupId === 'string' &&
    typeof candidate.promptId === 'string' &&
    typeof candidate.prompt === 'string'
  );
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function mapServiceErrorReason(
  type: 'invalid_input' | 'blocked_content' | 'unavailable_selection' | 'unsupported',
): LinkedInstructionsUnavailableReason {
  return type === 'blocked_content' || type === 'unavailable_selection' ? type : 'error';
}

/**
 * Whether `prompt` is blocked under the caller's current filters. Applies
 * both policies a linked prompt is subject to: the prompt-library policy
 * (`filters.prompts.pii`, via `inspectPromptContent` — the same check
 * `resolvePrompt` itself runs on a fresh fetch) and the agent-instructions
 * policy (`filters.agentInstructions.pii`, via `assertModelBoundContent`'s
 * `agents` field — the same check inline agent instructions and repository
 * instructions get at init). Content that only trips the second policy would
 * otherwise reach the model unfiltered, since linked content used to get only
 * the first.
 */
function isPromptBlocked(prompt: string, filters: FiltersConfig | undefined): boolean {
  if (inspectPromptContent({ prompt }, filters) != null) {
    return true;
  }
  try {
    assertModelBoundContent({ filters, agents: [{ instructions: prompt }] });
    return false;
  } catch (error) {
    if (error instanceof ContentFilterError) {
      return true;
    }
    throw error;
  }
}

/**
 * Bounds `operation` by `timeoutMs` and cancels the wait immediately when
 * `signal` aborts — clearing the timeout timer right away rather than leaving
 * it to fire later. The underlying `operation` itself is not cancelled, only
 * this wait is, so a cache/adapter call already in flight cannot outlive its
 * caller's abort handling.
 */
function runBounded<T>(operation: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const settle = (run: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      run();
    };
    const onAbort = (): void => settle(() => reject(signal?.reason));
    const timer = setTimeout(
      () => settle(() => reject(new LinkedInstructionsTimeoutError())),
      timeoutMs,
    );
    signal?.addEventListener('abort', onAbort);
    operation.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    );
  });
}

/** Milliseconds left until `deadline`, floored at 0. Never negative, so a
 *  spent budget still schedules a real (if immediate) bounded call rather
 *  than one with no timeout at all. */
function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

/**
 * Builds the runtime resolver for an agent's linked native prompt-group
 * instructions.
 *
 * Cache-first: a hit is re-inspected against the caller's *current* filters
 * (so a policy change blocks a previously-cached prompt) before being
 * returned; a miss calls `resolvePrompt` and writes the cache only on
 * success, while unaborted, and only when `cacheTtlMs > 0`. `cacheTtlMs === 0`
 * skips the cache read entirely (and never writes).
 *
 * Latency is bounded by one shared deadline (`config.timeoutMs` from the
 * moment `resolve` is called), not by re-arming a fresh timeout per phase —
 * a slow or failed cache read spends part of that budget, and only what
 * remains is left for `resolvePrompt`, so the worst case stays ~`timeoutMs`
 * overall instead of doubling. A cache read failure or timeout is logged and
 * treated as a miss (falls through to `resolvePrompt`) rather than failing
 * the turn — a cache outage must not drop instructions. The cache write
 * itself never blocks the caller: it is fire-and-forget (errors caught and
 * logged), issued only when unaborted.
 *
 * Abort is checked before work starts and after every await and always
 * throws the signal's abort reason — it is never mapped to an `unavailable`
 * result, and a cancelled call never writes the cache. Failures (timeout on
 * the `resolvePrompt` phase, a thrown adapter error) resolve to
 * `{ status: 'unavailable', reason }`. Logs never include prompt text — only
 * the reason, groupId, and the error's name.
 *
 * The returned function never records prompt-group usage itself; call its
 * `.recordUse(facts)` once the caller's own initialization succeeds.
 */
export function createLinkedInstructionsResolver(
  deps: CreateLinkedInstructionsResolverDeps,
): ResolveLinkedInstructions {
  const { promptService, cache, logger } = deps;

  const resolve = async function resolveLinkedInstructions({
    link,
    signal,
    filters,
    config,
  }: {
    link: AgentInstructionsPrompt;
    signal?: AbortSignal;
    filters?: FiltersConfig;
    config?: { timeoutMs?: number; native?: { cacheTtlMs?: number } };
  }): Promise<LinkedInstructionsResult> {
    signal?.throwIfAborted();

    const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const cacheTtlMs = config?.native?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    const key = scopedCacheKey(buildCacheKey(link.groupId, link.selection));
    const deadline = Date.now() + timeoutMs;

    let cached: CachedLinkedPrompt | undefined;
    if (cacheTtlMs > 0) {
      try {
        const raw = await runBounded(cache.get(key), remainingMs(deadline), signal);
        cached = isCachedLinkedPrompt(raw) ? raw : undefined;
      } catch (error) {
        /* An abort must still surface as the abort reason, not be swallowed into
         * the "fall through to resolvePrompt" handling below. */
        signal?.throwIfAborted();
        logger.warn('[linkedInstructions] Cache read failed; resolving without cache', {
          groupId: link.groupId,
          errorName: errorName(error),
        });
      }
    }
    signal?.throwIfAborted();

    if (cached) {
      if (isPromptBlocked(cached.prompt, filters)) {
        return { status: 'unavailable', reason: 'blocked_content' };
      }
      return {
        status: 'resolved',
        prompt: cached.prompt,
        facts: { source: 'native', groupId: cached.groupId, promptId: cached.promptId },
      };
    }

    let fetched: ResolvedPrompt;
    try {
      const result = await runBounded(
        promptService.resolvePrompt({ groupId: link.groupId, selection: link.selection, filters }),
        remainingMs(deadline),
        signal,
      );
      signal?.throwIfAborted();
      if (!result.ok) {
        return { status: 'unavailable', reason: mapServiceErrorReason(result.error.type) };
      }
      fetched = result.value;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof LinkedInstructionsTimeoutError) {
        return { status: 'unavailable', reason: 'timeout' };
      }
      logger.error('[linkedInstructions] resolvePrompt failed', {
        groupId: link.groupId,
        errorName: errorName(error),
      });
      return { status: 'unavailable', reason: 'error' };
    }

    if (isPromptBlocked(fetched.prompt, filters)) {
      return { status: 'unavailable', reason: 'blocked_content' };
    }

    if (cacheTtlMs > 0 && !signal?.aborted) {
      /* Fire-and-forget: the turn must not wait on the cache write, and a
       * write failure is a cache-warmth loss, not a resolution failure. */
      cache
        .set(
          key,
          {
            groupId: fetched.groupId,
            promptId: fetched.promptId,
            prompt: fetched.prompt,
            type: fetched.type,
          },
          cacheTtlMs,
        )
        .catch((error: unknown) => {
          logger.warn('[linkedInstructions] Cache write failed', {
            groupId: fetched.groupId,
            errorName: errorName(error),
          });
        });
    }
    signal?.throwIfAborted();

    return {
      status: 'resolved',
      prompt: fetched.prompt,
      facts: { source: 'native', groupId: fetched.groupId, promptId: fetched.promptId },
    };
  };

  const recordUse = (facts: LinkedInstructionsFacts): void => {
    promptService.incrementPromptGroupUsage(facts.groupId).catch((error: unknown) => {
      logger.warn('[linkedInstructions] Failed to record prompt group usage', {
        groupId: facts.groupId,
        errorName: errorName(error),
      });
    });
  };

  return Object.assign(resolve, { recordUse });
}
