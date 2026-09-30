import { InstructionsPromptErrorCode, PermissionBits, ResourceType } from 'librechat-data-provider';
import type {
  FiltersConfig,
  AgentInstructionsPrompt,
  RestrictedAgentInstructionsPrompt,
} from 'librechat-data-provider';
import type { PromptService } from '~/prompts';
import { isContentFilterError } from '~/middleware/contentFilter';

/** The write-path identity a link permission check runs as. */
export interface InstructionsPromptAccessUser {
  readonly id: string;
  readonly role: string;
}

/** Matches `PermissionService.getResourcePermissionsMap`, injected rather than imported. */
export type GetResourcePermissionsMap = (input: {
  userId: string;
  role: string;
  resourceType: ResourceType;
  resourceIds: string[];
}) => Promise<Map<string, number>>;

/** Matches `assertModelBoundContent({ filters, agents: [{ instructions }] })`, injected so
 *  this module never depends on the wider agent-content shape it inspects. Throws the same
 *  content-policy errors as the save-time and runtime checks on inline instructions. */
export type AssertAgentInstructionsContent = (input: {
  instructions: string;
  filters?: FiltersConfig;
}) => void;

export type InstructionsPromptWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 400 | 403; readonly code: InstructionsPromptErrorCode };

/** Any object carrying an agent's presented (possibly restricted) instructions-prompt link. */
export type AgentInstructionsPromptCarrier = {
  instructionsPrompt?: AgentInstructionsPrompt | RestrictedAgentInstructionsPrompt | null;
};

/** An agent (or update/revert response) carrying its own link plus version snapshots that
 *  each carry their own, independently-authorized link. */
export type AgentWithVersionsCarrier = AgentInstructionsPromptCarrier & {
  versions?: readonly AgentInstructionsPromptCarrier[];
};

export interface InstructionsPromptAccess {
  /** PROMPTGROUP `VIEW` bit test for `groupId` against the given identity. */
  canViewGroup(input: { userId: string; role: string; groupId: string }): Promise<boolean>;
  /**
   * Validates a create/update/revert write of `instructionsPrompt` against the stored
   * link. `next === undefined` means the field is absent from the payload (no change
   * requested). `requireResolvable: false` skips the `resolvePrompt` and content-policy
   * checks — a revert's snapshot selection is allowed to no longer resolve, because a
   * stale revision just continues the turn without instructions rather than failing.
   */
  validateLinkWrite(input: {
    user: InstructionsPromptAccessUser;
    previous: AgentInstructionsPrompt | null | undefined;
    next: AgentInstructionsPrompt | null | undefined;
    filters?: FiltersConfig;
    requireResolvable: boolean;
  }): Promise<InstructionsPromptWriteResult>;
  /** Replaces an inaccessible link — on the agent itself and inside every `versions[i]`
   *  snapshot — with a restricted stub before an EDIT-scoped response. Batches every
   *  distinct linked group into a single permission lookup. */
  presentForEditor<T extends AgentWithVersionsCarrier>(input: {
    user: InstructionsPromptAccessUser;
    agent: T;
  }): Promise<T>;
  /** Same redaction as `presentForEditor`, for a response that returns a version-history
   *  array directly (`GET /agents/:id/versions`) rather than a wrapping agent document. */
  presentVersionsForEditor<T extends AgentInstructionsPromptCarrier>(input: {
    user: InstructionsPromptAccessUser;
    versions: readonly T[];
  }): Promise<T[]>;
}

/** Structural equality for the small, plain-JSON link shape. `null` and `undefined` are equal. */
function isSameLink(
  a: AgentInstructionsPrompt | null | undefined,
  b: AgentInstructionsPrompt | null | undefined,
): boolean {
  const left = a ?? null;
  const right = b ?? null;
  if (left === right) {
    return true;
  }
  if (left == null || right == null) {
    return false;
  }
  if (left.source !== right.source || left.groupId !== right.groupId) {
    return false;
  }
  if (left.selection.type !== right.selection.type) {
    return false;
  }
  if (left.selection.type === 'exact' && right.selection.type === 'exact') {
    return left.selection.promptId === right.selection.promptId;
  }
  return true;
}

function isRestrictedStub(
  link: AgentInstructionsPrompt | RestrictedAgentInstructionsPrompt,
): link is RestrictedAgentInstructionsPrompt {
  return (link as RestrictedAgentInstructionsPrompt).restricted === true;
}

const RESTRICTED_STUB: RestrictedAgentInstructionsPrompt = { source: 'native', restricted: true };

/** Every distinct, non-restricted-stub `groupId` referenced by the given links. */
function collectLinkGroupIds(
  links: Iterable<AgentInstructionsPrompt | RestrictedAgentInstructionsPrompt | null | undefined>,
): string[] {
  const ids = new Set<string>();
  for (const link of links) {
    if (link != null && !isRestrictedStub(link)) {
      ids.add(link.groupId);
    }
  }
  return [...ids];
}

/**
 * Builds the permission checks that gate reading and writing an agent's linked
 * instructions prompt. Callers (the `/api` write and read handlers) own the HTTP
 * boundary; this module only decides ok/forbidden/restricted/unavailable and throws
 * on unexpected permission or prompt-service failures rather than swallowing them.
 */
