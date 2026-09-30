import React from 'react';
import { useForm, FormProvider } from 'react-hook-form';
import { render, screen, fireEvent } from '@testing-library/react';
import type { TPromptGroup, TPrompt } from 'librechat-data-provider';
import type { UseFormReturn } from 'react-hook-form';
import type { AgentForm } from '~/common';
import InstructionsPromptFields from '../InstructionsPromptFields';

let mockGroupsQuery: {
  data?: unknown;
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
  refetch: jest.Mock;
};
let mockPromptsQuery: {
  data?: unknown;
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
  refetch: jest.Mock;
};

jest.mock('~/data-provider', () => ({
  useGetAllPromptGroups: () => mockGroupsQuery,
  useGetPrompts: () => mockPromptsQuery,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

jest.mock('@librechat/client', () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: React.ComponentProps<'button'> & { variant?: string; size?: string }) => (
    <button {...props}>{children}</button>
  ),
  Label: ({ children, ...props }: React.ComponentProps<'label'>) => (
    <label {...props}>{children}</label>
  ),
  ControlCombobox: ({
    ariaLabel,
    selectId,
    items,
    selectedValue,
    setValue,
  }: {
    ariaLabel: string;
    selectId?: string;
    items: Array<{ value: string; label: string }>;
    selectedValue: string;
    setValue: (value: string) => void;
  }) => (
    <select
      aria-label={ariaLabel}
      id={selectId}
      value={selectedValue}
      onChange={(event) => setValue(event.target.value)}
    >
      {items.map((item) => (
        <option key={item.value} value={item.value}>
          {item.label}
        </option>
      ))}
    </select>
  ),
}));

const group = (overrides: Partial<TPromptGroup> = {}): TPromptGroup => ({
  name: 'Support triage',
  author: 'user1',
  authorName: 'User One',
  _id: 'group1',
  ...overrides,
});

const prompt = (overrides: Partial<TPrompt> = {}): TPrompt => ({
  groupId: 'group1',
  author: 'user1',
  prompt: 'text',
  type: 'text',
  createdAt: '',
  updatedAt: '',
  ...overrides,
});

function Harness({
  defaultInstructionsPrompt = null,
  onMethods,
}: {
  defaultInstructionsPrompt?: unknown;
  onMethods?: (methods: UseFormReturn<AgentForm>) => void;
}) {
  const methods = useForm<AgentForm>({
    defaultValues: { instructionsPrompt: defaultInstructionsPrompt } as Partial<AgentForm>,
  });
  onMethods?.(methods);
  return (
    <FormProvider {...methods}>
      <InstructionsPromptFields />
    </FormProvider>
  );
}

beforeEach(() => {
  mockGroupsQuery = {
    data: [],
    isLoading: false,
    isError: false,
    error: undefined,
    refetch: jest.fn(),
  };
  mockPromptsQuery = {
    data: [],
    isLoading: false,
    isError: false,
    error: undefined,
    refetch: jest.fn(),
  };
});

describe('InstructionsPromptFields', () => {
  it('shows a loading state for the Prompt dropdown', () => {
    mockGroupsQuery.isLoading = true;
    render(<Harness />);

    expect(screen.getByText('com_ui_loading')).toBeInTheDocument();
  });

  it('shows an empty state when there are no prompt groups', () => {
    mockGroupsQuery.data = [];
    render(<Harness />);

    expect(screen.getByText('com_agents_instructions_prompt_empty')).toBeInTheDocument();
  });

  it('shows an error with Retry, and retries on click', () => {
    mockGroupsQuery.isError = true;
    mockGroupsQuery.error = new Error('network down');
    render(<Harness />);

    expect(screen.getByText('com_agents_instructions_prompt_load_error')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(mockGroupsQuery.refetch).toHaveBeenCalledTimes(1);
  });

  it('shows a distinct message for a 403 and offers no retry', () => {
    mockGroupsQuery.isError = true;
    mockGroupsQuery.error = { isAxiosError: true, response: { status: 403, data: {} } };
    render(<Harness />);

    expect(screen.getByText('com_agents_instructions_prompt_forbidden')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'com_ui_retry' })).not.toBeInTheDocument();
  });

  it('selecting a prompt group defaults the selection to Production', () => {
    mockGroupsQuery.data = [group()];
    let methods: UseFormReturn<AgentForm> | undefined;
    render(<Harness onMethods={(m) => (methods = m)} />);

    fireEvent.change(screen.getByLabelText('com_ui_prompt'), { target: { value: 'group1' } });

    expect(methods?.getValues('instructionsPrompt')).toEqual({
      source: 'native',
      groupId: 'group1',
      selection: { type: 'production' },
    });
  });

  it('lists Production first, then versions newest to oldest', () => {
    mockGroupsQuery.data = [group({ productionId: 'p2' })];
    mockPromptsQuery.data = [prompt({ _id: 'p3' }), prompt({ _id: 'p2' }), prompt({ _id: 'p1' })];
    render(
      <Harness
        defaultInstructionsPrompt={{
          source: 'native',
          groupId: 'group1',
          selection: { type: 'production' },
        }}
      />,
    );

    const versionSelect = screen.getByLabelText('com_agents_instructions_prompt_version_label');
    const optionValues = Array.from(versionSelect.querySelectorAll('option')).map(
      (option) => (option as HTMLOptionElement).value,
    );
    expect(optionValues).toEqual(['production', 'p3', 'p2', 'p1']);
    expect(
      screen.getByText('com_agents_instructions_prompt_production_version:{"0":"2"}'),
    ).toBeInTheDocument();
  });

  it('selecting a version produces an exact selection', () => {
    mockGroupsQuery.data = [group()];
    mockPromptsQuery.data = [prompt({ _id: 'p2' }), prompt({ _id: 'p1' })];
    let methods: UseFormReturn<AgentForm> | undefined;
    render(
      <Harness
        defaultInstructionsPrompt={{
          source: 'native',
          groupId: 'group1',
          selection: { type: 'production' },
        }}
        onMethods={(m) => (methods = m)}
      />,
    );

    fireEvent.change(screen.getByLabelText('com_agents_instructions_prompt_version_label'), {
      target: { value: 'p1' },
    });

    expect(methods?.getValues('instructionsPrompt')).toEqual({
      source: 'native',
      groupId: 'group1',
      selection: { type: 'exact', promptId: 'p1' },
    });
  });

  it('disables the Version dropdown until a prompt group is selected', () => {
    mockGroupsQuery.data = [group()];
    render(<Harness />);

    expect(
      screen.getByText('com_agents_instructions_prompt_version_placeholder'),
    ).toBeInTheDocument();
  });

  it('surfaces a 403 for the Version dropdown separately from the Prompt dropdown', () => {
    mockGroupsQuery.data = [group()];
    mockPromptsQuery.isError = true;
    mockPromptsQuery.error = { isAxiosError: true, response: { status: 403, data: {} } };
    render(
      <Harness
        defaultInstructionsPrompt={{
          source: 'native',
          groupId: 'group1',
          selection: { type: 'production' },
        }}
      />,
    );

    expect(screen.getByText('com_agents_instructions_prompt_forbidden')).toBeInTheDocument();
  });

  it('guards a 200 {message} version response as a load failure, not a crash', () => {
    mockGroupsQuery.data = [group()];
    mockPromptsQuery.data = { message: 'not allowed' };
    render(
      <Harness
        defaultInstructionsPrompt={{
          source: 'native',
          groupId: 'group1',
          selection: { type: 'production' },
        }}
      />,
    );

    expect(screen.getByText('com_agents_instructions_prompt_load_error')).toBeInTheDocument();
  });
});
