import { InstructionsPromptErrorCode, PermissionBits, ResourceType } from 'librechat-data-provider';
import type {
  FiltersConfig,
  AgentInstructionsPrompt,
  RestrictedAgentInstructionsPrompt,
} from 'librechat-data-provider';
import type { PromptService } from '~/prompts';
import { isContentFilterError } from '~/middleware/contentFilter';
import { getSafeErrorMetadata } from '~/utils/errors';

/** Matches the `logger` shape injected elsewhere in this module family
 *  (`createLinkedInstructionsResolver`). */
export interface InstructionsPromptAccessLogger {
  warn(message: string, meta?: object): void;
  error(message: string, meta?: object): void;
}

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
   *
   * A linked group that no longer exists imposes no restriction: when `previous`
   * points to a deleted group (so its ACL is gone and the editor can no longer VIEW
   * it), the write proceeds as if there were no previous link — the editor may remove
   * the link, replace it with one they can VIEW, or revert. Group existence is never
   * revealed through a *new* link, though: a `next` group the editor cannot VIEW is
   * still `FORBIDDEN` whether or not it exists, unless `requireResolvable` is false
   * (a revert), in which case reverting onto a link whose group no longer exists is
   * allowed — the runtime simply continues without instructions.
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
   *  distinct linked group into a single permission lookup. A link to a group that no
   *  longer exists is shown as-is instead: there is no group identity left to protect,
   *  and showing it (rather than a stub) is what lets the Builder offer the editor a
   *  removal or replacement for it.
   *
   *  Fails closed: this runs after the write it is presenting has already been
   *  persisted, so an ACL-lookup or `getPromptGroup` failure here must never
   *  surface as a 500 (a client retry on that 500 would create another
   *  duplicate/etc. against the write that already succeeded). On such a
   *  failure this logs a safe message and returns every link — top-level and
   *  every version snapshot — as the restricted stub instead of throwing. */
  presentForEditor<T extends AgentWithVersionsCarrier>(input: {
    user: InstructionsPromptAccessUser;
    agent: T;
  }): Promise<T>;
  /** Same redaction as `presentForEditor`, including the same fail-closed behavior,
   *  for a response that returns a version-history array directly
   *  (`GET /agents/:id/versions`) rather than a wrapping agent document. */
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
 * boundary; this module only decides ok/forbidden/restricted/unavailable.
 * `validateLinkWrite` throws on an unexpected permission or prompt-service
 * failure rather than swallowing it — that check runs before the write lands,
 * so a 500 there is safe. `presentForEditor` and `presentVersionsForEditor`
 * run after the write has already been persisted and fail closed instead: see
 * their own docs below.
 */
