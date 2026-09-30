import type { FiltersConfig, AgentInstructionsPrompt } from 'librechat-data-provider';
import type { LinkedInstructionsCache, LinkedInstructionsLogger } from './linked';
import type { PromptService, ResolvedPrompt } from '~/prompts';
import { createLinkedInstructionsResolver } from './linked';

/** Map-based cache with real per-entry TTL, matching the Keyv contract the resolver relies on. */
class FakeCache implements LinkedInstructionsCache {
  private store = new Map<string, { value: unknown; expiresAt?: number }>();

  async get(key: string): Promise<unknown> {
    const entry = this.store.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt != null && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  async set(key: string, value: unknown, ttl?: number): Promise<boolean> {
    this.store.set(key, { value, expiresAt: ttl ? Date.now() + ttl : undefined });
    return true;
  }

  get size(): number {
    return this.store.size;
  }
}

const blockingFilters: FiltersConfig = {
  prompts: {
    pii: {
      starterPatterns: [],
      customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
      fields: ['text'],
    },
  },
};

const groupId = '507f1f77bcf86cd799439011';
const promptId = '507f1f77bcf86cd799439012';

const productionLink: AgentInstructionsPrompt = {
  source: 'native',
  groupId,
  selection: { type: 'production' },
};

const exactLink: AgentInstructionsPrompt = {
  source: 'native',
  groupId,
  selection: { type: 'exact', promptId },
};

function makeResolvedPrompt(overrides: Partial<ResolvedPrompt> = {}): ResolvedPrompt {
  return {
    groupId,
    promptId,
    prompt: 'You are a helpful assistant.',
    type: 'text',
    ...overrides,
  };
}

function makeLogger(): LinkedInstructionsLogger & { warn: jest.Mock; error: jest.Mock } {
  return { warn: jest.fn(), error: jest.fn() };
}

function makePromptService(
  overrides: Partial<Pick<PromptService, 'resolvePrompt' | 'incrementPromptGroupUsage'>> = {},
): Pick<PromptService, 'resolvePrompt' | 'incrementPromptGroupUsage'> {
  return {
    resolvePrompt: jest.fn().mockResolvedValue({ ok: true, value: makeResolvedPrompt() }),
    incrementPromptGroupUsage: jest.fn().mockResolvedValue({ numberOfGenerations: 1 }),
    ...overrides,
  };
}

/** Flushes pending microtasks (used to let fire-and-forget usage calls settle). */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('createLinkedInstructionsResolver', () => {
  it('resolves the production selection on a cache miss and caches the result', async () => {
    const cache = new FakeCache();
    const promptService = makePromptService();
    const logger = makeLogger();
    const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

    const result = await resolver({ link: productionLink, recordUsage: false });

    expect(result).toEqual({
      status: 'resolved',
      prompt: 'You are a helpful assistant.',
      facts: { source: 'native', groupId, promptId },
    });
    expect(promptService.resolvePrompt).toHaveBeenCalledWith({
      groupId,
      selection: { type: 'production' },
      filters: undefined,
    });
    await expect(cache.get(`native:${groupId}:production`)).resolves.toMatchObject({
      groupId,
      promptId,
      prompt: 'You are a helpful assistant.',
    });
  });

  it('resolves an exact revision selection and caches it under the exact key', async () => {
    const cache = new FakeCache();
    const promptService = makePromptService();
    const logger = makeLogger();
    const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

    const result = await resolver({ link: exactLink, recordUsage: false });

    expect(result.status).toBe('resolved');
    expect(promptService.resolvePrompt).toHaveBeenCalledWith({
      groupId,
      selection: { type: 'exact', promptId },
      filters: undefined,
    });
    await expect(cache.get(`native:${groupId}:exact:${promptId}`)).resolves.toBeDefined();
  });

  it('serves a cache hit without calling resolvePrompt', async () => {
    const cache = new FakeCache();
    await cache.set(`native:${groupId}:production`, {
      groupId,
      promptId,
      prompt: 'Cached instructions',
      type: 'text',
    });
    const promptService = makePromptService();
    const logger = makeLogger();
    const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

    const result = await resolver({ link: productionLink, recordUsage: false });

    expect(result).toEqual({
      status: 'resolved',
      prompt: 'Cached instructions',
      facts: { source: 'native', groupId, promptId },
    });
    expect(promptService.resolvePrompt).not.toHaveBeenCalled();
  });

  it('re-inspects a cache hit and blocks it when current filters now block the content', async () => {
    const cache = new FakeCache();
    await cache.set(`native:${groupId}:production`, {
      groupId,
      promptId,
      prompt: 'Contains PRIVATE-SECRET marker',
      type: 'text',
    });
    const promptService = makePromptService();
    const logger = makeLogger();
    const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

    const result = await resolver({
      link: productionLink,
      filters: blockingFilters,
      recordUsage: false,
    });

    expect(result).toEqual({ status: 'unavailable', reason: 'blocked_content' });
    expect(promptService.resolvePrompt).not.toHaveBeenCalled();
  });

  it('fetches fresh content after the cached entry expires', async () => {
    jest.useFakeTimers();
    try {
      const cache = new FakeCache();
      const promptService = makePromptService({
        resolvePrompt: jest
          .fn()
          .mockResolvedValueOnce({ ok: true, value: makeResolvedPrompt({ prompt: 'first' }) })
          .mockResolvedValueOnce({ ok: true, value: makeResolvedPrompt({ prompt: 'second' }) }),
      });
      const logger = makeLogger();
      const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

      const first = await resolver({
        link: productionLink,
        config: { native: { cacheTtlMs: 1000 } },
        recordUsage: false,
      });
      expect(first).toMatchObject({ status: 'resolved', prompt: 'first' });

      jest.advanceTimersByTime(1001);

      const second = await resolver({
        link: productionLink,
        config: { native: { cacheTtlMs: 1000 } },
        recordUsage: false,
      });
      expect(second).toMatchObject({ status: 'resolved', prompt: 'second' });
      expect(promptService.resolvePrompt).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not write the cache when cacheTtlMs is 0', async () => {
    const cache = new FakeCache();
    const setSpy = jest.spyOn(cache, 'set');
    const promptService = makePromptService();
    const logger = makeLogger();
    const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

    const result = await resolver({
      link: productionLink,
      config: { native: { cacheTtlMs: 0 } },
      recordUsage: false,
    });

    expect(result.status).toBe('resolved');
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('returns unavailable "timeout" when resolvePrompt does not settle in time', async () => {
    jest.useFakeTimers();
    try {
      const cache = new FakeCache();
      const promptService = makePromptService({
        resolvePrompt: jest.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve({ ok: true, value: makeResolvedPrompt() }), 200);
            }),
        ),
      });
      const logger = makeLogger();
      const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

      const pending = resolver({
        link: productionLink,
        config: { timeoutMs: 10 },
        recordUsage: false,
      });
      await jest.advanceTimersByTimeAsync(11);

      await expect(pending).resolves.toEqual({ status: 'unavailable', reason: 'timeout' });
      // Let the still-pending mock's own timer fire and resolve harmlessly.
      await jest.advanceTimersByTimeAsync(200);
    } finally {
      jest.useRealTimers();
    }
  });

  it('returns unavailable "error" when resolvePrompt throws', async () => {
    const cache = new FakeCache();
    const promptService = makePromptService({
      resolvePrompt: jest.fn().mockRejectedValue(new Error('adapter exploded')),
    });
    const logger = makeLogger();
    const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

    const result = await resolver({ link: productionLink, recordUsage: false });

    expect(result).toEqual({ status: 'unavailable', reason: 'error' });
    expect(logger.error).toHaveBeenCalledWith(
      '[linkedInstructions] resolvePrompt failed',
      expect.objectContaining({ groupId, errorName: 'Error' }),
    );
  });

  it('maps unavailable_selection and blocked_content service errors', async () => {
    const cache = new FakeCache();
    const logger = makeLogger();

    const unavailableService = makePromptService({
      resolvePrompt: jest.fn().mockResolvedValue({
        ok: false,
        error: { type: 'unavailable_selection', reason: 'production' },
      }),
    });
    const unavailableResolver = createLinkedInstructionsResolver({
      promptService: unavailableService,
      cache,
      logger,
    });
    await expect(
      unavailableResolver({ link: productionLink, recordUsage: false }),
    ).resolves.toEqual({ status: 'unavailable', reason: 'unavailable_selection' });

    const blockedService = makePromptService({
      resolvePrompt: jest.fn().mockResolvedValue({
        ok: false,
        error: { type: 'blocked_content', finding: { source: 'prompt' } },
      }),
    });
    const blockedResolver = createLinkedInstructionsResolver({
      promptService: blockedService,
      cache: new FakeCache(),
      logger,
    });
    await expect(blockedResolver({ link: productionLink, recordUsage: false })).resolves.toEqual({
      status: 'unavailable',
      reason: 'blocked_content',
    });
  });

  it('throws the abort reason when already aborted before any work starts', async () => {
    const cache = new FakeCache();
    const getSpy = jest.spyOn(cache, 'get');
    const setSpy = jest.spyOn(cache, 'set');
    const promptService = makePromptService();
    const logger = makeLogger();
    const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

    const controller = new AbortController();
    controller.abort();

    await expect(
      resolver({ link: productionLink, signal: controller.signal, recordUsage: false }),
    ).rejects.toBe(controller.signal.reason);
    expect(getSpy).not.toHaveBeenCalled();
    expect(setSpy).not.toHaveBeenCalled();
    expect(promptService.resolvePrompt).not.toHaveBeenCalled();
  });

  it('throws the abort reason when aborted mid-flight and never writes the cache', async () => {
    const cache = new FakeCache();
    const setSpy = jest.spyOn(cache, 'set');
    jest.spyOn(cache, 'get').mockReturnValue(new Promise(() => {}));
    const promptService = makePromptService();
    const logger = makeLogger();
    const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

    const controller = new AbortController();
    const pending = resolver({
      link: productionLink,
      signal: controller.signal,
      recordUsage: false,
    });
    controller.abort();

    await expect(pending).rejects.toBe(controller.signal.reason);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('records usage once when resolved and recordUsage is true', async () => {
    const cache = new FakeCache();
    const promptService = makePromptService();
    const logger = makeLogger();
    const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

    await resolver({ link: productionLink, recordUsage: true });
    await flush();

    expect(promptService.incrementPromptGroupUsage).toHaveBeenCalledTimes(1);
    expect(promptService.incrementPromptGroupUsage).toHaveBeenCalledWith(groupId);
  });

  it('does not record usage when recordUsage is false', async () => {
    const cache = new FakeCache();
    const promptService = makePromptService();
    const logger = makeLogger();
    const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

    await resolver({ link: productionLink, recordUsage: false });
    await flush();

    expect(promptService.incrementPromptGroupUsage).not.toHaveBeenCalled();
  });

  it('does not record usage when the result is unavailable', async () => {
    const cache = new FakeCache();
    const promptService = makePromptService({
      resolvePrompt: jest.fn().mockRejectedValue(new Error('boom')),
    });
    const logger = makeLogger();
    const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

    await resolver({ link: productionLink, recordUsage: true });
    await flush();

    expect(promptService.incrementPromptGroupUsage).not.toHaveBeenCalled();
  });

  it('logs but does not fail resolution when usage recording fails', async () => {
    const cache = new FakeCache();
    const promptService = makePromptService({
      incrementPromptGroupUsage: jest.fn().mockRejectedValue(new Error('usage boom')),
    });
    const logger = makeLogger();
    const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

    const result = await resolver({ link: productionLink, recordUsage: true });
    await flush();

    expect(result.status).toBe('resolved');
    expect(logger.warn).toHaveBeenCalledWith(
      '[linkedInstructions] Failed to record prompt group usage',
      expect.objectContaining({ groupId, errorName: 'Error' }),
    );
  });

  it('never logs prompt text', async () => {
    const secretMarker = 'DO-NOT-LOG-THIS-PROMPT-BODY';
    const cache = new FakeCache();
    const promptService = makePromptService({
      resolvePrompt: jest.fn().mockResolvedValue({
        ok: true,
        value: makeResolvedPrompt({ prompt: secretMarker }),
      }),
      incrementPromptGroupUsage: jest.fn().mockRejectedValue(new Error(secretMarker)),
    });
    const logger = makeLogger();
    const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

    await resolver({ link: productionLink, recordUsage: true });
    await flush();

    const allLogCalls = [...logger.warn.mock.calls, ...logger.error.mock.calls];
    for (const call of allLogCalls) {
      expect(JSON.stringify(call)).not.toContain(secretMarker);
    }
  });
});