export function createInstructionsPromptAccess(deps: {
  getResourcePermissionsMap: GetResourcePermissionsMap;
  promptService: Pick<PromptService, 'resolvePrompt'>;
  assertAgentInstructionsContent: AssertAgentInstructionsContent;
}): InstructionsPromptAccess {
  const { getResourcePermissionsMap, promptService, assertAgentInstructionsContent } = deps;

  async function canViewGroup({
    userId,
    role,
    groupId,
  }: {
    userId: string;
    role: string;
    groupId: string;
  }): Promise<boolean> {
    const permissionsMap = await getResourcePermissionsMap({
      userId,
      role,
      resourceType: ResourceType.PROMPTGROUP,
      resourceIds: [groupId],
    });
    const bits = permissionsMap.get(groupId) ?? 0;
    return (bits & PermissionBits.VIEW) === PermissionBits.VIEW;
  }

  /** One batched permission lookup for every distinct `groupId` among the given links. */
  async function buildVisibilityMap(
    user: InstructionsPromptAccessUser,
    groupIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (groupIds.length === 0) {
      return new Set();
    }
    const permissionsMap = await getResourcePermissionsMap({
      userId: user.id,
      role: user.role,
      resourceType: ResourceType.PROMPTGROUP,
      resourceIds: [...groupIds],
    });
    const visible = new Set<string>();
    for (const groupId of groupIds) {
      const bits = permissionsMap.get(groupId) ?? 0;
      if ((bits & PermissionBits.VIEW) === PermissionBits.VIEW) {
        visible.add(groupId);
      }
    }
    return visible;
  }

  function redactIfHidden<T extends AgentInstructionsPromptCarrier>(
    carrier: T,
    visibleGroupIds: ReadonlySet<string>,
  ): T {
    const link = carrier.instructionsPrompt;
    if (link == null || isRestrictedStub(link) || visibleGroupIds.has(link.groupId)) {
      return carrier;
    }
    return { ...carrier, instructionsPrompt: RESTRICTED_STUB };
  }

  async function validateLinkWrite({
    user,
    previous,
    next,
    filters,
    requireResolvable,
  }: {
    user: InstructionsPromptAccessUser;
    previous: AgentInstructionsPrompt | null | undefined;
    next: AgentInstructionsPrompt | null | undefined;
    filters?: FiltersConfig;
    requireResolvable: boolean;
  }): Promise<InstructionsPromptWriteResult> {
    if (next === undefined) {
      // Field absent from the payload: an unrelated edit keeps an inaccessible link.
      return { ok: true };
    }
    if (isSameLink(previous, next)) {
      // Re-selecting (or re-submitting the removal of) the unchanged value is always ok,
      // even when the editor cannot VIEW the group.
      return { ok: true };
    }
    if (previous != null) {
      const previousVisible = await canViewGroup({
        userId: user.id,
        role: user.role,
        groupId: previous.groupId,
      });
      if (!previousVisible) {
        return { ok: false, status: 403, code: InstructionsPromptErrorCode.RESTRICTED };
      }
    }
    if (next == null) {
      // Removing a link the editor could VIEW (or that never existed) is always allowed.
      return { ok: true };
    }
    const nextVisible = await canViewGroup({
      userId: user.id,
      role: user.role,
      groupId: next.groupId,
    });
    if (!nextVisible) {
      return { ok: false, status: 403, code: InstructionsPromptErrorCode.FORBIDDEN };
    }
    if (!requireResolvable) {
      // A revert's snapshot selection may no longer resolve; that is a runtime
      // continue-without-instructions case, not a rejected write. Access checks only.
      return { ok: true };
    }
    const resolved = await promptService.resolvePrompt({
      groupId: next.groupId,
      selection: next.selection,
      filters,
    });
    if (!resolved.ok) {
      return { ok: false, status: 400, code: InstructionsPromptErrorCode.UNAVAILABLE };
    }
    try {
      assertAgentInstructionsContent({ instructions: resolved.value.prompt, filters });
    } catch (error) {
      if (isContentFilterError(error)) {
        return { ok: false, status: 400, code: InstructionsPromptErrorCode.UNAVAILABLE };
      }
      throw error;
    }
    return { ok: true };
  }

  async function presentForEditor<T extends AgentWithVersionsCarrier>({
    user,
    agent,
  }: {
    user: InstructionsPromptAccessUser;
    agent: T;
  }): Promise<T> {
    const versions = agent.versions;
    const groupIds = collectLinkGroupIds([
      agent.instructionsPrompt,
      ...(versions ?? []).map((version) => version.instructionsPrompt),
    ]);
    if (groupIds.length === 0) {
      return agent;
    }
    const visible = await buildVisibilityMap(user, groupIds);
    const topLevelLink = agent.instructionsPrompt;
    const topLevelVisible =
      topLevelLink == null || isRestrictedStub(topLevelLink) || visible.has(topLevelLink.groupId);
    const versionsVisible =
      versions == null ||
      versions.every((version) => {
        const link = version.instructionsPrompt;
        return link == null || isRestrictedStub(link) || visible.has(link.groupId);
      });
    if (topLevelVisible && versionsVisible) {
      return agent;
    }
    return {
      ...agent,
      ...(topLevelVisible ? {} : { instructionsPrompt: RESTRICTED_STUB }),
      ...(versions == null
        ? {}
        : { versions: versions.map((version) => redactIfHidden(version, visible)) }),
    };
  }

  async function presentVersionsForEditor<T extends AgentInstructionsPromptCarrier>({
    user,
    versions,
  }: {
    user: InstructionsPromptAccessUser;
    versions: readonly T[];
  }): Promise<T[]> {
    const groupIds = collectLinkGroupIds(versions.map((version) => version.instructionsPrompt));
    if (groupIds.length === 0) {
      return versions as T[];
    }
    const visible = await buildVisibilityMap(user, groupIds);
    return versions.map((version) => redactIfHidden(version, visible));
  }

  return { canViewGroup, validateLinkWrite, presentForEditor, presentVersionsForEditor };
}
