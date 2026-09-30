import { InstructionsPromptErrorCode } from 'librechat-data-provider';
import type { AgentInstructionsPrompt } from 'librechat-data-provider';
import {
  checkInstructionsPromptWrite,
  applyInstructionsPromptUnset,
  effectiveInstructionsPromptLink,
  excludeInstructionsWhenLinked,
} from './writes';

const groupId = '507f1f77bcf86cd799439011';
const otherGroupId = '507f1f77bcf86cd799439022';

const user = { id: 'user-1', role: 'USER' };

const link: AgentInstructionsPrompt = {
  source: 'native',
  groupId,
  selection: { type: 'production' },
};

const otherLink: AgentInstructionsPrompt = {
  source: 'native',
  groupId: otherGroupId,
  selection: { type: 'production' },
};

const restrictedStub = { source: 'native' as const, restricted: true as const };

describe('checkInstructionsPromptWrite', () => {
  it('returns null without calling access when the field is absent', async () => {
    const validateLinkWrite = jest.fn();
    const result = await checkInstructionsPromptWrite({
      access: { validateLinkWrite },
      operation: 'update',
      user,
      previous: link,
      next: undefined,
    });
    expect(result).toBeNull();
    expect(validateLinkWrite).not.toHaveBeenCalled();
  });

  it('requires the selection to resolve on create', async () => {
    const validateLinkWrite = jest.fn(async () => ({ ok: true as const }));
    await checkInstructionsPromptWrite({
      access: { validateLinkWrite },
      operation: 'create',
      user,
      previous: undefined,
      next: link,
    });
    expect(validateLinkWrite).toHaveBeenCalledWith(
      expect.objectContaining({ requireResolvable: true, previous: null, next: link }),
    );
  });

  it('requires the selection to resolve on update', async () => {
    const validateLinkWrite = jest.fn(async () => ({ ok: true as const }));
    await checkInstructionsPromptWrite({
      access: { validateLinkWrite },
      operation: 'update',
      user,
      previous: otherLink,
      next: link,
    });
    expect(validateLinkWrite).toHaveBeenCalledWith(
      expect.objectContaining({ requireResolvable: true, previous: otherLink, next: link }),
    );
  });

  it('does not require the selection to resolve on revert', async () => {
    const validateLinkWrite = jest.fn(async () => ({ ok: true as const }));
    await checkInstructionsPromptWrite({
      access: { validateLinkWrite },
      operation: 'revert',
      user,
      previous: otherLink,
      next: link,
    });
    expect(validateLinkWrite).toHaveBeenCalledWith(
      expect.objectContaining({ requireResolvable: false }),
    );
  });

  it('maps a rejection to the HTTP-shaped error response', async () => {
    const validateLinkWrite = jest.fn(async () => ({
      ok: false as const,
      status: 403 as const,
      code: InstructionsPromptErrorCode.FORBIDDEN,
    }));
    const result = await checkInstructionsPromptWrite({
      access: { validateLinkWrite },
      operation: 'create',
      user,
      previous: undefined,
      next: link,
    });
    expect(result).toEqual({
      status: 403,
      body: { error: expect.any(String), code: InstructionsPromptErrorCode.FORBIDDEN },
    });
  });

  it('forwards filters', async () => {
    const validateLinkWrite = jest.fn(async () => ({ ok: true as const }));
    const filters = { pii: {} } as never;
    await checkInstructionsPromptWrite({
      access: { validateLinkWrite },
      operation: 'create',
      user,
      previous: undefined,
      next: link,
      filters,
    });
    expect(validateLinkWrite).toHaveBeenCalledWith(expect.objectContaining({ filters }));
  });
});

describe('applyInstructionsPromptUnset', () => {
  it('leaves the update untouched when the field is a link', () => {
    const updateData = { name: 'Agent', instructionsPrompt: link };
    expect(applyInstructionsPromptUnset(updateData)).toBe(updateData);
  });

  it('leaves the update untouched when the field is absent', () => {
    const updateData = { name: 'Agent' };
    expect(applyInstructionsPromptUnset(updateData)).toBe(updateData);
  });

  it('converts an explicit null into $unset and drops the field', () => {
    const updateData = { name: 'Agent', instructionsPrompt: null as null };
    const result = applyInstructionsPromptUnset(updateData);
    expect(result).toEqual({ name: 'Agent', $unset: { instructionsPrompt: 1 } });
    expect(result).not.toHaveProperty('instructionsPrompt');
  });

  it('merges with an existing $unset rather than replacing it', () => {
    const updateData = {
      name: 'Agent',
      instructionsPrompt: null as null,
      $unset: { git_identity: 1 },
    };
    const result = applyInstructionsPromptUnset(updateData);
    expect(result).toEqual({
      name: 'Agent',
      $unset: { git_identity: 1, instructionsPrompt: 1 },
    });
  });
});

describe('effectiveInstructionsPromptLink', () => {
  it('uses next when the payload carries the field', () => {
    expect(effectiveInstructionsPromptLink(link, otherLink)).toBe(link);
  });

  it('uses next when it is an explicit removal, even with a stored previous', () => {
    expect(effectiveInstructionsPromptLink(null, otherLink)).toBeNull();
  });

  it('falls back to previous when the field is absent from the payload', () => {
    expect(effectiveInstructionsPromptLink(undefined, otherLink)).toBe(otherLink);
  });

  it('is undefined when neither is set (create with no stored link)', () => {
    expect(effectiveInstructionsPromptLink(undefined, undefined)).toBeUndefined();
  });
});

describe('excludeInstructionsWhenLinked', () => {
  it('excludes instructions when the effective link is a real link', () => {
    const data = { instructions: 'blocked text', name: 'Agent' };
    const result = excludeInstructionsWhenLinked(data, link);
    expect(result).toEqual({ instructions: undefined, name: 'Agent' });
  });

  it('leaves instructions untouched when there is no effective link', () => {
    const data = { instructions: 'inline text', name: 'Agent' };
    expect(excludeInstructionsWhenLinked(data, null)).toBe(data);
    expect(excludeInstructionsWhenLinked(data, undefined)).toBe(data);
  });

  it('leaves instructions untouched for a restricted stub (never valid on its own)', () => {
    const data = { instructions: 'inline text' };
    expect(excludeInstructionsWhenLinked(data, restrictedStub)).toBe(data);
  });
});
