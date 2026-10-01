import { Button } from '@librechat/client';
import { Controller, useWatch, useFormContext } from 'react-hook-form';
import type { AgentForm } from '~/common';
import InstructionsPromptFields, { fieldWrapperClass, LoadError } from './InstructionsPromptFields';
import { isRestrictedInstructionsPrompt } from './instructionsPromptUtils';
import RestrictedInstructionsPrompt from './RestrictedInstructionsPrompt';
import { VariableEditor } from '~/components/Variables';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

/** Status of the expanded agent query that `instructionsPrompt` arrives on. A
 * persisted agent's basic projection never carries `instructionsPrompt`, so this
 * section stays in a disabled loading (or error) state until the expanded query
 * resolves, rather than briefly reading the link as absent. */
export type InstructionsPromptStatus = 'ready' | 'loading' | 'error';

/** Two-way segmented toggle between the inline editor and a linked prompt group. */
function SourceToggle({ disabled }: { disabled: boolean }) {
  const localize = useLocalize();
  const { control } = useFormContext<AgentForm>();

  return (
    <Controller
      name="instructionsSource"
      control={control}
      render={({ field }) => (
        <div
          role="group"
          aria-label={localize('com_agents_instructions_source_toggle_aria')}
          className="inline-flex w-fit gap-1 rounded-lg border border-border-light bg-surface-primary p-0.5"
        >
          <Button
            type="button"
            variant={field.value === 'inline' ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={field.value === 'inline'}
            disabled={disabled}
            onClick={() => field.onChange('inline')}
          >
            {localize('com_agents_instructions_source_inline')}
          </Button>
          <Button
            type="button"
            variant={field.value === 'prompt' ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={field.value === 'prompt'}
            disabled={disabled}
            onClick={() => field.onChange('prompt')}
          >
            {localize('com_agents_instructions_source_prompt')}
          </Button>
        </div>
      )}
    />
  );
}

export default function Instructions({
  promptStatus = 'ready',
  onRetryLoad,
}: {
  promptStatus?: InstructionsPromptStatus;
  onRetryLoad?: () => void;
}) {
  const localize = useLocalize();
  const { control } = useFormContext<AgentForm>();
  const instructionsSource = useWatch({ control, name: 'instructionsSource' });
  const instructionsPrompt = useWatch({ control, name: 'instructionsPrompt' });
  const restricted = isRestrictedInstructionsPrompt(instructionsPrompt);
  const isPromptMode = instructionsSource === 'prompt';

  /** The expanded agent query (the only source of `instructionsPrompt`) has not
   * resolved yet: nothing here is derived from the basic projection, which would
   * otherwise read a linked agent as unlinked. Controls stay disabled so a save
   * cannot carry an instructions change until the real link is known. */
  if (promptStatus !== 'ready') {
    return (
      <div className="mb-3 flex flex-col gap-2">
        <SourceToggle disabled />
        {promptStatus === 'error' ? (
          <LoadError forbidden={false} onRetry={onRetryLoad ?? (() => {})} />
        ) : (
          <div className={fieldWrapperClass}>{localize('com_ui_loading')}</div>
        )}
      </div>
    );
  }

  return (
    <div className="mb-3 flex flex-col gap-2">
      <SourceToggle disabled={restricted} />

      {isPromptMode &&
        (restricted ? <RestrictedInstructionsPrompt /> : <InstructionsPromptFields />)}

      <Controller
        name="instructions"
        control={control}
        render={({ field, fieldState: { error } }) => (
          <div
            data-testid="instructions-inline-panel"
            className={cn('flex flex-col', isPromptMode && 'hidden')}
          >
            <VariableEditor
              id="instructions"
              label={localize('com_ui_instructions')}
              value={field.value ?? ''}
              onChange={field.onChange}
              onBlur={field.onBlur}
              inputRef={field.ref}
              placeholder={localize('com_agents_instructions_placeholder')}
              className="min-h-[88px] resize-y"
              labelClassName="block text-[11px] font-medium uppercase tracking-wide text-text-secondary"
              rows={3}
              required={!isPromptMode}
              invalid={error != null}
            />
            {error && (
              <span
                className="mt-1 text-xs text-text-destructive transition duration-300 ease-in-out"
                role="alert"
              >
                {localize('com_ui_field_required')}
              </span>
            )}
          </div>
        )}
      />
    </div>
  );
}
