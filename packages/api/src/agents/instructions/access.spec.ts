import { InstructionsPromptErrorCode, PermissionBits, ResourceType } from 'librechat-data-provider';
import type { AgentInstructionsPrompt } from 'librechat-data-provider';
import { createInstructionsPromptAccess } from './access';

const groupId = '507f1f77bcf86cd799439011';
const otherGroupId = '507f1f77bcf86cd799439022';
const promptId = '507f191e810c19729de860ea';

const user = { id: 'user-1', role: 'USER' };

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

const otherGroupLink: AgentInstructionsPrompt = {
  source: 'native',
  groupId: otherGroupId,
  selection: { type: 'production' },
};

function buildAccess({
  visibleGroupIds = new Set<string>(),
  resolvePromptOk = true,
  getResourcePermissionsMap,
  resolvePrompt,
}: {
  visibleGroupIds?: Set<string>;
  resolvePromptOk?: boolean;
  getResourcePermissionsMap?: jest.Mock;
  resolvePrompt?: jest.Mock;
} = {}) {
  const map = jest.fn(async ({ resourceIds }: { resourceIds: string[] }) => {
    const result = new Map<string, number>();
    for (const id of resourceIds) {
      if (visibleGroupIds.has(id)) {
        result.set(id, PermissionBits.VIEW);
      }
    }
    return result;
  });
  const resolve = jest.fn(async () =>
    resolvePromptOk
      ? { ok: true as const, value: { groupId, promptId, prompt: 'hi', type: 'text' as const } }
      : {
          ok: false as const,
          error: { type: 'unavailable_selection' as const, reason: 'production' as const },
        },
  );
  const access = createInstructionsPromptAccess({
    getResourcePermissionsMap: getResourcePermissionsMap ?? map,
    promptService: { resolvePrompt: resolvePrompt ?? resolve },
  });
  return { access, map: getResourcePermissionsMap ?? map, resolve: resolvePrompt ?? resolve };
}

