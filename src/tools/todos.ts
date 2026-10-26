import type { TodoItem, ToolDefinition, ToolResult } from '../core/types.js';
import { SurfError } from '../core/errors.js';

export const todoTool: ToolDefinition = {
  name: 'todo_write',
  description:
    'Maintain a short task list for multi-step work. Send the full list each time. Keep exactly one item in_progress when actively working. Use this for complex tasks; skip it for simple edits.',
  readOnly: true,
  action: 'read',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The complete todo list.',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Task description.' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }
          },
          required: ['content', 'status']
        }
      }
    },
    required: ['todos']
  },
  async execute(args, context): Promise<ToolResult> {
    if (!Array.isArray(args.todos)) throw new SurfError('todos must be an array.');
    const todos: TodoItem[] = args.todos.map((item: any) => {
      const content = String(item?.content ?? '').trim();
      const status = item?.status;
      if (!content) throw new SurfError('Every todo needs content.');
      if (!['pending', 'in_progress', 'completed'].includes(status)) {
        throw new SurfError(`Invalid todo status: ${String(status)}`);
      }
      return { content, status } as TodoItem;
    });
    context.setTodos?.(todos);
    const marks = { pending: '○', in_progress: '◐', completed: '●' } as const;
    const lines = todos.map((todo) => `${marks[todo.status]} ${todo.content}`);
    return {
      output:
        todos.length === 0
          ? 'Todo list cleared.'
          : `${todos.filter((todo) => todo.status === 'completed').length}/${todos.length} complete\n${lines.join('\n')}`,
      title: 'Plan',
      display: { kind: 'todos', summary: `${todos.filter((todo) => todo.status === 'completed').length}/${todos.length}`, todos }
    };
  }
};
