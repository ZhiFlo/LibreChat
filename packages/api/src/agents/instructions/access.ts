import { InstructionsPromptErrorCode, PermissionBits, ResourceType } from 'librechat-data-provider';
import type {
  FiltersConfig,
  AgentInstructionsPrompt,
  RestrictedAgentInstructionsPrompt,
} from 'librechat-data-provider';
import type { PromptService } from '../../prompts';

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

export type InstructionsPromptWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 400 | 403; readonly code: InstructionsPromptErrorCode };

/** Any object carrying an agent's presented (possibly restricted) instructions-prompt link. */
export type AgentInstructionsPromptCarrier = {
  instructionsPrompt?: AgentInstructionsPrompt | RestrictedAgentInstructionsPrompt | null;
};

export interface InstructionsPromptAccess {
  /** PROMPTGROUP `VIEW` bit test for `groupId` against the given identity. */
  canViewGroup(input: { userId: string; role: string; groupId: string }): Promise<boolean>;
  /**
   * Validates a create/update write of `instructionsPrompt` against the stored link.
   * `next === undefined` means the field is absent from the payload (no change requested).
   */
  validateLinkWrite(input: {
    user: InstructionsPromptAccessUser;
    previous: AgentInstructionsPrompt | null | undefined;
    next: AgentInstructionsPrompt | null | undefined;
    filters?: FiltersConfig;
  }): Promise<InstructionsPromptWriteResult>;
  /** Replaces an inaccessible link with a restricted stub before an EDIT-scoped response. */
  presentForEditor<T extends AgentInstructionsPromptCarrier>(input: {
    user: InstructionsPromptAccessUser;
    agent: T;
  }): Promise<T>;
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

/**
 * Builds the permission checks that gate reading and writing an agent's linked
 * instructions prompt. Callers (the `/api` write and read handlers) own the HTTP
 * boundary; this module only decides ok/forbidden/restricted/unavailable and throws
 * on unexpected permission or prompt-service failures rather than swallowing them.
 */
export function createInstructionsPromptAccess(deps: {
  getResourcePermissionsMap: GetResourcePermissionsMap;
  promptService: Pick<PromptService, 'resolvePrompt'>;
}): InstructionsPromptAccess {
  const { getResourcePermissionsMap, promptService } = deps;

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

  async function validateLinkWrite({
    user,
    previous,
    next,
    filters,
  }: {
    user: InstructionsPromptAccessUser;
    previous: AgentInstructionsPrompt | null | undefined;
    next: AgentInstructionsPrompt | null | undefined;
    filters?: FiltersConfig;
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
    const resolved = await promptService.resolvePrompt({
      groupId: next.groupId,
      selection: next.selection,
      filters,
    });
    if (!resolved.ok) {
      return { ok: false, status: 400, code: InstructionsPromptErrorCode.UNAVAILABLE };
    }
    return { ok: true };
  }

  async function presentForEditor<T extends AgentInstructionsPromptCarrier>({
    user,
    agent,
  }: {
    user: InstructionsPromptAccessUser;
    agent: T;
  }): Promise<T> {
    const link = agent.instructionsPrompt;
    if (link == null || isRestrictedStub(link)) {
      return agent;
    }
    const visible = await canViewGroup({
      userId: user.id,
      role: user.role,
      groupId: link.groupId,
    });
    if (visible) {
      return agent;
    }
    const restricted: RestrictedAgentInstructionsPrompt = { source: 'native', restricted: true };
    return { ...agent, instructionsPrompt: restricted };
  }

  return { canViewGroup, validateLinkWrite, presentForEditor };
}