describe('createInstructionsPromptAccess', () => {
  describe('canViewGroup', () => {
    it('returns true when the VIEW bit is set', async () => {
      const { access } = buildAccess({ visibleGroupIds: new Set([groupId]) });
      await expect(
        access.canViewGroup({ userId: user.id, role: user.role, groupId }),
      ).resolves.toBe(true);
    });

    it('returns false when the bit map has no entry for the group', async () => {
      const { access } = buildAccess();
      await expect(
        access.canViewGroup({ userId: user.id, role: user.role, groupId }),
      ).resolves.toBe(false);
    });

    it('returns false when other bits are set but not VIEW', async () => {
      const { access } = buildAccess({
        getResourcePermissionsMap: jest.fn(async () => new Map([[groupId, PermissionBits.EDIT]])),
      });
      await expect(
        access.canViewGroup({ userId: user.id, role: user.role, groupId }),
      ).resolves.toBe(false);
    });

    it('queries PROMPTGROUP resources', async () => {
      const { access, map } = buildAccess({ visibleGroupIds: new Set([groupId]) });
      await access.canViewGroup({ userId: user.id, role: user.role, groupId });
      expect(map).toHaveBeenCalledWith({
        userId: user.id,
        role: user.role,
        resourceType: ResourceType.PROMPTGROUP,
        resourceIds: [groupId],
      });
    });

    it('propagates a thrown permission-service error', async () => {
      const { access } = buildAccess({
        getResourcePermissionsMap: jest.fn(async () => {
          throw new Error('db down');
        }),
      });
      await expect(
        access.canViewGroup({ userId: user.id, role: user.role, groupId }),
      ).rejects.toThrow('db down');
    });
  });

  describe('validateLinkWrite', () => {
    it('is ok when the field is absent (no change)', async () => {
      const { access } = buildAccess();
      const result = await access.validateLinkWrite({
        user,
        previous: otherGroupLink,
        next: undefined,
      });
      expect(result).toEqual({ ok: true });
    });

    it('is ok when there was no previous link and none is requested', async () => {
      const { access } = buildAccess();
      const result = await access.validateLinkWrite({ user, previous: null, next: null });
      expect(result).toEqual({ ok: true });
    });

    it('rejects changing a link the editor cannot VIEW', async () => {
      const { access } = buildAccess({ visibleGroupIds: new Set([groupId]) });
      const result = await access.validateLinkWrite({
        user,
        previous: otherGroupLink,
        next: productionLink,
      });
      expect(result).toEqual({
        ok: false,
        status: 403,
        code: InstructionsPromptErrorCode.RESTRICTED,
      });
    });

    it('rejects removing a link the editor cannot VIEW', async () => {
      const { access } = buildAccess();
      const result = await access.validateLinkWrite({
        user,
        previous: otherGroupLink,
        next: null,
      });
      expect(result).toEqual({
        ok: false,
        status: 403,
        code: InstructionsPromptErrorCode.RESTRICTED,
      });
    });

    it('allows re-selecting the same value even when the group is inaccessible', async () => {
      const { access, map } = buildAccess();
      const result = await access.validateLinkWrite({
        user,
        previous: otherGroupLink,
        next: { ...otherGroupLink },
      });
      expect(result).toEqual({ ok: true });
      expect(map).not.toHaveBeenCalled();
    });

    it('allows re-submitting the same removal (no previous, next null)', async () => {
      const { access, map } = buildAccess();
      const result = await access.validateLinkWrite({ user, previous: undefined, next: null });
      expect(result).toEqual({ ok: true });
      expect(map).not.toHaveBeenCalled();
    });

    it('rejects a new link to a group the editor cannot VIEW (forbidden)', async () => {
      const { access } = buildAccess();
      const result = await access.validateLinkWrite({ user, previous: null, next: productionLink });
      expect(result).toEqual({
        ok: false,
        status: 403,
        code: InstructionsPromptErrorCode.FORBIDDEN,
      });
    });

    it('rejects a selection that does not resolve (unavailable)', async () => {
      const { access } = buildAccess({
        visibleGroupIds: new Set([groupId]),
        resolvePromptOk: false,
      });
      const result = await access.validateLinkWrite({ user, previous: null, next: exactLink });
      expect(result).toEqual({
        ok: false,
        status: 400,
        code: InstructionsPromptErrorCode.UNAVAILABLE,
      });
    });

    it('accepts a viewable, resolvable new link (happy path)', async () => {
      const { access, resolve } = buildAccess({ visibleGroupIds: new Set([groupId]) });
      const result = await access.validateLinkWrite({ user, previous: null, next: exactLink });
      expect(result).toEqual({ ok: true });
      expect(resolve).toHaveBeenCalledWith({
        groupId,
        selection: exactLink.selection,
        filters: undefined,
      });
    });

    it('accepts changing between two viewable, resolvable links', async () => {
      const { access } = buildAccess({ visibleGroupIds: new Set([groupId]) });
      const result = await access.validateLinkWrite({
        user,
        previous: productionLink,
        next: exactLink,
      });
      expect(result).toEqual({ ok: true });
    });

    it('accepts removing a link the editor can VIEW', async () => {
      const { access } = buildAccess({ visibleGroupIds: new Set([groupId]) });
      const result = await access.validateLinkWrite({ user, previous: productionLink, next: null });
      expect(result).toEqual({ ok: true });
    });

    it('forwards filters to resolvePrompt', async () => {
      const { access, resolve } = buildAccess({ visibleGroupIds: new Set([groupId]) });
      const filters = { pii: {} } as never;
      await access.validateLinkWrite({ user, previous: null, next: productionLink, filters });
      expect(resolve).toHaveBeenCalledWith({
        groupId,
        selection: productionLink.selection,
        filters,
      });
    });

    it('propagates a thrown permission-service error', async () => {
      const { access } = buildAccess({
        getResourcePermissionsMap: jest.fn(async () => {
          throw new Error('acl outage');
        }),
      });
      await expect(
        access.validateLinkWrite({ user, previous: null, next: productionLink }),
      ).rejects.toThrow('acl outage');
    });

    it('propagates a thrown prompt-service error', async () => {
      const { access } = buildAccess({
        visibleGroupIds: new Set([groupId]),
        resolvePrompt: jest.fn(async () => {
          throw new Error('prompt store outage');
        }),
      });
      await expect(
        access.validateLinkWrite({ user, previous: null, next: productionLink }),
      ).rejects.toThrow('prompt store outage');
    });
  });

  describe('presentForEditor', () => {
    it('leaves the agent untouched when there is no link', async () => {
      const { access } = buildAccess();
      const agent = { id: 'a1', instructionsPrompt: null };
      await expect(access.presentForEditor({ user, agent })).resolves.toBe(agent);
    });

    it('leaves a visible link untouched', async () => {
      const { access } = buildAccess({ visibleGroupIds: new Set([groupId]) });
      const agent = { id: 'a1', instructionsPrompt: productionLink };
      await expect(access.presentForEditor({ user, agent })).resolves.toBe(agent);
    });

    it('replaces an inaccessible link with a restricted stub', async () => {
      const { access } = buildAccess();
      const agent = { id: 'a1', name: 'Agent', instructionsPrompt: otherGroupLink };
      const result = await access.presentForEditor({ user, agent });
      expect(result).toEqual({
        id: 'a1',
        name: 'Agent',
        instructionsPrompt: { source: 'native', restricted: true },
      });
    });

    it('is idempotent on an already-restricted stub', async () => {
      const { access, map } = buildAccess();
      const agent = {
        id: 'a1',
        instructionsPrompt: { source: 'native' as const, restricted: true as const },
      };
      const result = await access.presentForEditor({ user, agent });
      expect(result).toBe(agent);
      expect(map).not.toHaveBeenCalled();
    });

    it('propagates a thrown permission-service error', async () => {
      const { access } = buildAccess({
        getResourcePermissionsMap: jest.fn(async () => {
          throw new Error('acl outage');
        }),
      });
      const agent = { id: 'a1', instructionsPrompt: otherGroupLink };
      await expect(access.presentForEditor({ user, agent })).rejects.toThrow('acl outage');
    });
  });
});
