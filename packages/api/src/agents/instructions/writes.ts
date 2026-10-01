import { InstructionsPromptErrorCode } from 'librechat-data-provider';
import type {
  FiltersConfig,
  AgentInstructionsPrompt,
  RestrictedAgentInstructionsPrompt,
} from 'librechat-data-provider';
import type {
  InstructionsPromptAccess,
  InstructionsPromptAccessUser,
  InstructionsPromptAccessLogger,
  InstructionsPromptAccessRequest,
} from './access';
import type { InstructionsPromptLinkErrorResponse } from './errors';
import { getInstructionsPromptLinkError, buildInstructionsPromptError } from './errors';
import { isContentFilterError } from '~/middleware/contentFilter';
import { isValidInstructionsPromptLink } from './linked';
import { getSafeErrorMetadata } from '~/utils/errors';

export type InstructionsPromptWriteOperation = 'create' | 'update' | 'revert' | 'duplicate';

/**
 * Returned whenever the role, ACL, or prompt-store lookup backing a write check throws
 * unexpectedly (never for a recognized content-policy rejection, which `validateLinkWrite`
 * already turns into its own `ok: false` result). One fixed, pre-built response — no
 * detail about the failure is disclosed, and the caller logs the real cause separately
 * via `getSafeErrorMetadata`.
 */
const VALIDATION_FAILED_ERROR = buildInstructionsPromptError(
  500,
  InstructionsPromptErrorCode.VALIDATION_FAILED,
);

/**
 * Validates one create/update/revert/duplicate write of `instructionsPrompt`, owning
 * every branch the write handler would otherwise carry: whether the field changed at
 * all (`next === undefined` short-circuits before any permission or prompt lookup),
 * and whether the operation requires the selection to still resolve (every operation
 * except `revert` — a stale snapshot continues the turn without instructions rather
 * than failing the write). Returns `null` when the write may proceed; the caller only
 * needs to map a non-null result to its HTTP response.
 *
 * `'duplicate'` takes a narrower path than the rest: a duplicate copies the source
 * agent's link verbatim (an editor who can duplicate can already run the original,
 * which uses the same link), so this never checks PROMPTGROUP VIEW on `next` or
 * whether it still resolves. It only requires the duplicator's own role to grant
 * PROMPTS USE — `access.canUsePrompts` — before they may own a newly linked agent,
 * and only when a link is actually being copied (`next != null`).
 *
 * Every branch runs inside one try/catch: an unexpected throw from the role, ACL, or
 * prompt-store lookups behind either path is logged here with `getSafeErrorMetadata`
 * and mapped to `VALIDATION_FAILED_ERROR` instead of reaching the caller, where it
 * would otherwise surface as a raw `error.message` on the handler's catch-all. A
 * recognized content-policy error is rethrown unchanged — `validateLinkWrite` already
 * maps that case to its own `ok: false` result, so one reaching here would be an
 * unrecognized caller bug, not a failure this function should mask.
 */
export async function checkInstructionsPromptWrite({
  access,
  operation,
  user,
  previous,
  next,
  filters,
  logger,
  req,
}: {
  access: Pick<InstructionsPromptAccess, 'validateLinkWrite' | 'canUsePrompts'>;
  operation: InstructionsPromptWriteOperation;
  user: InstructionsPromptAccessUser;
  previous: AgentInstructionsPrompt | null | undefined;
  next: AgentInstructionsPrompt | null | undefined;
  filters?: FiltersConfig;
  logger: InstructionsPromptAccessLogger;
  /** Forwarded unexamined to `access.canUsePrompts`/`validateLinkWrite` so the role
   *  lookup behind them can reuse the caller's per-request role cache. */
  req?: InstructionsPromptAccessRequest;
}): Promise<InstructionsPromptLinkErrorResponse | null> {
  if (next === undefined) {
    return null;
  }
  try {
    if (operation === 'duplicate') {
      if (next == null) {
        return null;
      }
      const allowed = await access.canUsePrompts(user, req);
      return allowed
        ? null
        : buildInstructionsPromptError(403, InstructionsPromptErrorCode.FORBIDDEN);
    }
    return await getInstructionsPromptLinkError({
      access,
      user,
      previous: previous ?? null,
      next,
      filters,
      requireResolvable: operation !== 'revert',
      req,
    });
  } catch (error) {
    if (isContentFilterError(error)) {
      throw error;
    }
    logger.error(
      '[checkInstructionsPromptWrite] Failed to validate a linked instructions-prompt write',
      getSafeErrorMetadata(error),
    );
    return VALIDATION_FAILED_ERROR;
  }
}

