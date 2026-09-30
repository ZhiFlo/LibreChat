import type {
  FiltersConfig,
  AgentInstructionsPrompt,
  AgentInstructionsPromptSelection,
} from 'librechat-data-provider';
import type { PromptService, ResolvedPrompt } from '~/prompts';
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

export type ResolveLinkedInstructions = (input: {
  link: AgentInstructionsPrompt;
  signal?: AbortSignal;
  filters?: FiltersConfig;
  config?: { timeoutMs?: number; native?: { cacheTtlMs?: number } };
  recordUsage: boolean;
}) => Promise<LinkedInstructionsResult>;

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

function recordUsageInBackground(
  promptService: Pick<PromptService, 'incrementPromptGroupUsage'>,
  logger: LinkedInstructionsLogger,
  groupId: string,
): void {
  promptService.incrementPromptGroupUsage(groupId).catch((error: unknown) => {
    logger.warn('[linkedInstructions] Failed to record prompt group usage', {
      groupId,
      errorName: errorName(error),
    });
  });
}

/**
 * Builds the runtime resolver for an agent's linked native prompt-group
 * instructions.
 *
 * Cache-first: a hit is re-inspected against the caller's *current* filters
 * (so a policy change blocks a previously-cached prompt) before being
 * returned; a miss calls `resolvePrompt` and writes the cache only on
 * success, while unaborted, and only when `cacheTtlMs > 0`. Every external
 * call is bounded by `config.timeoutMs`. Abort is checked before work starts
 * and after every await and always throws the signal's abort reason — it is
 * never mapped to an `unavailable` result, and a cancelled call never writes
 * the cache. Failures (timeout, a thrown adapter error, a cache read error)
 * resolve to `{ status: 'unavailable', reason }`. Logs never include prompt
 * text — only the reason, groupId, and the error's name.
 */
export function createLinkedInstructionsResolver(
  deps: CreateLinkedInstructionsResolverDeps,
): ResolveLinkedInstructions {
  const { promptService, cache, logger } = deps;

  return async function resolveLinkedInstructions({
    link,
    signal,
    filters,
    config,
    recordUsage,
  }): Promise<LinkedInstructionsResult> {
    signal?.throwIfAborted();

    const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const cacheTtlMs = config?.native?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    const key = buildCacheKey(link.groupId, link.selection);

    let cached: CachedLinkedPrompt | undefined;
    try {
      const raw = await runBounded(cache.get(key), timeoutMs, signal);
      cached = isCachedLinkedPrompt(raw) ? raw : undefined;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof LinkedInstructionsTimeoutError) {
        return { status: 'unavailable', reason: 'timeout' };
      }
      logger.error('[linkedInstructions] Cache read failed', {
        groupId: link.groupId,
        errorName: errorName(error),
      });
      return { status: 'unavailable', reason: 'error' };
    }
    signal?.throwIfAborted();

    if (cached) {
      const finding = inspectPromptContent({ prompt: cached.prompt }, filters);
      if (finding != null) {
        return { status: 'unavailable', reason: 'blocked_content' };
      }
      if (recordUsage) {
        recordUsageInBackground(promptService, logger, cached.groupId);
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
        timeoutMs,
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

    if (cacheTtlMs > 0 && !signal?.aborted) {
      try {
        await cache.set(
          key,
          {
            groupId: fetched.groupId,
            promptId: fetched.promptId,
            prompt: fetched.prompt,
            type: fetched.type,
          },
          cacheTtlMs,
        );
      } catch (error) {
        logger.warn('[linkedInstructions] Cache write failed', {
          groupId: fetched.groupId,
          errorName: errorName(error),
        });
      }
    }
    signal?.throwIfAborted();

    if (recordUsage) {
      recordUsageInBackground(promptService, logger, fetched.groupId);
    }

    return {
      status: 'resolved',
      prompt: fetched.prompt,
      facts: { source: 'native', groupId: fetched.groupId, promptId: fetched.promptId },
    };
  };
}
