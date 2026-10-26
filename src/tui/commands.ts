export interface SlashCommand {
  name: string;
  args?: string;
  description: string;
  category: 'session' | 'model' | 'view' | 'mode' | 'help';
}

export const COMMANDS: SlashCommand[] = [
  { name: '/model', args: '[query]', description: 'Switch model or search 9k+ models', category: 'model' },
  { name: '/connect', description: 'Connect a provider and save its API key', category: 'model' },
  { name: '/provider', description: 'Browse all providers', category: 'model' },
  { name: '/theme', args: '[name]', description: 'Change the color theme', category: 'view' },
  { name: '/explorer', args: '[width]', description: 'Focus the always-visible file dock', category: 'view' },
  { name: '/options', description: 'Open settings and toggles', category: 'view' },
  { name: '/effort', args: '[low|medium|high|auto]', description: 'Set reasoning effort', category: 'model' },
  { name: '/stream', args: '[on|off]', description: 'Toggle live token painting', category: 'view' },
  { name: '/access', args: '[full|safe]', description: 'Toggle full computer access', category: 'mode' },
  { name: '/agent', args: '[status|on|off|add|remove|clear|head]', description: 'Run worker models in parallel', category: 'mode' },
  { name: '/thinking', description: 'Show or hide reasoning text', category: 'view' },
  { name: '/verbose', description: 'Expand or collapse tool output', category: 'view' },
  { name: '/plan', description: 'Switch to read-only plan mode', category: 'mode' },
  { name: '/build', description: 'Switch to build mode', category: 'mode' },
  { name: '/clear', description: 'Clear the visible conversation', category: 'session' },
  { name: '/new', description: 'Start a fresh session', category: 'session' },
  { name: '/sessions', description: 'Resume a past session', category: 'session' },
  { name: '/sync', args: '[push|pull]', description: 'Sync sessions with your own endpoint', category: 'session' },
  { name: '/stop', description: 'Stop the AI reply in flight', category: 'session' },
  { name: '/compact', description: 'Summarize history to free context', category: 'session' },
  { name: '/btw', args: '<question>', description: 'Ask a side question without saving it', category: 'session' },
  { name: '/github', args: '[status|login|logout]', description: 'Connect GitHub and publish code', category: 'session' },
  { name: '/context', description: 'Show context window usage', category: 'session' },
  { name: '/cost', description: 'Show session token usage and cost', category: 'session' },
  { name: '/export', args: '[path]', description: 'Export this session as Markdown', category: 'session' },
  { name: '/init', description: 'Generate a SURFCODE.md project guide', category: 'mode' },
  { name: '/help', description: 'Show commands and keyboard shortcuts', category: 'help' },
  { name: '/quit', description: 'Save and exit SurfCode', category: 'help' }
];

export function filterCommands(input: string): SlashCommand[] {
  const query = input.trim().toLowerCase();
  if (!query.startsWith('/')) return [];
  const normalized = query.slice(1);
  if (normalized.includes(' ')) return [];
  return COMMANDS.filter((command) => command.name.slice(1).startsWith(normalized)).slice(0, 8);
}

export function findCommand(name: string): SlashCommand | undefined {
  return COMMANDS.find((command) => command.name === name);
}

export const KEYBINDS: Array<[string, string]> = [
  ['enter', 'send prompt'],
  ['ctrl+j', 'insert newline'],
  ['esc', 'stop generating / leave explorer / close overlay'],
  ['/stop', 'stop the AI reply in flight'],
  ['ctrl+c', 'interrupt, then exit'],
  ['pgup / pgdn', 'scroll transcript'],
  ['ctrl+u / ctrl+d', 'half-page scroll'],
  ['tab', 'complete command or file'],
  ['up / down', 'input history'],
  ['shift+tab', 'toggle plan/build mode'],
  ['ctrl+t', 'cycle theme'],
  ['ctrl+o', 'focus the file explorer'],
  ['ctrl+← / →', 'resize the explorer'],
  ['[ / ]', 'resize the explorer while focused'],
  ['ctrl+v', 'paste from clipboard'],
  ['?', 'help (when input is empty)']
];