/**
 * Applies the create/update convention that a `null` `instructionsPrompt` in
 * the update payload means "remove the link" — expressed as `$unset` because
 * `removeNullishValues` drops a bare `null` before it would reach the database
 * driver. Leaves `updateData` untouched when the field isn't `null` (absent,
 * or a link to set). Any existing `$unset` entries on `updateData` are kept.
 * Takes and returns a plain record — the `/api` update payload it operates on
 * is assembled dynamically and has no single static shape.
 */
export function applyInstructionsPromptUnset(
  updateData: Record<string, unknown>,
): Record<string, unknown> {
  if (updateData.instructionsPrompt !== null) {
    return updateData;
  }
  const { instructionsPrompt: _removed, $unset, ...rest } = updateData;
  return {
    ...rest,
    $unset: { ...(($unset as Record<string, unknown> | undefined) ?? {}), instructionsPrompt: 1 },
  };
}

/**
 * The link that will govern the agent's instructions after this write: `next`
 * when the payload carries the field at all (including an explicit `null`
 * removal), otherwise whatever is already stored (`previous`). A create has
 * no stored link, so callers pass `undefined` for `previous` there.
 */
export function effectiveInstructionsPromptLink(
  next: AgentInstructionsPrompt | RestrictedAgentInstructionsPrompt | null | undefined,
  previous: AgentInstructionsPrompt | RestrictedAgentInstructionsPrompt | null | undefined,
): AgentInstructionsPrompt | RestrictedAgentInstructionsPrompt | null | undefined {
  return next !== undefined ? next : previous;
}

/**
 * Resolves what a save-time content scan should see for `instructions`, given the
 * link that governed the agent before this write (`previous`) and the one that will
 * govern it after (`effective`).
 *
 * Excludes `instructions` when `effective` is a real link (`isValidInstructionsPromptLink`
 * — the same shape test `initializeAgent` uses): that text is dead once a link governs
 * the agent, so it must not block a write that is otherwise switching to safe, linked
 * content.
 *
 * Otherwise the agent's inline `instructions` are live text, and the payload's own
 * `instructions` is scanned as-is when present. `fallbackInstructions` only fills in
 * for a payload that sends none, and only when `previous` was a real link: that is
 * the one case where text that was never scanned while the link stayed valid
 * (`existingAgent.instructions` for an update, the reverted snapshot's own
 * `instructions` for a revert) is about to go live and must be scanned before it does.
 * An ordinary unlinked agent — `previous` was never a real link — keeps the base
 * behavior of scanning only what the payload actually submits; `fallbackInstructions`
 * is ignored for it even when supplied, so a safe partial edit that omits
 * `instructions` is never rejected over stored text nothing in this write touches.
 * Every other field of `data` is returned unchanged.
 */
export function excludeInstructionsWhenLinked<T extends { instructions?: unknown }>(
  data: T,
  {
    previous,
    effective,
    fallbackInstructions,
  }: {
    previous: AgentInstructionsPrompt | RestrictedAgentInstructionsPrompt | null | undefined;
    effective: AgentInstructionsPrompt | RestrictedAgentInstructionsPrompt | null | undefined;
    fallbackInstructions?: unknown;
  },
): T {
  if (isValidInstructionsPromptLink(effective)) {
    return { ...data, instructions: undefined };
  }
  const linkRemoved = isValidInstructionsPromptLink(previous);
  if (linkRemoved && data.instructions === undefined && fallbackInstructions !== undefined) {
    return { ...data, instructions: fallbackInstructions };
  }
  return data;
}
