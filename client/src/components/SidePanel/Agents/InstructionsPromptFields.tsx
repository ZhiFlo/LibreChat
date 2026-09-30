import { useMemo } from 'react';
import { Controller, useFormContext } from 'react-hook-form';
import { Button, Label, ControlCombobox } from '@librechat/client';
import type { AgentInstructionsPromptSelection } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { AgentForm } from '~/common';
import {
  buildPromptVersionOptions,
  isRestrictedInstructionsPrompt,
  getHttpStatus,
} from './instructionsPromptUtils';
import { useGetAllPromptGroups, useGetPrompts } from '~/data-provider';
import { useLocalize } from '~/hooks';

const fieldWrapperClass =
  'flex h-9 items-center rounded-lg border border-border-light bg-surface-secondary px-3 text-sm text-text-secondary';

function LoadError({ forbidden, onRetry }: { forbidden: boolean; onRetry: () => void }) {
  const localize = useLocalize();
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border-light bg-surface-secondary px-3 py-2 text-sm text-text-secondary">
      <span role="alert">
        {forbidden
          ? localize('com_agents_instructions_prompt_forbidden')
          : localize('com_agents_instructions_prompt_load_error')}
      </span>
      {!forbidden && (
        <Button type="button" variant="outline" size="sm" className="w-fit" onClick={onRetry}>
          {localize('com_ui_retry')}
        </Button>
      )}
    </div>
  );
}

function VersionSelect({
  groupId,
  productionId,
  selection,
  onSelect,
}: {
  groupId: string;
  productionId?: string | null;
  selection?: AgentInstructionsPromptSelection;
  onSelect: (selection: AgentInstructionsPromptSelection) => void;
}) {
  const localize = useLocalize();
  const promptsQuery = useGetPrompts({ groupId }, { enabled: groupId !== '' });
  const promptsData = promptsQuery.data;
  const prompts = useMemo(() => (Array.isArray(promptsData) ? promptsData : []), [promptsData]);
  const options = useMemo(
    () => buildPromptVersionOptions(prompts, productionId, localize),
    [prompts, productionId, localize],
  );
  const selectedValue = selection?.type === 'exact' ? selection.promptId : 'production';
  const selectedOption = options.find((option) => option.value === selectedValue);

  let content: ReactNode;
  if (groupId === '') {
    content = (
      <div className={fieldWrapperClass}>
        {localize('com_agents_instructions_prompt_version_placeholder')}
      </div>
    );
  } else if (promptsQuery.isLoading) {
    content = <div className={fieldWrapperClass}>{localize('com_ui_loading')}</div>;
  } else if (promptsQuery.isError || !Array.isArray(promptsQuery.data)) {
    content = (
      <LoadError
        forbidden={getHttpStatus(promptsQuery.error) === 403}
        onRetry={() => promptsQuery.refetch()}
      />
    );
  } else if (prompts.length === 0) {
    content = (
      <div className={fieldWrapperClass}>{localize('com_agents_instructions_prompt_empty')}</div>
    );
  } else {
    content = (
      <ControlCombobox
        selectId="instructions-prompt-version"
        selectedValue={selectedValue}
        displayValue={selectedOption?.label ?? ''}
        selectPlaceholder={localize('com_agents_instructions_prompt_version_select_placeholder')}
        setValue={(value) => {
          const option = options.find((item) => item.value === value);
          if (option) {
            onSelect(option.selection);
          }
        }}
        items={options}
        ariaLabel={localize('com_agents_instructions_prompt_version_label')}
        isCollapsed={false}
        showCarat={true}
        variant="field"
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-col">
      <Label
        className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-text-secondary"
        htmlFor="instructions-prompt-version"
      >
        {localize('com_agents_instructions_prompt_version_label')}
      </Label>
      {content}
    </div>
  );
}

/**
 * Prompt + Version dropdown row shown in "Prompt" instructions mode. Reads and
 * writes the whole `instructionsPrompt` link through a single Controller, since
 * the two dropdowns jointly determine one value.
 */
export default function InstructionsPromptFields() {
  const localize = useLocalize();
  const { control } = useFormContext<AgentForm>();
  const groupsQuery = useGetAllPromptGroups();
  const groups = Array.isArray(groupsQuery.data) ? groupsQuery.data : [];

  return (
    <Controller
      name="instructionsPrompt"
      control={control}
      render={({ field }) => {
        const link =
          field.value != null && !isRestrictedInstructionsPrompt(field.value) ? field.value : null;
        const groupId = link?.groupId ?? '';
        const selectedGroup = groups.find((group) => group._id === groupId);

        const handleGroupChange = (nextGroupId: string) => {
          if (nextGroupId === '') {
            field.onChange(null);
            return;
          }
          field.onChange({
            source: 'native',
            groupId: nextGroupId,
            selection: { type: 'production' },
          });
        };

        let groupField: ReactNode;
        if (groupsQuery.isLoading) {
          groupField = <div className={fieldWrapperClass}>{localize('com_ui_loading')}</div>;
        } else if (groupsQuery.isError) {
          groupField = (
            <LoadError
              forbidden={getHttpStatus(groupsQuery.error) === 403}
              onRetry={() => groupsQuery.refetch()}
            />
          );
        } else if (groups.length === 0) {
          groupField = (
            <div className={fieldWrapperClass}>
              {localize('com_agents_instructions_prompt_empty')}
            </div>
          );
        } else {
          groupField = (
            <ControlCombobox
              selectId="instructions-prompt-group"
              selectedValue={groupId}
              displayValue={selectedGroup?.name ?? ''}
              selectPlaceholder={localize('com_agents_instructions_prompt_select_placeholder')}
              searchPlaceholder={localize('com_agents_instructions_prompt_search_placeholder')}
              setValue={handleGroupChange}
              items={groups.map((group) => ({ label: group.name, value: group._id ?? '' }))}
              ariaLabel={localize('com_ui_prompt')}
              isCollapsed={false}
              showCarat={true}
              variant="field"
            />
          );
        }

        return (
          <div className="grid grid-cols-2 gap-2">
            <div className="flex min-w-0 flex-col">
              <Label
                className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-text-secondary"
                htmlFor="instructions-prompt-group"
              >
                {localize('com_ui_prompt')}
              </Label>
              {groupField}
            </div>
            <VersionSelect
              groupId={groupId}
              productionId={selectedGroup?.productionId}
              selection={link?.selection}
              onSelect={(selection) => {
                if (groupId === '') {
                  return;
                }
                field.onChange({ source: 'native', groupId, selection });
              }}
            />
          </div>
        );
      }}
    />
  );
}