export function createInstructionsPromptAccess(deps: {
  getResourcePermissionsMap: GetResourcePermissionsMap;
  promptService: Pick<PromptService, 'resolvePrompt' | 'getPromptGroup'>;
  assertAgentInstructionsContent: AssertAgentInstructionsContent;
  logger: InstructionsPromptAccessLogger;
}): InstructionsPromptAccess {
  const { getResourcePermissionsMap, promptService, assertAgentInstructionsContent, logger } = deps;

  /** Whether `groupId` still has a stored group record — a tenant-scoped, ACL-free
   *  read, unlike `canViewGroup`. `deletePromptGroup` removes every ACL entry for a
   *  group, so "not visible" alone can never distinguish a real restriction from a
   *  group that simply no longer exists; this is what tells the two apart. */
  async function groupExists(groupId: string): Promise<boolean> {
    const result = await promptService.getPromptGroup({ groupId });
    return result != null;
  }

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

  /**
   * One batched permission lookup for every distinct `groupId` among the given links,
   * followed by an existence check for only the not-visible ones. Returns the subset
   * that must be redacted before an EDIT-scoped response — a group the editor cannot
   * VIEW *and* that still exists. A link to a deleted group is never redacted: there
   * is no group identity left to protect, and showing it as-is is what lets the
   * Builder offer the editor a removal or replacement for it.
   */
  async function buildRedactionSet(
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
    const notVisible = groupIds.filter((groupId) => {
      const bits = permissionsMap.get(groupId) ?? 0;
      return (bits & PermissionBits.VIEW) !== PermissionBits.VIEW;
    });
    if (notVisible.length === 0) {
      return new Set();
    }
    const existence = await Promise.all(notVisible.map((groupId) => groupExists(groupId)));
    const redact = new Set<string>();
    notVisible.forEach((groupId, index) => {
      if (existence[index]) {
        redact.add(groupId);
      }
    });
    return redact;
  }

  function redactIfHidden<T extends AgentInstructionsPromptCarrier>(
    carrier: T,
    redactGroupIds: ReadonlySet<string>,
  ): T {
    const link = carrier.instructionsPrompt;
    if (link == null || isRestrictedStub(link) || !redactGroupIds.has(link.groupId)) {
      return carrier;
    }
    return { ...carrier, instructionsPrompt: RESTRICTED_STUB };
  }

  /** Unconditional stub, used only on the fail-closed path below: every link is
   *  hidden because whether it may be shown could not be determined. */
  function stubLink<T extends AgentInstructionsPromptCarrier>(carrier: T): T {
    return carrier.instructionsPrompt == null
      ? carrier
      : { ...carrier, instructionsPrompt: RESTRICTED_STUB };
  }

  /** Content-free failure log shared by every fail-closed path below. */
  function logAuthorizationFailure(error: unknown): void {
    logger.error(
      '[createInstructionsPromptAccess] Failed to authorize a linked instructions prompt for an EDIT-scoped response; presenting every link as restricted',
      getSafeErrorMetadata(error),
    );
  }

  /** Logs and reports back with no group identity — every top-level and
   *  versioned link on `agent` becomes the restricted stub. */
  function failClosed<T extends AgentWithVersionsCarrier>(error: unknown, agent: T): T {
    logAuthorizationFailure(error);
    const versions = agent.versions;
    return {
      ...stubLink(agent),
      ...(versions == null ? {} : { versions: versions.map((version) => stubLink(version)) }),
    };
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
      if (!previousVisible && (await groupExists(previous.groupId))) {
        return { ok: false, status: 403, code: InstructionsPromptErrorCode.RESTRICTED };
      }
      // Either visible, or a deleted group: it imposes no restriction on `next`.
    }
    if (next == null) {
      // Removing a link the editor could VIEW (or that never existed, or no longer
      // exists) is always allowed.
      return { ok: true };
    }
    const nextVisible = await canViewGroup({
      userId: user.id,
      role: user.role,
      groupId: next.groupId,
    });
    if (!nextVisible) {
      // A revert may land on a link whose group has since been deleted — allowed,
      // since the runtime just continues without instructions. A *new* link (any
      // other write) stays FORBIDDEN regardless of existence, so group existence is
      // never revealed through it.
      if (!requireResolvable && !(await groupExists(next.groupId))) {
        return { ok: true };
      }
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
    let redact: ReadonlySet<string>;
    try {
      redact = await buildRedactionSet(user, groupIds);
    } catch (error) {
      return failClosed(error, agent);
    }
    const topLevelLink = agent.instructionsPrompt;
    const topLevelRedacted =
      topLevelLink != null && !isRestrictedStub(topLevelLink) && redact.has(topLevelLink.groupId);
    const versionsUnchanged =
      versions == null ||
      versions.every((version) => {
        const link = version.instructionsPrompt;
        return link == null || isRestrictedStub(link) || !redact.has(link.groupId);
      });
    if (!topLevelRedacted && versionsUnchanged) {
      return agent;
    }
    return {
      ...agent,
      ...(topLevelRedacted ? { instructionsPrompt: RESTRICTED_STUB } : {}),
      ...(versions == null
        ? {}
        : { versions: versions.map((version) => redactIfHidden(version, redact)) }),
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
    let redact: ReadonlySet<string>;
    try {
      redact = await buildRedactionSet(user, groupIds);
    } catch (error) {
      logAuthorizationFailure(error);
      return versions.map((version) => stubLink(version));
    }
    return versions.map((version) => redactIfHidden(version, redact));
  }

  return { canViewGroup, validateLinkWrite, presentForEditor, presentVersionsForEditor };
}
