import { InstructionsPromptErrorCode, PermissionBits, ResourceType } from 'librechat-data-provider';
import type { AgentInstructionsPrompt } from 'librechat-data-provider';
import { ContentTraversalLimitError } from '~/protection/adapters/nested';
import { createInstructionsPromptAccess } from './access';

const groupId = '507f1f77bcf86cd799439011';
const otherGroupId = '507f1f77bcf86cd799439022';
const thirdGroupId = '507f1f77bcf86cd799439033';
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

const thirdGroupLink: AgentInstructionsPrompt = {
  source: 'native',
  groupId: thirdGroupId,
  selection: { type: 'production' },
};

function buildAccess({
  visibleGroupIds = new Set<string>(),
  resolvePromptOk = true,
  getResourcePermissionsMap,
  resolvePrompt,
  assertAgentInstructionsContent,
}: {
  visibleGroupIds?: Set<string>;
  resolvePromptOk?: boolean;
  getResourcePermissionsMap?: jest.Mock;
  resolvePrompt?: jest.Mock;
  assertAgentInstructionsContent?: jest.Mock;
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
  const assertContent = assertAgentInstructionsContent ?? jest.fn();
  const access = createInstructionsPromptAccess({
    getResourcePermissionsMap: getResourcePermissionsMap ?? map,
    promptService: { resolvePrompt: resolvePrompt ?? resolve },
    assertAgentInstructionsContent: assertContent,
  });
  return {
    access,
    map: getResourcePermissionsMap ?? map,
    resolve: resolvePrompt ?? resolve,
    assertContent,
  };
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
        requireResolvable: true,
      });
      expect(result).toEqual({ ok: true });
    });

    it('is ok when there was no previous link and none is requested', async () => {
      const { access } = buildAccess();
      const result = await access.validateLinkWrite({
        user,
        previous: null,
        next: null,
        requireResolvable: true,
      });
      expect(result).toEqual({ ok: true });
    });

    it('rejects changing a link the editor cannot VIEW', async () => {
      const { access } = buildAccess({ visibleGroupIds: new Set([groupId]) });
      const result = await access.validateLinkWrite({
        user,
        previous: otherGroupLink,
        next: productionLink,
        requireResolvable: true,
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
        requireResolvable: true,
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
        requireResolvable: true,
      });
      expect(result).toEqual({ ok: true });
      expect(map).not.toHaveBeenCalled();
    });

    it('allows re-submitting the same removal (no previous, next null)', async () => {
      const { access, map } = buildAccess();
      const result = await access.validateLinkWrite({
        user,
        previous: undefined,
        next: null,
        requireResolvable: true,
      });
      expect(result).toEqual({ ok: true });
      expect(map).not.toHaveBeenCalled();
    });

    it('rejects a new link to a group the editor cannot VIEW (forbidden)', async () => {
      const { access } = buildAccess();
      const result = await access.validateLinkWrite({
        user,
        previous: null,
        next: productionLink,
        requireResolvable: true,
      });
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
      const result = await access.validateLinkWrite({
        user,
        previous: null,
        next: exactLink,
        requireResolvable: true,
      });
      expect(result).toEqual({
        ok: false,
        status: 400,
        code: InstructionsPromptErrorCode.UNAVAILABLE,
      });
    });

    it('accepts a viewable, resolvable new link (happy path)', async () => {
      const { access, resolve } = buildAccess({ visibleGroupIds: new Set([groupId]) });
      const result = await access.validateLinkWrite({
        user,
        previous: null,
        next: exactLink,
        requireResolvable: true,
      });
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
        requireResolvable: true,
      });
      expect(result).toEqual({ ok: true });
    });

    it('accepts removing a link the editor can VIEW', async () => {
      const { access } = buildAccess({ visibleGroupIds: new Set([groupId]) });
      const result = await access.validateLinkWrite({
        user,
        previous: productionLink,
        next: null,
        requireResolvable: true,
      });
      expect(result).toEqual({ ok: true });
    });

    it('forwards filters to resolvePrompt', async () => {
      const { access, resolve } = buildAccess({ visibleGroupIds: new Set([groupId]) });
      const filters = { pii: {} } as never;
      await access.validateLinkWrite({
        user,
        previous: null,
        next: productionLink,
        filters,
        requireResolvable: true,
      });
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
        access.validateLinkWrite({
          user,
          previous: null,
          next: productionLink,
          requireResolvable: true,
        }),
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
        access.validateLinkWrite({
          user,
          previous: null,
          next: productionLink,
          requireResolvable: true,
        }),
      ).rejects.toThrow('prompt store outage');
    });

    describe('requireResolvable: false (revert access checks only)', () => {
      it('rejects a new link to a group the editor cannot VIEW (forbidden), without resolving', async () => {
        const { access, resolve } = buildAccess();
        const result = await access.validateLinkWrite({
          user,
          previous: null,
          next: productionLink,
          requireResolvable: false,
        });
        expect(result).toEqual({
          ok: false,
          status: 403,
          code: InstructionsPromptErrorCode.FORBIDDEN,
        });
        expect(resolve).not.toHaveBeenCalled();
      });

      it('rejects removing/changing a link the editor cannot VIEW (restricted), without resolving', async () => {
        const { access, resolve } = buildAccess();
        const result = await access.validateLinkWrite({
          user,
          previous: otherGroupLink,
          next: null,
          requireResolvable: false,
        });
        expect(result).toEqual({
          ok: false,
          status: 403,
          code: InstructionsPromptErrorCode.RESTRICTED,
        });
        expect(resolve).not.toHaveBeenCalled();
      });

      it('accepts a viewable link even when it no longer resolves', async () => {
        const { access, resolve } = buildAccess({
          visibleGroupIds: new Set([groupId]),
          resolvePromptOk: false,
        });
        const result = await access.validateLinkWrite({
          user,
          previous: null,
          next: exactLink,
          requireResolvable: false,
        });
        expect(result).toEqual({ ok: true });
        expect(resolve).not.toHaveBeenCalled();
      });

      it('accepts when the next link equals the previous link', async () => {
        const { access, map } = buildAccess();
        const result = await access.validateLinkWrite({
          user,
          previous: otherGroupLink,
          next: { ...otherGroupLink },
          requireResolvable: false,
        });
        expect(result).toEqual({ ok: true });
        expect(map).not.toHaveBeenCalled();
      });
    });

    describe('content-policy check after a successful resolve', () => {
      it('rejects a resolvable link whose content the agent-instructions policy blocks', async () => {
        const { access, assertContent } = buildAccess({ visibleGroupIds: new Set([groupId]) });
        assertContent.mockImplementation(() => {
          throw new ContentTraversalLimitError();
        });
        const result = await access.validateLinkWrite({
          user,
          previous: null,
          next: productionLink,
          requireResolvable: true,
        });
        expect(result).toEqual({
          ok: false,
          status: 400,
          code: InstructionsPromptErrorCode.UNAVAILABLE,
        });
        expect(assertContent).toHaveBeenCalledWith({ instructions: 'hi', filters: undefined });
      });

      it('forwards filters to the content-policy check', async () => {
        const { access, assertContent } = buildAccess({ visibleGroupIds: new Set([groupId]) });
        const filters = { agentInstructions: { pii: { types: ['EMAIL'] } } } as never;
        await access.validateLinkWrite({
          user,
          previous: null,
          next: productionLink,
          filters,
          requireResolvable: true,
        });
        expect(assertContent).toHaveBeenCalledWith({ instructions: 'hi', filters });
      });

      it('does not run the content-policy check when requireResolvable is false', async () => {
        const { access, assertContent } = buildAccess({ visibleGroupIds: new Set([groupId]) });
        await access.validateLinkWrite({
          user,
          previous: null,
          next: productionLink,
          requireResolvable: false,
        });
        expect(assertContent).not.toHaveBeenCalled();
      });

      it('propagates an assertion error the content-filter helper does not recognize', async () => {
        const { access, assertContent } = buildAccess({ visibleGroupIds: new Set([groupId]) });
        assertContent.mockImplementation(() => {
          throw new Error('unexpected');
        });
        await expect(
          access.validateLinkWrite({
            user,
            previous: null,
            next: productionLink,
            requireResolvable: true,
          }),
        ).rejects.toThrow('unexpected');
      });
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

    describe('versions[] redaction', () => {
      it('leaves an agent with no links (top-level or versioned) untouched', async () => {
        const { access, map } = buildAccess();
        const agent = {
          id: 'a1',
          instructionsPrompt: null,
          versions: [{ name: 'v1', instructionsPrompt: null }],
        };
        const result = await access.presentForEditor({ user, agent });
        expect(result).toBe(agent);
        expect(map).not.toHaveBeenCalled();
      });

      it('redacts an inaccessible link inside a version snapshot, leaving a visible top-level link intact', async () => {
        const { access } = buildAccess({ visibleGroupIds: new Set([groupId]) });
        const agent = {
          id: 'a1',
          instructionsPrompt: productionLink,
          versions: [
            { name: 'v1', instructionsPrompt: otherGroupLink },
            { name: 'v2', instructionsPrompt: productionLink },
          ],
        };
        const result = await access.presentForEditor({ user, agent });
        expect(result).toEqual({
          id: 'a1',
          instructionsPrompt: productionLink,
          versions: [
            { name: 'v1', instructionsPrompt: { source: 'native', restricted: true } },
            { name: 'v2', instructionsPrompt: productionLink },
          ],
        });
      });

      it('redacts the top-level link while leaving an accessible version snapshot intact', async () => {
        const { access } = buildAccess({ visibleGroupIds: new Set([groupId]) });
        const agent = {
          id: 'a1',
          instructionsPrompt: otherGroupLink,
          versions: [{ name: 'v1', instructionsPrompt: productionLink }],
        };
        const result = await access.presentForEditor({ user, agent });
        expect(result).toEqual({
          id: 'a1',
          instructionsPrompt: { source: 'native', restricted: true },
          versions: [{ name: 'v1', instructionsPrompt: productionLink }],
        });
      });

      it('leaves an already-restricted version snapshot untouched', async () => {
        const { access } = buildAccess({ visibleGroupIds: new Set([groupId]) });
        const agent = {
          id: 'a1',
          instructionsPrompt: productionLink,
          versions: [
            {
              name: 'v1',
              instructionsPrompt: { source: 'native' as const, restricted: true as const },
            },
          ],
        };
        const result = await access.presentForEditor({ user, agent });
        expect(result).toBe(agent);
      });

      it('batches every distinct groupId (top-level and versioned) into one permission lookup', async () => {
        const { access, map } = buildAccess({ visibleGroupIds: new Set([groupId]) });
        const agent = {
          id: 'a1',
          instructionsPrompt: productionLink,
          versions: [
            { name: 'v1', instructionsPrompt: otherGroupLink },
            { name: 'v2', instructionsPrompt: thirdGroupLink },
            { name: 'v3', instructionsPrompt: otherGroupLink },
          ],
        };
        await access.presentForEditor({ user, agent });
        expect(map).toHaveBeenCalledTimes(1);
        const [{ resourceIds }] = map.mock.calls[0];
        expect(new Set(resourceIds)).toEqual(new Set([groupId, otherGroupId, thirdGroupId]));
      });
    });
  });

  describe('presentVersionsForEditor', () => {
    it('returns the versions unchanged when none carry a link', async () => {
      const { access, map } = buildAccess();
      const versions = [{ name: 'v1', instructionsPrompt: null }, { name: 'v2' }];
      const result = await access.presentVersionsForEditor({ user, versions });
      expect(result).toEqual(versions);
      expect(map).not.toHaveBeenCalled();
    });

    it('redacts only the snapshots whose link the editor cannot VIEW', async () => {
      const { access, map } = buildAccess({ visibleGroupIds: new Set([groupId]) });
      const versions = [
        { name: 'v1', instructionsPrompt: productionLink },
        { name: 'v2', instructionsPrompt: otherGroupLink },
      ];
      const result = await access.presentVersionsForEditor({ user, versions });
      expect(result).toEqual([
        { name: 'v1', instructionsPrompt: productionLink },
        { name: 'v2', instructionsPrompt: { source: 'native', restricted: true } },
      ]);
      expect(map).toHaveBeenCalledTimes(1);
    });

    it('leaves an already-restricted snapshot untouched', async () => {
      const { access } = buildAccess();
      const versions = [
        {
          name: 'v1',
          instructionsPrompt: { source: 'native' as const, restricted: true as const },
        },
      ];
      const result = await access.presentVersionsForEditor({ user, versions });
      expect(result[0]).toBe(versions[0]);
    });

    it('propagates a thrown permission-service error', async () => {
      const { access } = buildAccess({
        getResourcePermissionsMap: jest.fn(async () => {
          throw new Error('acl outage');
        }),
      });
      const versions = [{ name: 'v1', instructionsPrompt: otherGroupLink }];
      await expect(access.presentVersionsForEditor({ user, versions })).rejects.toThrow(
        'acl outage',
      );
    });
  });
});
