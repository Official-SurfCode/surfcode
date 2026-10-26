export interface Theme {
  name: string;
  label: string;
  description: string;
  /** Fill the whole frame with this color. Only dark mode opts into it. */
  background?: string;
  accent: string;
  accent2: string;
  accent3: string;
  text: string;
  muted: string;
  dim: string;
  faint: string;
  border: string;
  borderBright: string;
  user: string;
  assistant: string;
  success: string;
  warning: string;
  error: string;
  code: string;
  codeBorder: string;
  thinking: string;
  gradient: string[];
}

const AURORA: Theme = {
  name: 'aurora',
  label: 'Aurora',
  description: 'deep blue, ice, and electric cyan',
  accent: '#60A5FA',
  accent2: '#38BDF8',
  accent3: '#22D3EE',
  text: '#E2E8F0',
  muted: '#94A3B8',
  dim: '#64748B',
  faint: '#475569',
  border: '#24344D',
  borderBright: '#3B82F6',
  user: '#93C5FD',
  assistant: '#BFDBFE',
  success: '#4ADE80',
  warning: '#FBBF24',
  error: '#FB7185',
  code: '#93C5FD',
  codeBorder: '#1E3A5F',
  thinking: '#7C8AA5',
  gradient: ['#1D4ED8', '#2563EB', '#0EA5E9', '#7DD3FC']
};

const DARK: Theme = {
  name: 'dark',
  label: 'Dark',
  description: 'pure black canvas with electric blue and vivid accents',
  background: '#000000',
  accent: '#60A5FA',
  accent2: '#A78BFA',
  accent3: '#22D3EE',
  text: '#F8FAFC',
  muted: '#CBD5E1',
  dim: '#94A3B8',
  faint: '#64748B',
  border: '#334155',
  borderBright: '#60A5FA',
  user: '#5EEAD4',
  assistant: '#C4B5FD',
  success: '#4ADE80',
  warning: '#FBBF24',
  error: '#FB7185',
  code: '#F9A8D4',
  codeBorder: '#831843',
  thinking: '#A5B4FC',
  gradient: ['#2563EB', '#3B82F6', '#22D3EE', '#A78BFA']
};

const EMBER: Theme = {
  name: 'ember',
  label: 'Ember',
  description: 'warm orange sunsets over dark water',
  accent: '#FB923C',
  accent2: '#F43F5E',
  accent3: '#FDE047',
  text: '#F5E9E2',
  muted: '#C4A99A',
  dim: '#8F7466',
  faint: '#634F44',
  border: '#4A342A',
  borderBright: '#6B4A3A',
  user: '#FDBA74',
  assistant: '#FDA4AF',
  success: '#86EFAC',
  warning: '#FDE047',
  error: '#FB7185',
  code: '#FDBA74',
  codeBorder: '#5C3326',
  thinking: '#B08C7A',
  gradient: ['#F97316', '#F43F5E', '#FDE047']
};

const FOREST: Theme = {
  name: 'forest',
  label: 'Forest',
  description: 'moss, mint, and quiet terminal energy',
  accent: '#6EE7B7',
  accent2: '#34D399',
  accent3: '#A3E635',
  text: '#E4EFE8',
  muted: '#9CB8A8',
  dim: '#6B8577',
  faint: '#4B6156',
  border: '#29453A',
  borderBright: '#3C5F50',
  user: '#5EEAD4',
  assistant: '#86EFAC',
  success: '#4ADE80',
  warning: '#FACC15',
  error: '#FB7185',
  code: '#A7F3D0',
  codeBorder: '#1F4A3A',
  thinking: '#82A895',
  gradient: ['#34D399', '#22D3EE', '#A3E635']
};

const VIOLET: Theme = {
  name: 'violet',
  label: 'Violet',
  description: 'electric lilac with synthwave edges',
  accent: '#C084FC',
  accent2: '#818CF8',
  accent3: '#F472B6',
  text: '#ECE9FF',
  muted: '#A99BC7',
  dim: '#7C6F99',
  faint: '#594F70',
  border: '#3B2D56',
  borderBright: '#58437A',
  user: '#D8B4FE',
  assistant: '#A5B4FC',
  success: '#5EEAD4',
  warning: '#FDE047',
  error: '#FB7185',
  code: '#E9D5FF',
  codeBorder: '#4A2D6A',
  thinking: '#A898C7',
  gradient: ['#C084FC', '#818CF8', '#F472B6']
};

const MONO: Theme = {
  name: 'mono',
  label: 'Mono',
  description: 'ink, graphite, and clean lines',
  accent: '#F1F5F9',
  accent2: '#CBD5E1',
  accent3: '#94A3B8',
  text: '#E2E8F0',
  muted: '#A1AAB8',
  dim: '#78828F',
  faint: '#53606D',
  border: '#39434F',
  borderBright: '#56616E',
  user: '#E2E8F0',
  assistant: '#CBD5E1',
  success: '#A3E635',
  warning: '#FDE047',
  error: '#FB7185',
  code: '#F1F5F9',
  codeBorder: '#3D4652',
  thinking: '#8B96A3',
  gradient: ['#F8FAFC', '#CBD5E1', '#64748B']
};

export const THEMES: Theme[] = [AURORA, DARK, EMBER, FOREST, VIOLET, MONO];

export function getTheme(name: string): Theme {
  return THEMES.find((theme) => theme.name === name || theme.label.toLowerCase() === name.toLowerCase()) ?? AURORA;
}

export function nextTheme(name: string, direction = 1): Theme {
  const index = Math.max(0, THEMES.findIndex((theme) => theme.name === getTheme(name).name));
  return THEMES[(index + direction + THEMES.length) % THEMES.length] ?? AURORA;
}
