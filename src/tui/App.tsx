import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { Box, Text, useApp, useInput, usePaste, useStdout } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { glob } from 'tinyglobby';
import { runAgent } from '../core/agent.js';
import { parseWorkerRef, resolveAgentWorkers, workerLabel } from '../core/agents.js';
import {
  credentialStatus,
  envNameFor,
  removeProviderKey,
  saveProviderKey,
  type CredentialStatus
} from '../core/auth.js';
import { readClipboard } from '../core/clipboard.js';
import {
  allModels,
  findModel,
  providerById,
  recommendedModel,
  scoreModel,
  type Catalog
} from '../core/catalog.js';
import { streamChat } from '../core/chat/index.js';
import { compactConversation } from '../core/compact.js';
import { updateConfig, updateConfigPath } from '../core/config.js';
import { EFFORT_SETTINGS, activeEffort, effortLabel, parseEffort } from '../core/effort.js';
import { SurfError, errorMessage } from '../core/errors.js';
import { FREE_API_LABEL, hasFreeApi } from '../core/free.js';
import {
  githubTokenStatus,
  githubViewer,
  type GithubTokenStatus
} from '../core/github.js';
import {
  providerHasEndpoint,
  resolveProvider,
  resolveSelection,
  type ResolvedSelection
} from '../core/provider.js';
import {
  addSessionUsage,
  createSession,
  listSessions,
  loadSession,
  saveSession
} from '../core/session.js';
import { resolveSyncSettings, syncSessions } from '../core/sync.js';
import type {
  AgentDelegate,
  AgentWorker,
  CatalogProvider,
  ChatMessage,
  PermissionAction,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  SessionRecord,
  SurfConfig,
  Usage
} from '../core/types.js';
import { emptyUsage, estimateContextTokens, formatCost, formatPrice, formatTokens } from '../core/usage.js';
import { createTools } from '../tools/index.js';
import { shellTool } from '../tools/shell.js';
import { bg, fit } from './ansi.js';
import { COMMANDS } from './commands.js';
import {
  EXPLORER_DOCK_GAP,
  clampExplorerWidth,
  explorerDockWidth,
  explorerParent,
  findExplorerEntry,
  isExplorerDirectory,
  listExplorer,
  readExplorerPreview,
  type ExplorerEntry,
  type ExplorerPreview
} from './explorer.js';
import { BRAND_FRAME_MS, BRAND_WIDTH, brandTick, renderBrand, renderHero, renderInput, renderStatus, type StatusInfo } from './layout.js';
import {
  renderBtwOverlay,
  renderConnectInfo,
  renderExplorer,
  renderGithubInfo,
  renderHelpOverlay,
  renderPermission,
  renderPicker,
  renderSuggestions,
  renderThemePicker,
  type PickerItem
} from './overlays.js';
import { renderLive, renderTimeline } from './render.js';
import { getTheme, nextTheme, THEMES, type Theme } from './theme.js';
import type { LiveMessage, TimelineItem } from './types.js';
import { timelineFromMessages } from './types.js';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const EMPTY_SUGGESTION_LIMIT = 6;
const NON_CHAT_MODEL =
  /(embed|embedding|tts|whisper|audio|speech|rerank|moderation|upscal|dall-e|stable-diffusion|flux|sora|veo|imagen|nano-banana|computer-use|realtime)/i;

const PROVIDER_PRIORITY = new Map(
  [
    'anthropic',
    'openai',
    'google',
    'openrouter',
    'deepseek',
    'xai',
    'mistral',
    'groq',
    'cerebras',
    'togetherai',
    'vercel',
    'github-copilot',
    'azure',
    'amazon-bedrock',
    'google-vertex',
    'moonshotai',
    'zhipuai',
    'alibaba',
    'minimax',
    'cohere',
    'perplexity',
    'fireworks-ai',
    'deepinfra',
    'ollama-cloud'
  ].map((id, index) => [id, index])
);

type Activity =
  | { kind: 'agent'; label: string }
  | { kind: 'compact'; label: string }
  | { kind: 'shell'; label: string }
  | { kind: 'sync'; label: string };

type Overlay =
  | { kind: 'model'; query: string; selected: number; providerFilter?: string }
  | { kind: 'provider'; query: string; selected: number; purpose: 'switch' | 'connect' }
  | { kind: 'sessions'; query: string; selected: number }
  | { kind: 'themes'; selected: number; original: string }
  | { kind: 'settings'; selected: number }
  | { kind: 'btw' }
  | { kind: 'help' }
  | { kind: 'connect-key'; provider: CatalogProvider; value: string; cursor: number; next: 'models' | 'chat' }
  | { kind: 'github-key'; value: string; cursor: number }
  | { kind: 'permission'; request: PermissionRequest; resolve: (decision: PermissionDecision) => void };

interface ExplorerState {
  selected: number;
  expanded: string[];
  entries: ExplorerEntry[];
  preview?: ExplorerPreview;
  previewError?: string;
  loading: boolean;
}

interface Suggestion {
  label: string;
  description?: string;
  complete: string;
  kind: 'command' | 'file';
}

interface ModelEntry {
  provider: CatalogProvider;
  model: CatalogProvider['models'][string];
  search: string;
  score: number;
}

type SettingsId =
  | 'theme'
  | 'model'
  | 'provider'
  | 'mode'
  | 'effort'
  | 'stream'
  | 'explorer'
  | 'thinking'
  | 'tools'
  | 'access'
  | 'agent'
  | 'github';

interface SettingsRow {
  id: SettingsId;
  label: string;
  value: string;
  kind: 'action' | 'toggle' | 'choice';
}

interface BtwState {
  id: number;
  question: string;
  answer: string;
  reasoning: string;
  startedAt: number;
  done: boolean;
  error?: string;
}

export interface AppProps {
  cwd: string;
  config: SurfConfig;
  catalog: Catalog;
  session: SessionRecord;
  initialNotice?: string;
  initialPrompt?: string;
  onExit?: (session: SessionRecord, saved: boolean) => void;
}

export default function App({
  cwd,
  config: initialConfig,
  catalog,
  session: initialSession,
  initialNotice,
  initialPrompt,
  onExit
}: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const terminal = stdout as NodeJS.WriteStream;
  const [size, setSize] = useState(() => ({
    columns: Math.max(20, terminal.columns ?? 80),
    rows: Math.max(8, terminal.rows ?? 24)
  }));

  const [config, setConfig] = useState(initialConfig);
  const configRef = useRef(config);
  configRef.current = config;

  const [session, setSession] = useState(initialSession);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const [themeName, setThemeName] = useState(initialConfig.theme);
  const theme = getTheme(themeName);

  const [timeline, setTimeline] = useState<TimelineItem[]>(() => {
    const items = timelineFromMessages(initialSession.messages);
    if (initialNotice) {
      items.push({
        id: `notice_initial_${Date.now()}`,
        type: 'notice',
        content: initialNotice,
        level: 'info'
      });
    }
    return items;
  });

  const [input, setInput] = useState('');
  // Kept in sync synchronously so a fast type-then-Enter sequence submits the
  // character that was just typed, before React has committed the render.
  const inputRef = useRef(input);
  inputRef.current = input;
  const [cursor, setCursor] = useState(0);
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const [scrollOffset, setScrollOffset] = useState(0);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const overlayRef = useRef<Overlay | null>(overlay);
  overlayRef.current = overlay;

  const [explorer, setExplorer] = useState<ExplorerState>({
    selected: 0,
    expanded: [],
    entries: [],
    loading: true
  });
  const explorerRef = useRef<ExplorerState>(explorer);
  explorerRef.current = explorer;
  const [explorerFocused, setExplorerFocused] = useState(false);
  const explorerFocusedRef = useRef(explorerFocused);
  explorerFocusedRef.current = explorerFocused;
  const explorerWidthTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [activity, setActivity] = useState<Activity | null>(null);
  const activityRef = useRef<Activity | null>(activity);
  activityRef.current = activity;

  const [live, setLive] = useState<LiveMessage | null>(null);
  const liveRef = useRef<LiveMessage | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const permissionsRef = useRef<Record<PermissionAction, PermissionMode> | null>(null);

  const [btw, setBtw] = useState<BtwState | null>(null);
  const btwRef = useRef<BtwState | null>(null);
  const btwAbortRef = useRef<AbortController | null>(null);
  const btwCounter = useRef(0);

  const [runUsage, setRunUsage] = useState<Usage>(() => emptyUsage());
  const [credentials, setCredentials] = useState<Map<string, CredentialStatus>>(new Map());
  const [githubAuth, setGithubAuth] = useState<GithubTokenStatus | null>(null);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const filesLoaded = useRef(false);
  const filesLoading = useRef(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const historyDraft = useRef('');
  const [frame, setFrame] = useState(0);
  const [logoAnimating, setLogoAnimating] = useState(true);
  const [stopping, setStopping] = useState(false);
  const [ctrlCArmed, setCtrlCArmed] = useState(false);
  const ctrlCTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizeRepaint = useRef<ReturnType<typeof setTimeout> | null>(null);
  const quitting = useRef(false);
  const noticeCounter = useRef(0);
  const syncInFlight = useRef(false);

  const busy = activity !== null;
  const btwRunning = Boolean(btw && !btw.done);
  const spinner = SPINNER[frame % SPINNER.length] ?? '⠋';
  const activeProviderId = config.provider;
  const activeModelId = config.model;
  const activeProvider = activeProviderId ? providerById(catalog, activeProviderId) : undefined;
  const activeModelMeta =
    activeProviderId && activeModelId ? findModel(catalog, activeProviderId, activeModelId) : undefined;
  const contextWindow = activeModelMeta?.limit?.context ?? 128_000;
  const activeModelName = activeModelMeta?.name ?? activeModelId ?? '';

  useEffect(() => {
    const onResize = () => {
      setSize({
        columns: Math.max(20, terminal.columns ?? 80),
        rows: Math.max(8, terminal.rows ?? 24)
      });
      // A direct brand paint can land on the old bottom-right cell while the
      // terminal is resizing. Repaint once the new geometry has settled.
      if (resizeRepaint.current) clearTimeout(resizeRepaint.current);
      resizeRepaint.current = setTimeout(() => setFrame((value) => value + 1), 350);
    };
    terminal.on('resize', onResize);
    return () => {
      terminal.off('resize', onResize);
      if (resizeRepaint.current) clearTimeout(resizeRepaint.current);
    };
  }, [terminal]);

  useEffect(() => {
    if (!busy && !btwRunning) return;
    // When live streaming is off we only need to advance the spinner and tool
    // state, so repaint slowly. Streaming mode samples deltas faster.
    const interval = config.streaming ? 45 : 120;
    const timer = setInterval(() => setFrame((value) => value + 1), interval);
    return () => clearInterval(timer);
  }, [btwRunning, busy, config.streaming]);

  useEffect(() => {
    if (!logoAnimating) return;
    const timer = setInterval(() => setFrame((value) => value + 1), 80);
    const stop = setTimeout(() => setLogoAnimating(false), 3_400);
    return () => {
      clearInterval(timer);
      clearTimeout(stop);
    };
  }, [logoAnimating]);

  useEffect(() => {
    // The status bar is one Ink text node. Re-rendering the whole TUI just to
    // advance the corner animation is expensive, so idle animation repaints
    // only the final cells directly and leaves the React tree alone. While a
    // turn is active the regular frame loop already repaints the brand.
    if (!terminal.isTTY || busy || btwRunning) return;
    const timer = setInterval(() => {
      const columns = terminal.columns ?? size.columns;
      const rows = terminal.rows ?? size.rows;
      if (columns !== size.columns || rows !== size.rows) return;
      const brand = renderBrand(theme, brandTick());
      const painted = theme.background ? bg(theme.background, brand) : brand;
      terminal.write(`\x1b7\x1b[${rows};${Math.max(1, columns - BRAND_WIDTH + 1)}H${painted}\x1b8`);
    }, BRAND_FRAME_MS);
    return () => clearInterval(timer);
  }, [btwRunning, busy, size.columns, size.rows, terminal, theme]);

  useEffect(
    () => () => {
      if (ctrlCTimer.current) clearTimeout(ctrlCTimer.current);
      btwAbortRef.current?.abort();
    },
    []
  );

  const refreshCredentials = useCallback(async () => {
    try {
      const statuses = await credentialStatus(catalog.providers, configRef.current);
      setCredentials(new Map(statuses.map((status) => [status.provider.id, status])));
    } catch {
      // Credential display is best-effort.
    }
  }, [catalog]);

  useEffect(() => {
    void refreshCredentials();
  }, [refreshCredentials]);

  const refreshGithub = useCallback(async () => {
    try {
      setGithubAuth(await githubTokenStatus());
    } catch {
      // GitHub is optional; a broken auth store should not block the TUI.
    }
  }, []);

  useEffect(() => {
    void refreshGithub();
  }, [refreshGithub]);

  const loadFiles = useCallback(() => {
    if (filesLoaded.current || filesLoading.current) return;
    filesLoading.current = true;
    glob('**/*', {
      cwd,
      absolute: false,
      onlyFiles: true,
      dot: false,
      followSymbolicLinks: false,
      deep: 10,
      ignore: [
        'node_modules/**',
        '.git/**',
        'dist/**',
        'build/**',
        'coverage/**',
        '.next/**',
        '.nuxt/**',
        '.turbo/**',
        '.cache/**'
      ]
    })
      .then((found) => {
        setFiles(found.slice(0, 5000));
      })
      .catch(() => {
        // File completion is optional.
      })
      .finally(() => {
        filesLoaded.current = true;
        filesLoading.current = false;
      });
  }, [cwd]);

  useEffect(() => {
    // Scanning the workspace eagerly is expensive in large repos. Only pay for
    // it once the user actually asks for a file suggestion.
    if (!input.includes('@')) return;
    loadFiles();
  }, [input, loadFiles]);

  const addNotice = useCallback((content: string, level: 'info' | 'success' | 'warning' | 'error' = 'info') => {
    noticeCounter.current += 1;
    setTimeline((items) => [
      ...items,
      {
        id: `notice_${Date.now()}_${noticeCounter.current}`,
        type: 'notice',
        content,
        level
      }
    ]);
    setScrollOffset(0);
  }, []);

  const setInputValue = useCallback((value: string, nextCursor = value.length) => {
    inputRef.current = value;
    setInput(value);
    setCursor(Math.max(0, Math.min(nextCursor, value.length)));
    setSuggestionIndex(0);
    setSuggestionsDismissed(false);
    setHistoryIndex(-1);
  }, []);

  const clearInput = useCallback(() => {
    setInputValue('');
  }, [setInputValue]);

  const updateSetting = useCallback(
    async (
      patch: Partial<SurfConfig>,
      notice?: string,
      level: 'success' | 'warning' = 'success'
    ) => {
      try {
        const next = await updateConfig(patch);
        setConfig(next);
        if (patch.theme) setThemeName(patch.theme);
        if (notice) addNotice(notice, level);
      } catch (error) {
        addNotice(`Could not save settings: ${errorMessage(error)}`, 'error');
      }
    },
    [addNotice]
  );

  const setMode = useCallback(
    async (mode: 'build' | 'plan', announce = false) => {
      if (configRef.current.mode === mode) return;
      const next = await updateConfig({ mode });
      setConfig(next);
      setSession((current) => ({ ...current, mode }));
      sessionRef.current = { ...sessionRef.current, mode };
      if (announce) addNotice(mode === 'plan' ? 'Plan mode: read-only research.' : 'Build mode: edits enabled.', 'success');
    },
    [addNotice]
  );

  const showModelPicker = useCallback(
    (providerFilter?: string, query = '') => {
      setOverlay({ kind: 'model', query, selected: 0, providerFilter });
    },
    []
  );

  const showProviderPicker = useCallback((purpose: 'switch' | 'connect' = 'connect') => {
    setOverlay({ kind: 'provider', query: '', selected: 0, purpose });
  }, []);

  const promptForKey = useCallback((provider: CatalogProvider, next: 'models' | 'chat') => {
    setOverlay({ kind: 'connect-key', provider, value: '', cursor: 0, next });
  }, []);

  const refreshExplorer = useCallback(
    async (expanded: string[], selectPath?: string) => {
      try {
        const entries = await listExplorer(cwd, expanded);
        setExplorer((current) => {
          const target = selectPath ?? current.entries[current.selected]?.path;
          const found = target ? entries.findIndex((entry) => entry.path === target) : -1;
          const selected = found >= 0 ? found : Math.max(0, Math.min(current.selected, entries.length - 1));
          const entry = entries[selected];
          const preview =
            entry?.kind === 'file' && current.preview?.path === entry.path ? current.preview : undefined;
          return {
            ...current,
            entries,
            expanded,
            selected,
            loading: false,
            preview,
            previewError: undefined
          };
        });
      } catch (error) {
        addNotice(`Could not read the workspace: ${errorMessage(error)}`, 'error');
        setExplorer((current) => ({ ...current, loading: false }));
      }
    },
    [addNotice, cwd]
  );

  const focusExplorer = useCallback(() => {
    setExplorerFocused(true);
    if (!explorerRef.current.loading) {
      void refreshExplorer(explorerRef.current.expanded);
    }
  }, [refreshExplorer]);

  const resizeExplorer = useCallback(
    (delta: number) => {
      const columns = size.columns;
      const current = clampExplorerWidth(configRef.current.explorerWidth, columns);
      const next = clampExplorerWidth(current + delta, columns);
      if (next === current) return;
      configRef.current = { ...configRef.current, explorerWidth: next };
      setConfig((value) => ({ ...value, explorerWidth: next }));
      if (explorerWidthTimer.current) clearTimeout(explorerWidthTimer.current);
      explorerWidthTimer.current = setTimeout(() => {
        explorerWidthTimer.current = null;
        void updateConfig({ explorerWidth: next })
          .then((updated) => setConfig(updated))
          .catch((error) => addNotice(`Could not save explorer width: ${errorMessage(error)}`, 'error'));
      }, 350);
    },
    [addNotice, size.columns]
  );

  const loadExplorerPreview = useCallback(
    async (path: string) => {
      try {
        const preview = await readExplorerPreview(cwd, path);
        setExplorer((current) =>
          current.entries[current.selected]?.path === path
            ? { ...current, preview, previewError: undefined }
            : current
        );
      } catch (error) {
        setExplorer((current) =>
          current.entries[current.selected]?.path === path
            ? { ...current, preview: undefined, previewError: errorMessage(error) }
            : current
        );
      }
    },
    [cwd]
  );

  useEffect(() => {
    void refreshExplorer([]);
  }, [refreshExplorer]);

  useEffect(() => {
    const entry = explorer.entries[explorer.selected];
    if (!entry || entry.kind !== 'file' || explorer.preview?.path === entry.path) return;
    void loadExplorerPreview(entry.path);
  }, [explorer.entries, explorer.preview?.path, explorer.selected, loadExplorerPreview]);

  useEffect(() => {
    if (overlay) setExplorerFocused(false);
  }, [overlay]);

  useEffect(
    () => () => {
      if (explorerWidthTimer.current) clearTimeout(explorerWidthTimer.current);
    },
    []
  );

  const openGithubLogin = useCallback(() => {
    setOverlay({ kind: 'github-key', value: '', cursor: 0 });
  }, []);

  const submitGithubToken = useCallback(
    async (raw: string) => {
      const token = raw.trim();
      if (!token) return;
      setActivity({ kind: 'sync', label: 'verifying GitHub token' });
      try {
        const viewer = await githubViewer(token);
        await saveProviderKey('github', token);
        await refreshGithub();
        setOverlay(null);
        addNotice(
          `GitHub connected as ${viewer.login}. Try “create a private repo for this project and upload everything”.`,
          'success'
        );
      } catch (error) {
        addNotice(`GitHub token not saved: ${errorMessage(error)}`, 'error');
      } finally {
        setActivity(null);
      }
    },
    [addNotice, refreshGithub]
  );

  const chooseModel = useCallback(
    async (providerId: string, modelId: string) => {
      setOverlay(null);
      try {
        const next = await updateConfig({ provider: providerId, model: modelId });
        setConfig(next);
        setSession((current) => ({ ...current, provider: providerId, model: modelId }));
        sessionRef.current = { ...sessionRef.current, provider: providerId, model: modelId };
        try {
          await resolveProvider({ catalog, config: next, providerId });
        } catch (error) {
          addNotice(describeError(error), 'warning');
          const provider = providerById(catalog, providerId);
          if (provider && providerHasEndpoint(provider, next)) {
            const status = credentials.get(providerId);
            if (!status?.configured) promptForKey(provider, 'chat');
          }
        }
      } catch (error) {
        addNotice(`Could not switch model: ${errorMessage(error)}`, 'error');
      }
    },
    [addNotice, catalog, credentials, promptForKey]
  );

  const selectProvider = useCallback(
    (provider: CatalogProvider) => {
      if (!providerHasEndpoint(provider, configRef.current)) {
        addNotice(
          `${provider.name} needs a custom endpoint. Add providers.${provider.id}.baseURL to your SurfCode config, then restart.`,
          'warning'
        );
        setOverlay(null);
        return;
      }
      if (!localAvailable(provider, configRef.current)) {
        addNotice(
          `${provider.name} is not responding. Start the local server${provider.api ? ` at ${provider.api.replace(/\/v1\/?$/, '')}` : ''}, then reopen /provider. If it lives at a different URL, set providers.${provider.id}.baseURL in your config.`,
          'warning'
        );
        setOverlay(null);
        return;
      }
      const status = credentials.get(provider.id);
      if (!status?.configured) {
        promptForKey(provider, 'models');
        return;
      }
      if (Object.keys(provider.models).length === 0) {
        addNotice(
          `No models found for ${provider.name}. ${provider.local ? 'Start the local server and reopen /model.' : 'Add a model or check your endpoint.'}`,
          'warning'
        );
        setOverlay(null);
        return;
      }
      showModelPicker(provider.id);
    },
    [addNotice, credentials, promptForKey, showModelPicker]
  );

  const openSessions = useCallback(async () => {
    try {
      const list = await listSessions({ limit: 100 });
      setSessions(list);
      setOverlay({ kind: 'sessions', query: '', selected: 0 });
    } catch (error) {
      addNotice(`Could not list sessions: ${errorMessage(error)}`, 'error');
    }
  }, [addNotice]);

  const resumeSession = useCallback(
    async (record: SessionRecord) => {
      setOverlay(null);
      try {
        if (sessionRef.current.messages.length > 0) await saveSession(sessionRef.current);
      } catch {
        // Best effort.
      }
      setSession(record);
      sessionRef.current = record;
      setTimeline(timelineFromMessages(record.messages));
      setScrollOffset(0);
      setLive(null);
      liveRef.current = null;
      setActivity(null);
      setConfig((current) => ({
        ...current,
        provider: record.provider || current.provider,
        model: record.model || current.model,
        mode: record.mode
      }));
      if (record.provider && record.model) {
        void updateConfig({ provider: record.provider, model: record.model, mode: record.mode }).then(setConfig);
      }
    },
    []
  );

  const quit = useCallback(async () => {
    if (quitting.current) return;
    quitting.current = true;
    abortRef.current?.abort();
    const current = sessionRef.current;
    let saved = false;
    if (current.messages.length > 0) {
      try {
        await saveSession(current);
        saved = true;
      } catch {
        // Never trap the user because a save failed.
      }
    }
    onExit?.(current, saved);
    exit();
  }, [exit, onExit]);

  const handleCtrlC = useCallback(() => {
    const current = overlayRef.current;
    if (current?.kind === 'permission') {
      setOverlay(null);
      current.resolve('deny');
      setStopping(true);
      abortRef.current?.abort();
      return;
    }
    if (current?.kind === 'themes') {
      setThemeName(current.original);
      setOverlay(null);
      return;
    }
    if (current) {
      setOverlay(null);
      return;
    }
    if (activityRef.current) {
      setStopping(true);
      abortRef.current?.abort();
      return;
    }
    if (input.length > 0) {
      clearInput();
      return;
    }
    if (ctrlCArmed) {
      void quit();
      return;
    }
    setCtrlCArmed(true);
    if (ctrlCTimer.current) clearTimeout(ctrlCTimer.current);
    ctrlCTimer.current = setTimeout(() => setCtrlCArmed(false), 1600);
  }, [clearInput, ctrlCArmed, input.length, quit]);

  const answerPermission = useCallback(
    (decision: PermissionDecision) => {
      const current = overlayRef.current;
      if (current?.kind !== 'permission') return;
      setOverlay(null);
      if (decision === 'always') {
        const permissions = permissionsRef.current;
        if (permissions) permissions[current.request.action] = 'allow';
        void updateConfig({
          permissions: {
            ...configRef.current.permissions,
            [current.request.action]: 'allow'
          }
        }).then(setConfig).catch(() => {});
      }
      current.resolve(decision);
    },
    []
  );

  const requestPermission = useCallback((request: PermissionRequest) => {
    return new Promise<PermissionDecision>((resolvePermission) => {
      setOverlay({ kind: 'permission', request, resolve: resolvePermission });
    });
  }, []);

  const refreshCurrentFromDisk = useCallback(async () => {
    try {
      const current = await loadSession(sessionRef.current.id);
      if (!current || current.updatedAt <= sessionRef.current.updatedAt) return false;
      setSession(current);
      sessionRef.current = current;
      setTimeline(timelineFromMessages(current.messages));
      setScrollOffset(0);
      setLive(null);
      liveRef.current = null;
      return true;
    } catch {
      return false;
    }
  }, []);

  const syncNow = useCallback(
    async (direction: 'both' | 'push' | 'pull' = 'both', quiet = false) => {
      const sync = resolveSyncSettings(configRef.current);
      if (!sync.enabled) {
        if (!quiet) {
          addNotice('Session sync is disabled. Run `surf sync setup --url <url> --token <token>`.', 'warning');
        }
        return undefined;
      }
      if (!quiet && activityRef.current) {
        addNotice('Finish or stop the current turn before syncing.', 'warning');
        return undefined;
      }
      if (syncInFlight.current) {
        if (!quiet) addNotice('A sync is already running.', 'info');
        return undefined;
      }
      syncInFlight.current = true;
      if (!quiet) setActivity({ kind: 'sync', label: 'syncing sessions' });
      try {
        const result = await syncSessions({ config: configRef.current, direction });
        await updateConfigPath(['sync', 'cursor'], result.cursor);
        // Write only the cursor and timestamp: a token supplied through the
        // environment must never be copied into config.json.
        const nextConfig = await updateConfigPath(['sync', 'lastSyncAt'], Date.now());
        setConfig(nextConfig);
        if (!quiet) {
          const refreshed = await refreshCurrentFromDisk();
          const suffix = refreshed ? ' · refreshed current session' : '';
          addNotice(
            `Sync complete: ${result.accepted} pushed · ${result.pulled} pulled${suffix}`,
            'success'
          );
        } else if (!activityRef.current) {
          // Background auto-sync may have received a newer copy of the open
          // session. Only adopt it while idle, never during an active turn.
          await refreshCurrentFromDisk();
        }
        return result;
      } catch (error) {
        if (!quiet) addNotice(`Sync failed: ${errorMessage(error)}`, 'error');
        return undefined;
      } finally {
        syncInFlight.current = false;
        setStopping(false);
        if (!quiet) setActivity(null);
      }
    },
    [addNotice, refreshCurrentFromDisk]
  );

  const autoSync = useCallback(() => {
    const sync = resolveSyncSettings(configRef.current);
    if (!sync.enabled || !sync.auto) return;
    void syncNow('both', true);
  }, [syncNow]);

  const persistSession = useCallback(
    async (next: SessionRecord) => {
      try {
        await saveSession(next);
        autoSync();
      } catch (error) {
        addNotice(`Could not save session: ${errorMessage(error)}`, 'error');
      }
    },
    [addNotice, autoSync]
  );

  const executeTurn = useCallback(
    async (text: string, selection: ResolvedSelection) => {
      const controller = new AbortController();
      abortRef.current = controller;
      setStopping(false);
      const startedAt = Date.now();
      const initialLive: LiveMessage = {
        content: '',
        reasoning: '',
        tools: [],
        startedAt,
        thinkingStartedAt: startedAt,
        thinkingMs: 0,
        step: 1,
        phase: 'thinking'
      };
      liveRef.current = initialLive;
      setLive(initialLive);
      setRunUsage(emptyUsage());
      setActivity({ kind: 'agent', label: 'thinking' });

      const permissions: Record<PermissionAction, PermissionMode> = configRef.current.fullAccess
        ? { read: 'allow', write: 'allow', shell: 'allow', fetch: 'allow' }
        : { ...configRef.current.permissions };
      permissionsRef.current = permissions;
      const historyLength = sessionRef.current.messages.length;

      let delegates: AgentDelegate[] | undefined;
      if (configRef.current.agents.enabled) {
        if (configRef.current.agents.workers.length === 0) {
          addNotice('Agent mode is on but has no workers. Add one with /agent add provider/model.', 'warning');
        } else {
          const resolved = await resolveAgentWorkers(catalog, configRef.current);
          delegates = resolved.delegates;
          if (resolved.failures.length > 0) {
            addNotice(`Agent workers skipped:\n${resolved.failures.join('\n')}`, 'warning');
          }
        }
      }

      try {
        const outcome = await runAgent({
          cwd,
          provider: selection.provider,
          model: selection.model,
          history: sessionRef.current.messages,
          input: text,
          mode: configRef.current.mode,
          tools: createTools(),
          permissions,
          maxSteps: configRef.current.maxSteps,
          maxTokens: configRef.current.maxTokens ?? Math.min(selection.model.maxOutput || 8192, 32_768),
          temperature: configRef.current.temperature,
          effort: activeEffort(configRef.current.effort),
          showReasoning: configRef.current.showReasoning,
          delegates,
          allowOutsideWorkspace: configRef.current.fullAccess || configRef.current.allowOutsideWorkspace,
          signal: controller.signal,
          callbacks: {
            onText(delta) {
              const current = liveRef.current;
              if (!current) return;
              current.content += delta;
              if (current.phase !== 'writing') current.phase = 'writing';
            },
            onReasoning(delta) {
              const current = liveRef.current;
              if (!current) return;
              current.reasoning += delta;
              if (!current.content && !current.preamble) current.phase = 'thinking';
            },
            onToolStart(call) {
              const current = liveRef.current;
              if (!current) return;
              if (current.content) {
                current.preamble = current.preamble
                  ? `${current.preamble}\n\n${current.content}`
                  : current.content;
                current.content = '';
              }
              current.tools.push({ call, pending: true });
              current.phase = 'tool';
              current.activeTool = call.name;
            },
            onToolResult(call, result, durationMs) {
              const current = liveRef.current;
              if (!current) return;
              const view = current.tools.find((entry) => entry.call.id === call.id);
              if (view) {
                view.result = result;
                view.durationMs = durationMs;
                view.pending = false;
              }
              current.phase = 'writing';
              current.activeTool = undefined;
            },
            onUsage(total) {
              setRunUsage({ ...total });
            },
            onStep(step) {
              const current = liveRef.current;
              if (current) current.step = step;
            },
            requestPermission
          }
        });

        const newMessages = outcome.messages.slice(historyLength);
        // Hand the streamed reply over to the timeline in a single React batch.
        // Persisting the session awaits I/O, and if `live` were only cleared in
        // `finally` Ink can paint a frame that shows both the finalized item and
        // the live copy, making the assistant reply appear twice.
        liveRef.current = null;
        setLive(null);
        setTimeline((items) =>
          appendAssistant(items, newMessages, startedAt, selection.model.name)
        );
        const nextUsage = addSessionUsage(sessionRef.current.usage, outcome.usage);
        const nextSession: SessionRecord = {
          ...sessionRef.current,
          provider: selection.provider.id,
          model: selection.model.id,
          mode: configRef.current.mode,
          messages: outcome.messages,
          usage: nextUsage
        };
        setSession(nextSession);
        sessionRef.current = nextSession;
        await persistSession(nextSession);
        if (outcome.aborted) addNotice('Stopped.', 'warning');
      } catch (error) {
        const message = describeError(error);
        const current = liveRef.current;
        if (current && (current.content || current.preamble || current.reasoning || current.tools.length > 0)) {
          noticeCounter.current += 1;
          setTimeline((items) => [
            ...items,
            {
              id: `failed_${Date.now()}_${noticeCounter.current}`,
              type: 'assistant',
              content: current.content,
              preamble: current.preamble,
              reasoning: current.reasoning || undefined,
              toolViews: current.tools
            }
          ]);
        }
        addNotice(message, 'error');
      } finally {
        abortRef.current = null;
        permissionsRef.current = null;
        liveRef.current = null;
        setLive(null);
        setStopping(false);
        setActivity(null);
        setRunUsage(emptyUsage());
      }
    },
    [addNotice, catalog, cwd, persistSession, requestPermission]
  );

  const startBtw = useCallback(
    async (question: string) => {
      const text = question.trim();
      if (!text) {
        addNotice('Usage: /btw <question>', 'warning');
        return;
      }
      if (!configRef.current.provider || !configRef.current.model) {
        addNotice('No model connected. Choose a provider before asking a side question.', 'warning');
        return;
      }

      let selection: ResolvedSelection;
      try {
        selection = await resolveSelection(catalog, configRef.current, {
          provider: configRef.current.provider,
          model: configRef.current.model
        });
      } catch (error) {
        addNotice(describeError(error), 'error');
        return;
      }

      btwAbortRef.current?.abort();
      const controller = new AbortController();
      btwAbortRef.current = controller;
      const id = btwCounter.current + 1;
      btwCounter.current = id;
      const state: BtwState = {
        id,
        question: text,
        answer: '',
        reasoning: '',
        startedAt: Date.now(),
        done: false
      };
      btwRef.current = state;
      setBtw(state);
      setOverlay({ kind: 'btw' });
      setScrollOffset(0);

      const system = `You are SurfCode answering a quick side question about the current coding session.
Workspace: ${cwd}
Model: ${selection.provider.name} / ${selection.model.name}

This is an ephemeral /btw exchange. Use the conversation transcript as context.
No tools are available: do not read files, run commands, or claim that you did.
Answer the question directly and concisely in GitHub-flavored Markdown. This exchange will not be saved.`;

      try {
        const result = await streamChat({
          provider: selection.provider,
          model: selection.model,
          messages: [...sessionRef.current.messages, { role: 'user', content: text }],
          system,
          tools: [],
          options: {
            signal: controller.signal,
            maxTokens: Math.min(configRef.current.maxTokens ?? 4_096, 8_192),
            temperature: configRef.current.temperature,
            effort: activeEffort(configRef.current.effort),
            showReasoning: configRef.current.showReasoning,
            timeout: selection.provider.settings.timeout
          },
          callbacks: {
            onText(delta) {
              if (btwRef.current?.id === id) btwRef.current.answer += delta;
            },
            onReasoning(delta) {
              if (btwRef.current?.id === id) btwRef.current.reasoning += delta;
            }
          }
        });

        if (btwRef.current?.id !== id) return;
        const final: BtwState = {
          ...btwRef.current,
          answer: result.text || btwRef.current.answer,
          reasoning: result.reasoning || btwRef.current.reasoning,
          done: true
        };
        btwRef.current = final;
        setBtw(final);
      } catch (error) {
        if (btwRef.current?.id !== id) return;
        if (controller.signal.aborted) {
          btwRef.current = null;
          setBtw(null);
          setOverlay((current) => (current?.kind === 'btw' ? null : current));
          return;
        }
        const final: BtwState = {
          ...btwRef.current,
          done: true,
          error: describeError(error)
        };
        btwRef.current = final;
        setBtw(final);
      } finally {
        if (btwAbortRef.current === controller) btwAbortRef.current = null;
      }
    },
    [addNotice, catalog, cwd]
  );

  const sendPrompt = useCallback(
    async (raw: string, options: { clear?: boolean } = {}) => {
      const text = raw.trim();
      if (!text) return;
      if (activityRef.current) {
        addNotice('Still working. Press esc to stop first.', 'warning');
        return;
      }
      if (!configRef.current.provider || !configRef.current.model) {
        addNotice('No model connected. Choose a provider to begin.', 'warning');
        showProviderPicker('connect');
        return;
      }

      let selection: ResolvedSelection;
      try {
        selection = await resolveSelection(catalog, configRef.current, {
          provider: configRef.current.provider,
          model: configRef.current.model
        });
      } catch (error) {
        addNotice(describeError(error), 'error');
        const provider = configRef.current.provider
          ? providerById(catalog, configRef.current.provider)
          : undefined;
        if (provider && providerHasEndpoint(provider, configRef.current)) {
          const status = credentials.get(provider.id);
          if (!status?.configured) promptForKey(provider, 'chat');
        }
        return;
      }

      if (options.clear !== false) clearInput();
      setHistory((current) => [...current.filter((entry) => entry !== text).slice(-49), text]);
      setHistoryIndex(-1);
      setScrollOffset(0);
      noticeCounter.current += 1;
      setTimeline((items) => [
        ...items,
        { id: `user_${Date.now()}_${noticeCounter.current}`, type: 'user', content: text }
      ]);
      void executeTurn(text, selection);
    },
    [
      addNotice,
      catalog,
      clearInput,
      credentials,
      executeTurn,
      promptForKey,
      showProviderPicker
    ]
  );

  const initialPromptSent = useRef(false);
  useEffect(() => {
    const prompt = initialPrompt?.trim();
    if (!prompt || initialPromptSent.current) return;
    initialPromptSent.current = true;
    const timer = setTimeout(() => {
      void sendPrompt(prompt);
    }, 120);
    return () => clearTimeout(timer);
  }, [initialPrompt, sendPrompt]);

  const runShell = useCallback(
    async (command: string) => {
      if (activityRef.current) {
        addNotice('Still working. Press esc to stop first.', 'warning');
        return;
      }
      const controller = new AbortController();
      abortRef.current = controller;
      setStopping(false);
      const callId = `shell_${Date.now().toString(36)}`;
      const call = { id: callId, name: 'bash', arguments: { command } };
      noticeCounter.current += 1;
      const itemId = `shell_item_${noticeCounter.current}`;
      setTimeline((items) => [
        ...items,
        {
          id: itemId,
          type: 'assistant',
          content: '',
          toolViews: [{ call, pending: true }]
        }
      ]);
      setActivity({ kind: 'shell', label: 'running command' });
      setScrollOffset(0);
      const startedAt = Date.now();
      try {
        const result = await shellTool.execute(
          { command },
          {
            cwd,
            signal: controller.signal,
            allowOutsideWorkspace: configRef.current.fullAccess || configRef.current.allowOutsideWorkspace,
            planMode: false,
            requestPermission: async () => 'allow'
          }
        );
        const durationMs = Date.now() - startedAt;
        setTimeline((items) =>
          items.map((item) =>
            item.id === itemId
              ? { ...item, toolViews: [{ call, result, durationMs, pending: false }] }
              : item
          )
        );
        const assistant: ChatMessage = { role: 'assistant', content: '', toolCalls: [call] };
        const toolMessage: ChatMessage = {
          role: 'tool',
          toolCallId: callId,
          name: 'bash',
          content: result.output,
          ...(result.isError ? { isError: true } : {})
        };
        const nextSession: SessionRecord = {
          ...sessionRef.current,
          messages: [...sessionRef.current.messages, assistant, toolMessage]
        };
        setSession(nextSession);
        sessionRef.current = nextSession;
        await persistSession(nextSession);
      } catch (error) {
        if (controller.signal.aborted) {
          setTimeline((items) =>
            items.map((item) =>
              item.id === itemId
                ? {
                    ...item,
                    toolViews: [
                      {
                        call,
                        result: { output: 'Cancelled by user.', isError: true },
                        pending: false
                      }
                    ]
                  }
                : item
            )
          );
          addNotice('Shell command stopped.', 'warning');
        } else {
          setTimeline((items) => items.filter((item) => item.id !== itemId));
          addNotice(`Shell command failed: ${errorMessage(error)}`, 'error');
        }
      } finally {
        abortRef.current = null;
        setStopping(false);
        setActivity(null);
      }
    },
    [addNotice, cwd, persistSession]
  );

  const compact = useCallback(async () => {
    if (activityRef.current) return;
    if (sessionRef.current.messages.length < 4) {
      addNotice('Not enough conversation to compact yet.', 'info');
      return;
    }
    if (!configRef.current.provider || !configRef.current.model) {
      addNotice('Connect a model before compacting.', 'warning');
      return;
    }
    let selection: ResolvedSelection;
    try {
      selection = await resolveSelection(catalog, configRef.current, {
        provider: configRef.current.provider,
        model: configRef.current.model
      });
    } catch (error) {
      addNotice(describeError(error), 'error');
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setStopping(false);
    setActivity({ kind: 'compact', label: 'compacting context' });
    try {
      const result = await compactConversation({
        provider: selection.provider,
        model: selection.model,
        messages: sessionRef.current.messages,
        signal: controller.signal
      });
      const summaryMessage: ChatMessage = {
        role: 'assistant',
        content: `## Session summary\n\n${result.summary}`
      };
      const nextUsage = addSessionUsage(sessionRef.current.usage, {
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
        reasoningTokens: result.usage.reasoningTokens ?? 0,
        cacheReadTokens: result.usage.cacheReadTokens ?? 0,
        cacheWriteTokens: result.usage.cacheWriteTokens ?? 0,
        cost: result.usage.cost ?? 0,
        requests: 1
      });
      const count = sessionRef.current.messages.length;
      const nextSession: SessionRecord = {
        ...sessionRef.current,
        messages: [summaryMessage],
        usage: nextUsage
      };
      setSession(nextSession);
      sessionRef.current = nextSession;
      await persistSession(nextSession);
      addNotice(`Compacted ${count} messages into one summary.`, 'success');
    } catch (error) {
      if (controller.signal.aborted) addNotice('Compaction stopped.', 'warning');
      else addNotice(`Compaction failed: ${errorMessage(error)}`, 'error');
    } finally {
      abortRef.current = null;
      setStopping(false);
      setActivity(null);
    }
  }, [addNotice, catalog, persistSession]);

  const exportSession = useCallback(
    async (pathArg?: string) => {
      try {
        const target = pathArg?.trim()
          ? resolve(cwd, pathArg.trim())
          : join(cwd, `surfcode-${sessionRef.current.id}.md`);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, transcriptMarkdown(sessionRef.current), { encoding: 'utf8', mode: 0o644 });
        const shown = relative(cwd, target) || target;
        addNotice(`Exported transcript to ${shown}`, 'success');
      } catch (error) {
        addNotice(`Export failed: ${errorMessage(error)}`, 'error');
      }
    },
    [addNotice, cwd]
  );

  const handleAgentCommand = useCallback(
    async (argument: string) => {
      const parts = argument.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? 'status').toLowerCase();
      const rest = parts.slice(1).join(' ').trim();
      const current = configRef.current.agents;
      const head = `${configRef.current.provider ?? 'none'}/${configRef.current.model ?? 'none'}`;
      const describe = () =>
        `Agent mode: ${current.enabled ? 'on' : 'off'}\n` +
        `Head: ${head}\n` +
        (current.workers.length
          ? `Workers:\n${current.workers.map((worker, index) => `  ${index + 1}. ${workerLabel(worker)}`).join('\n')}`
          : 'Workers: none · add one with /agent add provider/model');

      if (sub === 'status' || sub === 'list') {
        addNotice(describe(), 'info');
        return;
      }

      if (sub === 'on' || sub === 'off') {
        const enabled = sub === 'on';
        if (enabled && current.workers.length === 0) {
          addNotice('Add a worker first: /agent add provider/model', 'warning');
          return;
        }
        await updateSetting(
          { agents: { ...current, enabled } },
          enabled
            ? `Agent mode on · head ${head} · ${current.workers.length} worker${current.workers.length === 1 ? '' : 's'}`
            : 'Agent mode off.'
        );
        return;
      }

      if (sub === 'add') {
        const worker = parseWorkerRef(rest);
        if (!worker) {
          addNotice('Usage: /agent add provider/model', 'warning');
          return;
        }
        if (!providerById(catalog, worker.provider) || !findModel(catalog, worker.provider, worker.model)) {
          addNotice(`Unknown model reference: ${workerLabel(worker)}. Try /model to find an id.`, 'warning');
          return;
        }
        if (current.workers.some((entry) => entry.provider === worker.provider && entry.model === worker.model)) {
          addNotice(`${workerLabel(worker)} is already a worker.`, 'info');
          return;
        }
        if (current.workers.length >= 8) {
          addNotice('Agent mode supports up to 8 workers.', 'warning');
          return;
        }
        const workers = [...current.workers, worker];
        const enabled = current.enabled || workers.length === 1;
        await updateSetting(
          { agents: { enabled, workers } },
          `Added ${workerLabel(worker)} as a worker${enabled ? ' · agent mode on' : ''}.`
        );
        return;
      }

      if (sub === 'remove' || sub === 'rm') {
        if (!rest) {
          addNotice('Usage: /agent remove provider/model or /agent remove 2', 'warning');
          return;
        }
        const index = Number(rest) - 1;
        const target =
          Number.isInteger(index) && index >= 0 && index < current.workers.length
            ? current.workers[index]
            : parseWorkerRef(rest);
        if (!target) {
          addNotice(`No worker matches "${rest}".`, 'warning');
          return;
        }
        const workers = current.workers.filter(
          (entry) => entry.provider !== target.provider || entry.model !== target.model
        );
        if (workers.length === current.workers.length) {
          addNotice(`${workerLabel(target)} is not a worker.`, 'warning');
          return;
        }
        await updateSetting(
          { agents: { enabled: workers.length > 0 && current.enabled, workers } },
          `Removed ${workerLabel(target)}.`
        );
        return;
      }

      if (sub === 'clear') {
        await updateSetting({ agents: { enabled: false, workers: [] } }, 'Agent workers cleared.');
        return;
      }

      if (sub === 'head') {
        if (!rest) {
          addNotice(`Head model: ${head}\nChange it with /agent head provider/model or /model.`, 'info');
          return;
        }
        const direct = findDirectModel(rest, catalog, configRef.current.provider);
        if (!direct) {
          addNotice(`Unknown model reference: ${rest}.`, 'warning');
          return;
        }
        await chooseModel(direct.provider, direct.model);
        addNotice(`Head model: ${direct.provider}/${direct.model}`, 'success');
        return;
      }

      addNotice(
        'Usage: /agent [status|on|off|add provider/model|remove <n|provider/model>|list|clear|head provider/model]',
        'warning'
      );
    },
    [addNotice, catalog, chooseModel, updateSetting]
  );

  const handleGithubCommand = useCallback(
    async (argument: string) => {
      const trimmed = argument.trim();
      const sub = (trimmed.split(/\s+/)[0] || 'status').toLowerCase();
      if (sub === 'login') {
        if (trimmed !== 'login') {
          addNotice(
            'For safety, run /github login with no token in the command. Paste the token into the hidden prompt instead.',
            'warning'
          );
          return;
        }
        openGithubLogin();
        return;
      }
      if (sub === 'logout') {
        const removed = await removeProviderKey('github');
        await refreshGithub();
        const remaining = await githubTokenStatus();
        addNotice(
          `${removed ? 'Removed the saved GitHub token.' : 'No saved GitHub token to remove.'}` +
            (remaining.configured
              ? `\n${remaining.envName ?? 'An environment token'} is still configured and will keep working.`
              : ''),
          remaining.configured ? 'warning' : 'success'
        );
        return;
      }
      if (sub === 'status' || trimmed === '') {
        const status = await githubTokenStatus();
        if (!status.configured) {
          addNotice(
            'GitHub is not connected.\nRun /github login and paste a personal access token. The token is stored in auth.json with mode 600.\nGITHUB_TOKEN or GH_TOKEN also works.',
            'info'
          );
          return;
        }
        addNotice(
          `GitHub token: ${status.source === 'env' ? status.envName : 'auth.json'} · ${status.masked ?? 'saved'}\n` +
            'Ask the agent to create a private or public repo, upload the project, or commit changes.\n' +
            'The agent can never see the token; git uses a temporary askpass helper. Use /github logout to disconnect.',
          'success'
        );
        return;
      }
      addNotice('Usage: /github [status|login|logout]', 'warning');
    },
    [addNotice, openGithubLogin, refreshGithub]
  );

  const handleCommand = useCallback(
    async (name: string, arg: string) => {
      const argument = arg.trim();
      switch (name) {
        case 'model': {
          if (argument) {
            const direct = findDirectModel(argument, catalog, configRef.current.provider);
            if (direct) {
              await chooseModel(direct.provider, direct.model);
              return;
            }
          }
          showModelPicker(undefined, argument);
          return;
        }
        case 'connect':
          showProviderPicker('connect');
          return;
        case 'provider':
          showProviderPicker('switch');
          return;
        case 'explorer': {
          if (argument) {
            const requested = Number.parseInt(argument, 10);
            if (!Number.isFinite(requested)) {
              addNotice('Usage: /explorer [width in columns]', 'warning');
              return;
            }
            const next = clampExplorerWidth(requested, size.columns);
            await updateSetting({ explorerWidth: next }, `Explorer width: ${next} columns.`);
          }
          focusExplorer();
          return;
        }
        case 'options':
        case 'settings':
          setOverlay({ kind: 'settings', selected: 0 });
          void refreshGithub();
          return;
        case 'github':
          await handleGithubCommand(argument);
          return;
        case 'theme': {
          if (argument) {
            const wanted = THEMES.find(
              (entry) =>
                entry.name === argument.toLowerCase() || entry.label.toLowerCase() === argument.toLowerCase()
            );
            if (wanted) {
              setThemeName(wanted.name);
              await updateSetting({ theme: wanted.name }, `Theme set to ${wanted.label}.`);
            } else {
              addNotice(`Unknown theme "${argument}". Try ${THEMES.map((entry) => entry.name).join(', ')}.`, 'warning');
            }
          } else {
            setOverlay({ kind: 'themes', selected: Math.max(0, THEMES.findIndex((entry) => entry.name === theme.name)), original: theme.name });
          }
          return;
        }
        case 'effort': {
          if (!argument) {
            addNotice(
              `Reasoning effort: ${effortLabel(configRef.current.effort)}\n` +
                'Use /effort low, /effort medium, /effort high, or /effort auto.',
              'info'
            );
            return;
          }
          const level = parseEffort(argument);
          if (!level) {
            addNotice(`Unknown effort "${argument}". Use low, medium, high, or auto.`, 'warning');
            return;
          }
          await updateSetting(
            { effort: level },
            `Reasoning effort: ${effortLabel(level)}.`
          );
          return;
        }
        case 'thinking':
          await updateSetting(
            { showReasoning: !configRef.current.showReasoning },
            configRef.current.showReasoning ? 'Reasoning hidden.' : 'Reasoning visible.'
          );
          return;
        case 'stream': {
          const normalized = argument.toLowerCase();
          const next =
            normalized === 'on' || normalized === 'true' || normalized === '1'
              ? true
              : normalized === 'off' || normalized === 'false' || normalized === '0'
                ? false
                : !configRef.current.streaming;
          await updateSetting(
            { streaming: next },
            next
              ? 'Live streaming on · replies paint as tokens arrive.'
              : 'Live streaming off · replies appear when complete. Faster and calmer.'
          );
          return;
        }
        case 'access': {
          const normalized = argument.toLowerCase();
          if (!normalized) {
            addNotice(
              configRef.current.fullAccess
                ? 'Full computer access is ON. Tool approvals are bypassed and paths outside the workspace are allowed.\nUse /access safe to turn it off.'
                : 'Full computer access is OFF. Tools use the normal permission policy.\nUse /access full to allow everything for this machine.',
              configRef.current.fullAccess ? 'warning' : 'info'
            );
            return;
          }
          if (normalized !== 'full' && normalized !== 'safe') {
            addNotice('Usage: /access full | /access safe', 'warning');
            return;
          }
          const fullAccess = normalized === 'full';
          await updateSetting(
            { fullAccess },
            fullAccess
              ? 'FULL ACCESS ON · every tool action is approved automatically, including paths outside this workspace. Use /access safe to stop.'
              : 'Full access off · normal permissions restored.'
          );
          return;
        }
        case 'agent':
          await handleAgentCommand(argument);
          return;
        case 'verbose':
          await updateSetting(
            { verboseTools: !configRef.current.verboseTools },
            configRef.current.verboseTools ? 'Tool output collapsed.' : 'Tool output expanded.'
          );
          return;
        case 'plan':
          await setMode('plan', true);
          return;
        case 'build':
          await setMode('build', true);
          return;
        case 'clear':
          setTimeline([]);
          setScrollOffset(0);
          return;
        case 'new': {
          if (sessionRef.current.messages.length > 0) {
            try {
              await saveSession(sessionRef.current);
            } catch {
              // Keep going.
            }
          }
          const next = createSession({
            cwd,
            provider: configRef.current.provider ?? '',
            model: configRef.current.model ?? '',
            mode: configRef.current.mode
          });
          setSession(next);
          sessionRef.current = next;
          setTimeline([]);
          setScrollOffset(0);
          setLive(null);
          liveRef.current = null;
          setRunUsage(emptyUsage());
          return;
        }
        case 'sessions':
          await openSessions();
          return;
        case 'sync': {
          const direction =
            argument === 'push' ? 'push' : argument === 'pull' ? 'pull' : 'both';
          await syncNow(direction);
          return;
        }
        case 'stop':
          if (activityRef.current?.kind === 'sync') {
            addNotice('Sync is already finishing.', 'info');
          } else if (activityRef.current) {
            setStopping(true);
            abortRef.current?.abort();
          } else {
            addNotice('Nothing is running.', 'info');
          }
          return;
        case 'compact':
          await compact();
          return;
        case 'btw':
          await startBtw(argument);
          return;
        case 'context': {
          const used = estimateContextTokens(sessionRef.current.messages, '') + 600;
          const pct = contextWindow > 0 ? Math.round((used / contextWindow) * 100) : 0;
          addNotice(
            `Context ~${formatTokens(used)} / ${formatTokens(contextWindow)} tokens (${pct}%)\n` +
              `${sessionRef.current.messages.length} messages · ${activeProviderId ?? 'no provider'}/${activeModelName || 'no model'}\n` +
              (pct > 85 ? 'Consider /compact to free space.' : 'Plenty of room.'),
            pct > 85 ? 'warning' : 'info'
          );
          return;
        }
        case 'cost': {
          const usage = sessionRef.current.usage;
          addNotice(
            `Session cost ${formatCost(usage.cost)}\n` +
              `${formatTokens(usage.inputTokens)} input · ${formatTokens(usage.outputTokens)} output · ${usage.requests} requests\n` +
              (usage.cacheReadTokens ? `${formatTokens(usage.cacheReadTokens)} cached input tokens` : formatPrice(activeModelMeta)),
            'info'
          );
          return;
        }
        case 'export':
          await exportSession(argument || undefined);
          return;
        case 'init':
          await sendPrompt(
            'Analyze this repository and create a SURFCODE.md file at the workspace root. ' +
              'Cover the project purpose, architecture, key directories, important commands, conventions, and ' +
              'anything a new engineer must know. Read the actual files first; do not guess. Keep it under 150 lines.',
            { clear: false }
          );
          return;
        case 'help':
          setOverlay({ kind: 'help' });
          return;
        case 'quit':
          await quit();
          return;
        default:
          addNotice(`Unknown command "/${name}". Try /help.`, 'warning');
      }
    },
    [
      activeModelMeta,
      activeModelName,
      activeProviderId,
      addNotice,
      catalog,
      chooseModel,
      compact,
      contextWindow,
      cwd,
      exportSession,
      handleAgentCommand,
      handleGithubCommand,
      focusExplorer,
      openSessions,
      quit,
      refreshGithub,
      sendPrompt,
      setMode,
      showModelPicker,
      showProviderPicker,
      size.columns,
      startBtw,
      syncNow,
      theme.name,
      updateSetting
    ]
  );

  const submit = useCallback((draft?: string) => {
    const value = draft ?? inputRef.current;
    if (!value.trim()) return;
    const trimmed = value.trim();
    if (trimmed.startsWith('/')) {
      const match = /^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/.exec(trimmed);
      if (!match) {
        addNotice('Commands look like /model or /help.', 'warning');
        return;
      }
      const name = match[1]!.toLowerCase();
      const arg = match[2] ?? '';
      clearInput();
      void handleCommand(name, arg);
      return;
    }
    if (trimmed.startsWith('!')) {
      const command = trimmed.slice(1).trim();
      if (!command) {
        addNotice('Type a shell command after !', 'warning');
        return;
      }
      clearInput();
      setHistory((current) => [...current.filter((entry) => entry !== trimmed).slice(-49), trimmed]);
      void runShell(command);
      return;
    }
    void sendPrompt(value);
  }, [addNotice, clearInput, handleCommand, runShell, sendPrompt]);

  const completeSuggestion = useCallback(
    (suggestion: Suggestion | undefined) => {
      if (!suggestion) return;
      if (suggestion.kind === 'command') {
        setInputValue(suggestion.complete);
        return;
      }
      const before = input.slice(0, cursor);
      const tokenStart = before.lastIndexOf('@');
      if (tokenStart === -1) return;
      const after = input.slice(cursor);
      setInputValue(`${input.slice(0, tokenStart)}@${suggestion.complete} ${after}`);
    },
    [cursor, input, setInputValue]
  );

  const pasteClipboard = useCallback(
    async (target: 'key' | 'input') => {
      const raw = await readClipboard();
      if (raw === undefined) {
        addNotice('Could not read the clipboard. Try your terminal paste shortcut (ctrl+shift+v).', 'warning');
        return;
      }
      if (target === 'key') {
        const current = overlayRef.current;
        if (current?.kind !== 'connect-key' && current?.kind !== 'github-key') return;
        const clean = raw.replace(/[\r\n]+/g, '').replace(/[\x00-\x1f\x7f]/g, '').trim();
        if (!clean) return;
        setOverlay({
          ...current,
          value: current.value.slice(0, current.cursor) + clean + current.value.slice(current.cursor),
          cursor: current.cursor + clean.length
        });
        return;
      }
      if (overlayRef.current) return;
      const clean = raw
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\t/g, '  ')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
      if (!clean) return;
      const value = inputRef.current;
      const at = cursorRef.current;
      setInputValue(`${value.slice(0, at)}${clean}${value.slice(at)}`, at + clean.length);
    },
    [addNotice, setInputValue]
  );

  const modelEntries = useMemo<ModelEntry[]>(() => {
    const entries: ModelEntry[] = [];
    for (const { provider, model } of allModels(catalog)) {
      if (model.modalities?.output && !model.modalities.output.includes('text')) continue;
      if (NON_CHAT_MODEL.test(`${model.id} ${model.name}`)) continue;
      if (!localAvailable(provider, config)) continue;
      // Only show models from APIs the user has actually configured. Keep the
      // current provider visible so a transient credential refresh never makes
      // the active model vanish from the picker.
      if (!providerReady(provider, credentials, config) && provider.id !== config.provider) continue;
      entries.push({
        provider,
        model,
        score: scoreModel(model),
        search: `${provider.id} ${provider.name} ${model.id} ${model.name}`.toLowerCase()
      });
    }
    entries.sort((a, b) => {
      const aReady = providerReady(a.provider, credentials, config) ? 1 : 0;
      const bReady = providerReady(b.provider, credentials, config) ? 1 : 0;
      if (aReady !== bReady) return bReady - aReady;
      const aPriority = PROVIDER_PRIORITY.get(a.provider.id) ?? 1000;
      const bPriority = PROVIDER_PRIORITY.get(b.provider.id) ?? 1000;
      if (aPriority !== bPriority) return aPriority - bPriority;
      if (b.score !== a.score) return b.score - a.score;
      return a.provider.name.localeCompare(b.provider.name) || a.model.name.localeCompare(b.model.name);
    });
    return entries;
  }, [catalog, config, credentials]);

  const modelPickerItems = useMemo<PickerItem[]>(() => {
    if (overlay?.kind !== 'model') return [];
    const query = overlay.query.trim().toLowerCase();
    const tokens = query.split(/\s+/).filter(Boolean);
    return modelEntries
      .filter((entry) => !overlay.providerFilter || entry.provider.id === overlay.providerFilter)
      .filter((entry) => tokens.every((token) => entry.search.includes(token)))
      .slice(0, 2500)
      .map((entry) => {
        const context = entry.model.limit?.context;
        return {
          id: `${entry.provider.id}/${entry.model.id}`,
          label: entry.model.name || entry.model.id,
          badge: entry.provider.id === activeProviderId ? 'current provider' : entry.provider.id,
          right: context ? `${formatTokens(context)} ctx` : undefined,
          configured: providerReady(entry.provider, credentials, config)
        };
      });
  }, [activeProviderId, config, credentials, modelEntries, overlay]);

  const providerItems = useMemo<PickerItem[]>(() => {
    if (overlay?.kind !== 'provider') return [];
    const query = overlay.query.trim().toLowerCase();
    const tokens = query.split(/\s+/).filter(Boolean);
    const providers = [...catalog.providers].sort((a, b) => {
      const aReady = providerReady(a, credentials, config) ? 1 : 0;
      const bReady = providerReady(b, credentials, config) ? 1 : 0;
      if (aReady !== bReady) return bReady - aReady;
      return a.name.localeCompare(b.name);
    });
    return providers
      .filter((provider) => {
        const haystack = `${provider.id} ${provider.name}`.toLowerCase();
        return tokens.every((token) => haystack.includes(token));
      })
      .slice(0, 500)
      .map((provider) => {
        const endpoint = providerHasEndpoint(provider, config);
        const count = Object.keys(provider.models).length;
        return {
          id: provider.id,
          label: provider.name,
          badge: provider.custom ? 'custom' : provider.local ? 'local' : !endpoint ? 'setup' : undefined,
          freeApi: hasFreeApi(provider.id),
          right: `${count} model${count === 1 ? '' : 's'}`,
          configured: providerReady(provider, credentials, config)
        };
      });
  }, [catalog, config, credentials, overlay]);

  const sessionItems = useMemo<PickerItem[]>(() => {
    if (overlay?.kind !== 'sessions') return [];
    const query = overlay.query.trim().toLowerCase();
    return sessions
      .filter((record) => {
        if (!query) return true;
        return `${record.title} ${record.provider} ${record.model} ${record.cwd}`.toLowerCase().includes(query);
      })
      .map((record) => ({
        id: record.id,
        label: record.title || 'Untitled session',
        badge: record.id === session.id ? 'current' : undefined,
        right: `${formatAge(record.updatedAt)} · ${record.model || record.provider || 'no model'}`,
        configured: record.messages.length > 0
      }));
  }, [overlay, session.id, sessions]);

  const settingsRows = useMemo<SettingsRow[]>(
    () => [
      { id: 'theme', label: 'Theme', value: theme.label, kind: 'action' },
      { id: 'model', label: 'Model', value: activeModelName || 'not selected', kind: 'action' },
      {
        id: 'provider',
        label: 'Provider',
        value: activeProvider?.name ?? activeProviderId ?? 'not selected',
        kind: 'action'
      },
      { id: 'mode', label: 'Mode', value: config.mode, kind: 'choice' },
      { id: 'effort', label: 'Reasoning effort', value: effortLabel(config.effort), kind: 'choice' },
      { id: 'stream', label: 'Live streaming', value: config.streaming ? 'on' : 'off', kind: 'toggle' },
      {
        id: 'explorer',
        label: 'Explorer width',
        value: `${config.explorerWidth} cols`,
        kind: 'choice'
      },
      {
        id: 'thinking',
        label: 'Thinking text',
        value: config.showReasoning ? 'shown' : 'hidden',
        kind: 'toggle'
      },
      {
        id: 'tools',
        label: 'Tool output',
        value: config.verboseTools ? 'expanded' : 'compact',
        kind: 'toggle'
      },
      {
        id: 'access',
        label: 'Full computer access',
        value: config.fullAccess ? 'FULL · approvals off' : 'safe',
        kind: 'toggle'
      },
      {
        id: 'agent',
        label: 'Agent mode',
        value: config.agents.enabled ? `on · ${config.agents.workers.length} workers` : 'off',
        kind: 'toggle'
      },
      {
        id: 'github',
        label: 'GitHub',
        value: githubAuth?.configured
          ? `${githubAuth.source === 'env' ? githubAuth.envName : 'connected'} · ${githubAuth.masked ?? ''}`.trim()
          : 'not connected',
        kind: 'action'
      }
    ],
    [activeModelName, activeProvider, activeProviderId, config, githubAuth, theme]
  );

  const settingsItems = useMemo<PickerItem[]>(
    () =>
      settingsRows.map((row) => ({
        id: row.id,
        label: row.label,
        right: row.kind === 'action' ? `${row.value} ›` : row.value,
        badge: row.kind === 'toggle' ? (row.value === 'off' || row.value === 'safe' || row.value === 'hidden' || row.value === 'compact' ? undefined : 'on') : undefined
      })),
    [settingsRows]
  );

  const rawOverlaySelected = overlay && 'selected' in overlay ? overlay.selected : 0;
  const selectedOverlayIndex = overlay
    ? Math.min(
        rawOverlaySelected,
        Math.max(
          0,
          (overlay.kind === 'model'
            ? modelPickerItems.length
            : overlay.kind === 'provider'
              ? providerItems.length
              : overlay.kind === 'sessions'
                ? sessionItems.length
                : overlay.kind === 'themes'
                  ? THEMES.length
                  : overlay.kind === 'settings'
                    ? settingsItems.length
                    : 1) - 1
        )
      )
    : 0;

  const suggestions = useMemo<Suggestion[]>(() => {
    if (overlay || explorerFocused || suggestionsDismissed) return [];
    const before = input.slice(0, cursor);
    if (/^\s*\/[^\s]*$/.test(input) && input.startsWith('/')) {
      const normalized = input.trim().toLowerCase().slice(1);
      const commands = COMMANDS.filter((command) => command.name.slice(1).startsWith(normalized)).slice(
        0,
        EMPTY_SUGGESTION_LIMIT
      );
      return commands.map((command) => ({
        label: command.name,
        description: command.description,
        complete: `${command.name} `,
        kind: 'command' as const
      }));
    }
    const fileMatch = /(^|\s)@([^\s@]*)$/.exec(before);
    if (!fileMatch) return [];
    const query = (fileMatch[2] ?? '').toLowerCase();
    const ranked = files
      .map((path) => {
        const lower = path.toLowerCase();
        const rank = lower.startsWith(query)
          ? 0
          : lower.includes(`/${query}`)
            ? 1
            : lower.includes(query)
              ? 2
              : 3;
        return { path, rank };
      })
      .filter((entry) => entry.rank < 3)
      .sort((a, b) => a.rank - b.rank || a.path.length - b.path.length || a.path.localeCompare(b.path))
      .slice(0, EMPTY_SUGGESTION_LIMIT);
    return ranked.map((entry) => ({
      label: basename(entry.path),
      description: entry.path,
      complete: entry.path,
      kind: 'file' as const
    }));
  }, [cursor, explorerFocused, files, input, overlay, suggestionsDismissed]);

  const suggestionSelected = Math.min(
    suggestionIndex,
    Math.max(0, suggestions.length - 1)
  );

  const adjustSetting = useCallback(
    async (id: SettingsId, direction: number) => {
      const row = settingsRows.find((entry) => entry.id === id);
      if (!row) return;
      if (row.kind === 'action' && direction !== 0) return;
      const step = direction === 0 ? 1 : direction;
      switch (id) {
        case 'theme':
          setOverlay({
            kind: 'themes',
            selected: Math.max(0, THEMES.findIndex((entry) => entry.name === theme.name)),
            original: theme.name
          });
          return;
        case 'model':
          showModelPicker();
          return;
        case 'provider':
          showProviderPicker('switch');
          return;
        case 'github':
          await handleGithubCommand(githubAuth?.configured ? 'status' : 'login');
          return;
        case 'mode':
          await setMode(configRef.current.mode === 'plan' ? 'build' : 'plan', true);
          return;
        case 'effort': {
          const index = EFFORT_SETTINGS.indexOf(configRef.current.effort);
          const next = EFFORT_SETTINGS[(index + step + EFFORT_SETTINGS.length) % EFFORT_SETTINGS.length]!;
          await updateSetting({ effort: next }, `Reasoning effort: ${effortLabel(next)}.`);
          return;
        }
        case 'stream': {
          const next = !configRef.current.streaming;
          await updateSetting(
            { streaming: next },
            next
              ? 'Live streaming on · replies paint as tokens arrive.'
              : 'Live streaming off · replies appear when complete.'
          );
          return;
        }
        case 'explorer': {
          resizeExplorer(step * 2);
          return;
        }
        case 'thinking': {
          const next = !configRef.current.showReasoning;
          await updateSetting(
            { showReasoning: next },
            next ? 'Reasoning text visible.' : 'Reasoning text hidden.'
          );
          return;
        }
        case 'tools': {
          const next = !configRef.current.verboseTools;
          await updateSetting(
            { verboseTools: next },
            next ? 'Tool output expanded.' : 'Tool output compact.'
          );
          return;
        }
        case 'access': {
          const next = !configRef.current.fullAccess;
          await updateSetting(
            { fullAccess: next },
            next
              ? 'FULL ACCESS ON · every tool action is approved automatically, including paths outside this workspace. Use /access safe to stop.'
              : 'Full access off · normal permissions restored.',
            next ? 'warning' : 'success'
          );
          return;
        }
        case 'agent': {
          const next = !configRef.current.agents.enabled;
          if (next && configRef.current.agents.workers.length === 0) {
            addNotice('Add a worker first with /agent add provider/model.', 'warning');
            return;
          }
          try {
            const updated = await updateConfig({
              agents: { ...configRef.current.agents, enabled: next }
            });
            setConfig(updated);
            addNotice(
              next
                ? `Agent mode on · ${updated.agents.workers.length} worker${updated.agents.workers.length === 1 ? '' : 's'}.`
                : 'Agent mode off.',
              'success'
            );
          } catch (error) {
            addNotice(`Could not save settings: ${errorMessage(error)}`, 'error');
          }
          return;
        }
      }
    },
    [
      addNotice,
      githubAuth?.configured,
      handleGithubCommand,
      resizeExplorer,
      setMode,
      settingsRows,
      showModelPicker,
      showProviderPicker,
      theme.name,
      updateSetting
    ]
  );

  const moveExplorer = useCallback((delta: number) => {
    setExplorer((current) => {
      if (current.entries.length === 0) return current;
      const index = Math.max(0, Math.min(current.entries.length - 1, current.selected + delta));
      if (index === current.selected) return current;
      return { ...current, selected: index, preview: undefined, previewError: undefined };
    });
  }, []);

  const toggleExplorerDirectory = useCallback(
    (entry: ExplorerEntry) => {
      const current = explorerRef.current;
      const expanded = current.expanded.includes(entry.path)
        ? current.expanded.filter((path) => path !== entry.path)
        : [...current.expanded, entry.path];
      setExplorer((state) => ({
        ...state,
        expanded,
        preview: undefined,
        previewError: undefined
      }));
      void refreshExplorer(expanded, entry.path);
    },
    [refreshExplorer]
  );

  const exploreParent = useCallback(() => {
    const current = explorerRef.current;
    const entry = current.entries[current.selected];
    if (!entry) return;
    if (entry.kind === 'directory' && current.expanded.includes(entry.path)) {
      toggleExplorerDirectory(entry);
      return;
    }
    const parent = explorerParent(entry.path);
    if (!parent) return;
    const index = current.entries.findIndex((candidate) => candidate.path === parent);
    if (index >= 0) {
      setExplorer({ ...current, selected: index, preview: undefined, previewError: undefined });
    }
  }, [toggleExplorerDirectory]);

  const attachExplorerEntry = useCallback(() => {
    const current = explorerRef.current;
    const entry = current.entries[current.selected];
    if (!entry) return;
    if (entry.kind === 'directory') {
      toggleExplorerDirectory(entry);
      return;
    }
    const value = inputRef.current;
    const at = cursorRef.current;
    const prefix = value.length > 0 && !/\s$/.test(value.slice(0, at)) ? ' ' : '';
    const attachment = `${prefix}@${entry.path} `;
    setInputValue(`${value.slice(0, at)}${attachment}${value.slice(at)}`, at + attachment.length);
    setExplorerFocused(false);
  }, [setInputValue, toggleExplorerDirectory]);

  const dockWidth = explorerDockWidth(config.explorerWidth, size.columns);
  const mainWidth = Math.max(
    20,
    size.columns - dockWidth - (dockWidth > 0 ? EXPLORER_DOCK_GAP : 0)
  );

  useEffect(() => {
    if (dockWidth === 0 && explorerFocusedRef.current) setExplorerFocused(false);
  }, [dockWidth]);

  const transcriptLines = useMemo(
    () =>
      renderTimeline(timeline, mainWidth, theme, {
        showReasoning: config.showReasoning,
        verboseTools: config.verboseTools,
        // Timeline entries are finalized, so their spinner never changes.
        // Keeping it out of the dependencies avoids repainting the whole
        // transcript for every spinner frame.
        spinner: '⠋'
      }),
    [config.showReasoning, config.verboseTools, mainWidth, theme, timeline]
  );

  const maxScrollRef = useRef(0);

  useInput(
    (typed, key) => {
      if (key.ctrl && typed === 'c') {
        handleCtrlC();
        return;
      }
      if (key.ctrl && key.leftArrow) {
        resizeExplorer(-2);
        return;
      }
      if (key.ctrl && key.rightArrow) {
        resizeExplorer(2);
        return;
      }

      const currentOverlay = overlayRef.current;

      if (currentOverlay?.kind === 'permission') {
        if (typed.toLowerCase() === 'y' || key.return) answerPermission('allow');
        else if (typed.toLowerCase() === 'a') answerPermission('always');
        else if (typed.toLowerCase() === 'n') answerPermission('deny');
        else if (key.escape) {
          setOverlay(null);
          currentOverlay.resolve('deny');
          abortRef.current?.abort();
        }
        return;
      }

      if (currentOverlay?.kind === 'connect-key' || currentOverlay?.kind === 'github-key') {
        if (key.ctrl && (typed === 'v' || typed === '\x16')) {
          void pasteClipboard('key');
          return;
        }
        if (key.escape) {
          setOverlay(null);
          return;
        }
        if (key.return) {
          const value = currentOverlay.value.trim();
          if (!value) return;
          if (currentOverlay.kind === 'github-key') {
            void submitGithubToken(value);
          } else {
            void (async () => {
              try {
                await saveProviderKey(currentOverlay.provider.id, value);
                await refreshCredentials();
                setOverlay(null);
                addNotice(`Connected ${currentOverlay.provider.name}.`, 'success');
                if (currentOverlay.next === 'models') showModelPicker(currentOverlay.provider.id);
              } catch (error) {
                addNotice(`Could not save key: ${errorMessage(error)}`, 'error');
              }
            })();
          }
          return;
        }
        if (key.backspace || key.delete) {
          if (currentOverlay.cursor > 0) {
            const value =
              currentOverlay.value.slice(0, currentOverlay.cursor - 1) +
              currentOverlay.value.slice(currentOverlay.cursor);
            setOverlay({
              ...currentOverlay,
              value,
              cursor: currentOverlay.cursor - 1
            });
          }
          return;
        }
        if (key.leftArrow) {
          setOverlay({ ...currentOverlay, cursor: Math.max(0, currentOverlay.cursor - 1) });
          return;
        }
        if (key.rightArrow) {
          setOverlay({
            ...currentOverlay,
            cursor: Math.min(currentOverlay.value.length, currentOverlay.cursor + 1)
          });
          return;
        }
        if (key.home) {
          setOverlay({ ...currentOverlay, cursor: 0 });
          return;
        }
        if (key.end) {
          setOverlay({ ...currentOverlay, cursor: currentOverlay.value.length });
          return;
        }
        if (typed && !key.ctrl && !key.meta && typed >= ' ') {
          const value =
            currentOverlay.value.slice(0, currentOverlay.cursor) +
            typed +
            currentOverlay.value.slice(currentOverlay.cursor);
          setOverlay({
            ...currentOverlay,
            value,
            cursor: currentOverlay.cursor + typed.length
          });
        }
        return;
      }

      if (currentOverlay?.kind === 'settings') {
        if (key.escape || typed === 'q') {
          setOverlay(null);
          return;
        }
        if (key.upArrow) {
          setOverlay({ ...currentOverlay, selected: Math.max(0, selectedOverlayIndex - 1) });
          return;
        }
        if (key.downArrow || key.tab) {
          setOverlay({
            ...currentOverlay,
            selected: Math.min(Math.max(0, settingsRows.length - 1), selectedOverlayIndex + 1)
          });
          return;
        }
        const row = settingsRows[selectedOverlayIndex];
        if (key.leftArrow) {
          if (row) void adjustSetting(row.id, -1);
          return;
        }
        if (key.rightArrow) {
          if (row) void adjustSetting(row.id, 1);
          return;
        }
        if (key.return || typed === ' ') {
          if (row) void adjustSetting(row.id, 0);
          return;
        }
        if (typed === 'g') {
          openGithubLogin();
          return;
        }
        return;
      }

      if (currentOverlay?.kind === 'btw') {
        if (key.escape || key.return || typed === 'q') {
          btwAbortRef.current?.abort();
          btwAbortRef.current = null;
          btwRef.current = null;
          setBtw(null);
          setOverlay(null);
        }
        return;
      }

      if (currentOverlay?.kind === 'help') {
        if (key.escape || key.return || typed === 'q' || typed === '?') setOverlay(null);
        return;
      }

      if (currentOverlay?.kind === 'themes') {
        if (key.escape) {
          setThemeName(currentOverlay.original);
          setOverlay(null);
          return;
        }
        if (key.upArrow) {
          const next = (selectedOverlayIndex - 1 + THEMES.length) % THEMES.length;
          setOverlay({ ...currentOverlay, selected: next });
          setThemeName(THEMES[next]!.name);
          return;
        }
        if (key.downArrow || key.tab) {
          const next = (selectedOverlayIndex + 1) % THEMES.length;
          setOverlay({ ...currentOverlay, selected: next });
          setThemeName(THEMES[next]!.name);
          return;
        }
        if (key.return) {
          const chosen = THEMES[selectedOverlayIndex] ?? getTheme(currentOverlay.original);
          setThemeName(chosen.name);
          setOverlay(null);
          void updateSetting({ theme: chosen.name });
          return;
        }
        return;
      }

      if (
        currentOverlay?.kind === 'model' ||
        currentOverlay?.kind === 'provider' ||
        currentOverlay?.kind === 'sessions'
      ) {
        if (key.escape) {
          setOverlay(null);
          return;
        }
        if (key.upArrow) {
          setOverlay({
            ...currentOverlay,
            selected: Math.max(0, selectedOverlayIndex - 1)
          });
          return;
        }
        const down = key.downArrow || key.tab;
        if (down) {
          const length =
            currentOverlay.kind === 'model'
              ? modelPickerItems.length
              : currentOverlay.kind === 'provider'
                ? providerItems.length
                : sessionItems.length;
          setOverlay({
            ...currentOverlay,
            selected: Math.min(Math.max(0, length - 1), selectedOverlayIndex + 1)
          });
          return;
        }
        if (key.return) {
          if (currentOverlay.kind === 'model') {
            const entry = modelEntryForPicker(modelEntries, currentOverlay.providerFilter, currentOverlay.query, selectedOverlayIndex);
            if (entry) void chooseModel(entry.provider.id, entry.model.id);
            return;
          }
          if (currentOverlay.kind === 'provider') {
            const provider = providerForPicker(catalog, credentials, currentOverlay.query, selectedOverlayIndex);
            if (provider) selectProvider(provider);
            return;
          }
          const record = sessionForPicker(sessions, currentOverlay.query, selectedOverlayIndex);
          if (record) void resumeSession(record);
          return;
        }
        if (key.backspace || key.delete) {
          setOverlay({ ...currentOverlay, query: currentOverlay.query.slice(0, -1), selected: 0 });
          return;
        }
        if (typed && !key.ctrl && !key.meta && typed >= ' ') {
          setOverlay({ ...currentOverlay, query: currentOverlay.query + typed, selected: 0 });
          return;
        }
        return;
      }

      if (explorerFocusedRef.current) {
        const current = explorerRef.current;
        const entry = current.entries[current.selected];
        if (key.escape || (key.ctrl && typed === 'o')) {
          setExplorerFocused(false);
          return;
        }
        if (typed === '[') {
          resizeExplorer(-2);
          return;
        }
        if (typed === ']') {
          resizeExplorer(2);
          return;
        }
        if (key.upArrow) {
          moveExplorer(-1);
          return;
        }
        if (key.downArrow) {
          moveExplorer(1);
          return;
        }
        if (key.pageUp) {
          moveExplorer(-10);
          return;
        }
        if (key.pageDown) {
          moveExplorer(10);
          return;
        }
        if (key.rightArrow) {
          if (entry && isExplorerDirectory(entry) && !current.expanded.includes(entry.path)) {
            toggleExplorerDirectory(entry);
          }
          return;
        }
        if (key.leftArrow) {
          exploreParent();
          return;
        }
        if (key.tab) {
          if (entry && isExplorerDirectory(entry)) toggleExplorerDirectory(entry);
          else moveExplorer(1);
          return;
        }
        if (key.return) {
          if (!entry) return;
          if (isExplorerDirectory(entry)) toggleExplorerDirectory(entry);
          else attachExplorerEntry();
          return;
        }
        if (typed === 'a') {
          attachExplorerEntry();
          return;
        }
        if (typed === 'r') {
          void refreshExplorer(current.expanded, entry?.path);
          return;
        }
        // While the dock owns the keyboard, plain typing must not fall through
        // into the prompt behind it.
        return;
      }

      if (key.ctrl && typed === 'o') {
        focusExplorer();
        return;
      }
      if (key.ctrl && typed === 't') {
        const next = nextTheme(theme.name);
        setThemeName(next.name);
        void updateSetting({ theme: next.name });
        return;
      }
      if (key.escape) {
        if (suggestions.length > 0) {
          setSuggestionsDismissed(true);
          return;
        }
        if (activityRef.current) {
          if (activityRef.current.kind === 'sync') {
            addNotice('Sync is already finishing.', 'info');
            return;
          }
          setStopping(true);
          abortRef.current?.abort();
          return;
        }
        if (input.length > 0) {
          clearInput();
          return;
        }
        return;
      }
      if (key.pageUp) {
        setScrollOffset(Math.min(maxScrollRef.current, scrollOffset + Math.max(2, Math.floor(size.rows / 2))));
        return;
      }
      if (key.pageDown) {
        setScrollOffset(Math.max(0, scrollOffset - Math.max(2, Math.floor(size.rows / 2))));
        return;
      }
      if (key.ctrl && typed === 'u') {
        setScrollOffset(Math.min(maxScrollRef.current, scrollOffset + Math.max(2, Math.floor(size.rows / 4))));
        return;
      }
      if (key.ctrl && typed === 'd') {
        setScrollOffset(Math.max(0, scrollOffset - Math.max(2, Math.floor(size.rows / 4))));
        return;
      }
      if (key.tab && key.shift) {
        void setMode(configRef.current.mode === 'plan' ? 'build' : 'plan');
        return;
      }
      if (key.tab) {
        if (suggestions.length > 0) completeSuggestion(suggestions[suggestionSelected]);
        else {
          const next = `${input.slice(0, cursor)}  ${input.slice(cursor)}`;
          setInputValue(next, cursor + 2);
        }
        return;
      }
      if (suggestions.length > 0) {
        if (key.upArrow) {
          setSuggestionIndex(Math.max(0, suggestionSelected - 1));
          return;
        }
        if (key.downArrow) {
          setSuggestionIndex(Math.min(suggestions.length - 1, suggestionSelected + 1));
          return;
        }
      }
      if (key.return) {
        const draft = inputRef.current;
        if (
          suggestions.length > 0 &&
          suggestions[0]?.kind === 'command' &&
          !/^\/[^\s]+$/.test(draft.trim())
        ) {
          completeSuggestion(suggestions[suggestionSelected]);
          return;
        }
        if (draft.startsWith('/') && !draft.trim().includes(' ')) {
          const exact = COMMANDS.find((command) => command.name === draft.trim());
          if (!exact && suggestions.length > 0) {
            completeSuggestion(suggestions[suggestionSelected]);
            return;
          }
        }
        // /btw is deliberately allowed mid-turn: it is an isolated request and
        // never touches the active agent's history or abort controller.
        if (activityRef.current && !/^\/btw(?:\s|$)/i.test(draft.trim())) {
          addNotice('Still working. Press esc to stop first.', 'warning');
          return;
        }
        submit(draft);
        return;
      }
      if (typed === '\n') {
        const next = `${input.slice(0, cursor)}\n${input.slice(cursor)}`;
        setInputValue(next, cursor + 1);
        return;
      }
      if (key.backspace) {
        if (cursor > 0) {
          const next = input.slice(0, cursor - 1) + input.slice(cursor);
          setInputValue(next, cursor - 1);
        }
        return;
      }
      if (key.delete) {
        if (cursor < input.length) {
          const next = input.slice(0, cursor) + input.slice(cursor + 1);
          setInputValue(next, cursor);
        }
        return;
      }
      if (key.leftArrow) {
        setCursor(Math.max(0, cursor - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor(Math.min(input.length, cursor + 1));
        return;
      }
      if (key.home || (key.ctrl && typed === 'a')) {
        setCursor(0);
        return;
      }
      if (key.end || (key.ctrl && typed === 'e')) {
        setCursor(input.length);
        return;
      }
      if (key.ctrl && (typed === 'v' || typed === '\x16')) {
        void pasteClipboard('input');
        return;
      }
      if (key.ctrl && typed === 'k') {
        setInputValue(input.slice(0, cursor), cursor);
        return;
      }
      if (key.ctrl && typed === 'w') {
        const before = input.slice(0, cursor);
        const trimmed = before.replace(/\s+$/, '');
        const cut = Math.max(trimmed.lastIndexOf(' '), trimmed.lastIndexOf('\n'));
        const start = cut === -1 ? 0 : cut + 1;
        const next = input.slice(0, start) + input.slice(cursor);
        setInputValue(next, start);
        return;
      }
      if (key.upArrow) {
        if (history.length === 0) return;
        if (historyIndex === -1) {
          historyDraft.current = input;
          const nextIndex = 0;
          const value = history[history.length - 1]!;
          setHistoryIndex(nextIndex);
          inputRef.current = value;
          setInput(value);
          setCursor(value.length);
          setSuggestionsDismissed(false);
        } else {
          const nextIndex = Math.min(history.length - 1, historyIndex + 1);
          const value = history[history.length - 1 - nextIndex]!;
          setHistoryIndex(nextIndex);
          inputRef.current = value;
          setInput(value);
          setCursor(value.length);
          setSuggestionsDismissed(false);
        }
        return;
      }
      if (key.downArrow) {
        if (historyIndex === -1) return;
        const nextIndex = historyIndex - 1;
        if (nextIndex < 0) {
          setHistoryIndex(-1);
          const value = historyDraft.current;
          inputRef.current = value;
          setInput(value);
          setCursor(value.length);
          return;
        }
        const value = history[history.length - 1 - nextIndex]!;
        setHistoryIndex(nextIndex);
        inputRef.current = value;
        setInput(value);
        setCursor(value.length);
        return;
      }
      if (typed === '?' && input === '') {
        setOverlay({ kind: 'help' });
        return;
      }
      if (typed && !key.ctrl && !key.meta && typed >= ' ') {
        const next = `${input.slice(0, cursor)}${typed}${input.slice(cursor)}`;
        setInputValue(next, cursor + typed.length);
      }
    },
    { isActive: true }
  );

  usePaste((text) => {
    const current = overlayRef.current;
    if (current?.kind === 'connect-key' || current?.kind === 'github-key') {
      const clean = text.replace(/[\r\n]+/g, '').replace(/[\x00-\x1f\x7f]/g, '');
      if (!clean) return;
      setOverlay({
        ...current,
        value: current.value.slice(0, current.cursor) + clean + current.value.slice(current.cursor),
        cursor: current.cursor + clean.length
      });
      return;
    }
    if (current?.kind === 'model' || current?.kind === 'provider' || current?.kind === 'sessions') {
      const clean = text.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');
      if (!clean) return;
      setOverlay({ ...current, query: current.query + clean, selected: 0 });
      return;
    }
    if (current || explorerFocusedRef.current) return;
    const clean = text
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\t/g, '  ')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    if (!clean) return;
    const next = `${input.slice(0, cursor)}${clean}${input.slice(cursor)}`;
    setInputValue(next, cursor + clean.length);
  });

  const width = size.columns;
  const rows = size.rows;

  const statusHint = (() => {
    if (overlay?.kind === 'permission') return 'y allow once · a always · n deny · esc deny & stop';
    if (overlay?.kind === 'connect-key') return 'secret input · enter save · esc cancel';
    if (overlay?.kind === 'github-key') return 'secret input · enter verify & save · esc cancel';
    if (overlay?.kind === 'settings') return '↑↓ move · ←→ change · enter select · g github login · esc close';
    if (overlay?.kind === 'btw') return btw?.done ? 'esc close' : 'esc cancel';
    if (overlay?.kind === 'help') return 'esc close';
    if (overlay) return 'type to search · ↑↓ move · enter select · esc close';
    if (explorerFocused) return '↑↓ move · enter/a attach · [ ] resize · esc prompt';
    if (ctrlCArmed) return 'ctrl+c again to exit';
    if (busy) return 'esc stop · ctrl+j newline';
    if (config.fullAccess) return 'full access on · /access safe to restore approvals';
    if (!activeProviderId || !activeModelId) return '/connect to connect · /model to choose a model';
    return '/ commands · @ files · ctrl+o explorer · ? help';
  })();

  const statusState: StatusInfo['state'] =
    overlay?.kind === 'permission'
      ? 'permission'
      : stopping && activity
        ? 'stopping'
        : activity?.kind === 'sync'
          ? 'sync'
          : activity?.kind === 'compact'
            ? 'thinking'
            : activity?.kind === 'shell'
              ? 'tool'
              : live
                ? live.phase === 'writing'
                  ? 'streaming'
                  : live.phase
                : btwRunning
                  ? 'thinking'
                  : 'ready';

  const baseContextTokens = useMemo(
    () => estimateContextTokens(session.messages, '') + 600,
    [session.messages]
  );
  // Live text is transient; a cheap length estimate avoids walking the whole
  // conversation on every paint.
  const liveContextTokens = live
    ? Math.ceil(
        (live.content.length + (live.preamble?.length ?? 0) + live.reasoning.length) / 3.7
      )
    : 0;
  const contextUsed = baseContextTokens + liveContextTokens;

  const statusLine = renderStatus({
    theme,
    width,
    hint: statusHint,
    contextUsed,
    contextWindow,
    cost: session.usage.cost + runUsage.cost,
    state: statusState,
    spinner,
    scrollOffset,
    mode: config.mode,
    effort: config.effort === 'auto' ? undefined : config.effort,
    provider: activeProviderId,
    model: activeModelName || undefined,
    fullAccess: config.fullAccess,
    agentWorkers: config.agents.enabled ? config.agents.workers.length : undefined,
    streaming: config.streaming,
    tick: brandTick()
  });

  const btwView = btw
    ? {
        ...btw,
        answer: btwRef.current?.answer ?? btw.answer,
        now: Date.now()
      }
    : undefined;

  const bodyHeightBase = Math.max(1, rows - 1);
  let frameLines: string[];
  let effectiveScroll = scrollOffset;

  if (overlay?.kind === 'model') {
    const title = overlay.providerFilter ? `models · ${overlay.providerFilter}` : 'models';
    const subtitle = `${modelPickerItems.length} matches${overlay.query ? ` for “${overlay.query}”` : ' · connected providers'} · ${modelEntries.length} models available`;
    frameLines = [
      ...renderPicker({
        title,
        subtitle,
        items: modelPickerItems,
        selected: selectedOverlayIndex,
        width,
        height: bodyHeightBase,
        theme,
        emptyText: overlay.providerFilter
          ? 'No chat models for this provider. Connect it with /connect or add models to the provider config.'
          : 'No connected models yet. Use /connect to add a provider API key.',
        footer: `${selectedOverlayIndex + 1} of ${modelPickerItems.length} · type to search · enter select`
      }),
      statusLine
    ];
  } else if (overlay?.kind === 'provider') {
    frameLines = [
      ...renderPicker({
        title: overlay.purpose === 'connect' ? 'connect a provider' : 'providers',
        subtitle: `${providerItems.length} of ${catalog.providers.length} providers · ${[...credentials.values()].filter((entry) => entry.configured).length} connected · ${FREE_API_LABEL} no-cost tier`,
        items: providerItems,
        selected: selectedOverlayIndex,
        width,
        height: bodyHeightBase,
        theme,
        emptyText: 'No matching providers.',
        footer: `${selectedOverlayIndex + 1} of ${providerItems.length} · type to search · enter connect`
      }),
      statusLine
    ];
  } else if (overlay?.kind === 'sessions') {
    frameLines = [
      ...renderPicker({
        title: 'sessions',
        subtitle: 'Resume where you left off.',
        items: sessionItems,
        selected: selectedOverlayIndex,
        width,
        height: bodyHeightBase,
        theme,
        emptyText: 'No saved sessions yet.',
        footer: `${selectedOverlayIndex + 1} of ${sessionItems.length} · enter resume · esc close`
      }),
      statusLine
    ];
  } else if (overlay?.kind === 'themes') {
    frameLines = [
      ...renderThemePicker({
        themes: THEMES,
        selected: selectedOverlayIndex,
        width,
        height: bodyHeightBase,
        active: theme
      }),
      statusLine
    ];
  } else if (overlay?.kind === 'settings') {
    frameLines = [
      ...renderPicker({
        title: 'options',
        subtitle: 'Settings save immediately. Arrows change values; enter opens pickers.',
        items: settingsItems,
        selected: selectedOverlayIndex,
        width,
        height: bodyHeightBase,
        theme,
        emptyText: 'No settings available.',
        footer: '↑↓ move · ←→ change · enter select · esc close'
      }),
      statusLine
    ];
  } else if (overlay?.kind === 'btw') {
    frameLines = [
      ...padBlock(
        btwView ? renderBtwOverlay(btwView, width, bodyHeightBase, theme, spinner) : [],
        bodyHeightBase,
        width
      ),
      statusLine
    ];
  } else if (overlay?.kind === 'help') {
    frameLines = [
      ...padBlock(renderHelpOverlay(width, bodyHeightBase, theme), bodyHeightBase, width),
      statusLine
    ];
  } else if (overlay?.kind === 'permission') {
    frameLines = [
      ...padBlock(renderPermission(overlay.request, width, bodyHeightBase, theme), bodyHeightBase, width),
      statusLine
    ];
  } else if (overlay?.kind === 'connect-key') {
    const secretInput = renderInput(
      {
        value: overlay.value,
        cursor: overlay.cursor,
        placeholder: envNameFor(overlay.provider) ? `paste ${envNameFor(overlay.provider)}…` : 'paste your API key…',
        title: `connect · ${overlay.provider.name}`,
        hint: 'enter save · esc cancel · stored with mode 600',
        theme,
        focused: true,
        secret: true,
        maxRows: 2
      },
      width
    );
    const infoHeight = Math.max(1, bodyHeightBase - secretInput.lines.length);
    const info = renderConnectInfo(
      overlay.provider.name,
      envNameFor(overlay.provider),
      Object.keys(overlay.provider.models).length,
      width,
      infoHeight,
      theme
    );
    frameLines = [
      ...padBlock(info, infoHeight, width),
      ...secretInput.lines,
      statusLine
    ];
  } else if (overlay?.kind === 'github-key') {
    const secretInput = renderInput(
      {
        value: overlay.value,
        cursor: overlay.cursor,
        placeholder: 'paste a GitHub personal access token…',
        title: 'github · personal access token',
        hint: 'enter verify & save · esc cancel · stored with mode 600',
        theme,
        focused: true,
        secret: true,
        maxRows: 2
      },
      width
    );
    const infoHeight = Math.max(1, bodyHeightBase - secretInput.lines.length);
    const info = renderGithubInfo({
      configured: Boolean(githubAuth?.configured),
      source: githubAuth?.source === 'env' ? githubAuth.envName : githubAuth?.source === 'auth' ? 'auth.json' : undefined,
      masked: githubAuth?.masked,
      width,
      height: infoHeight,
      theme
    });
    frameLines = [
      ...padBlock(info, infoHeight, width),
      ...secretInput.lines,
      statusLine
    ];
  } else {
    const inputRender = renderInput(
      {
        value: input,
        cursor,
        placeholder: input.startsWith('!') ? 'Run a shell command…' : 'Ask anything…',
        theme,
        focused: !explorerFocused,
        maxRows: 6,
        variant: 'minimal'
      },
      mainWidth
    );

    const suggestionLines =
      suggestions.length > 0
        ? renderSuggestions(
            suggestions.map((suggestion) => ({
              label: suggestion.label,
              description: suggestion.description
            })),
            suggestionSelected,
            mainWidth,
            theme
          )
        : [];
    const bodyHeight = Math.max(
      1,
      rows - 1 - inputRender.lines.length - suggestionLines.length
    );

    let body: string[];
    if (timeline.length === 0 && !live) {
      const hero = renderHero(
        {
          cwd,
          provider: activeProviderId,
          model: activeModelName || undefined,
          mode: config.mode,
          configuredProviders: catalog.providers.filter((provider) =>
            providerReady(provider, credentials, config)
          ).length,
          totalProviders: catalog.providers.length,
          tick: logoAnimating ? frame : undefined
        },
        mainWidth,
        theme,
        bodyHeight
      );
      body = padBlock(centerBlock(hero, bodyHeight), bodyHeight, mainWidth);
      effectiveScroll = 0;
    } else {
      const liveLines = live
        ? renderLive(live, mainWidth, theme, {
            showReasoning: config.showReasoning,
            verboseTools: config.verboseTools,
            spinner,
            streaming: config.streaming,
            now: Date.now()
          })
        : [];
      const allLines =
        live && transcriptLines.length > 0 ? [...transcriptLines, '', ...liveLines] : [...transcriptLines, ...liveLines];
      const maxScroll = Math.max(0, allLines.length - bodyHeight);
      maxScrollRef.current = maxScroll;
      effectiveScroll = Math.min(scrollOffset, maxScroll);
      const end = allLines.length - effectiveScroll;
      const start = Math.max(0, end - bodyHeight);
      const slice = allLines.slice(start, end);
      body = padBlock(slice, bodyHeight, mainWidth);
    }

    const leftLines = [...body, ...suggestionLines, ...inputRender.lines];
    if (dockWidth > 0) {
      const dockLines = renderExplorer({
        cwd,
        entries: explorer.entries,
        selected: explorer.selected,
        expanded: explorer.expanded,
        preview: explorer.preview,
        previewError: explorer.previewError,
        loading: explorer.loading,
        width: dockWidth,
        height: rows - 1,
        theme,
        focused: explorerFocused
      });
      const gap = ' '.repeat(EXPLORER_DOCK_GAP);
      const composed: string[] = [];
      for (let index = 0; index < rows - 1; index += 1) {
        composed.push(
          `${fit(leftLines[index] ?? '', mainWidth)}${gap}${fit(dockLines[index] ?? '', dockWidth)}`
        );
      }
      frameLines = [...composed, statusLine];
    } else {
      frameLines = [...leftLines, statusLine];
    }
  }

  while (frameLines.length < rows) frameLines.push('');
  const text = frameLines
    .slice(0, rows)
    .map((line) => {
      const padded = fit(line, width);
      return theme.background ? bg(theme.background, padded) : padded;
    })
    .join('\n');

  return (
    <Box flexDirection="column" width={width} height={rows}>
      <Text wrap="truncate-end">{text}</Text>
    </Box>
  );
}

function appendAssistant(
  items: TimelineItem[],
  messages: ChatMessage[],
  startedAt: number,
  modelName: string
): TimelineItem[] {
  const nonUser = messages.filter((message) => message.role !== 'user');
  if (nonUser.length === 0) return items;
  const grouped = timelineFromMessages(nonUser);
  if (grouped.length === 0) return items;
  const assistant = grouped[0]!;
  assistant.durationMs = Date.now() - startedAt;
  assistant.modelName = modelName;
  return [...items, assistant];
}

function findDirectModel(
  reference: string,
  catalog: Catalog,
  currentProvider?: string
): { provider: string; model: string } | undefined {
  if (currentProvider && findModel(catalog, currentProvider, reference)) {
    return { provider: currentProvider, model: reference };
  }
  const slash = reference.indexOf('/');
  if (slash > 0) {
    const provider = reference.slice(0, slash);
    const model = reference.slice(slash + 1);
    const found = providerById(catalog, provider);
    if (found && (found.models[model] || Object.values(found.models).some((entry) => entry.id === model))) {
      return { provider, model };
    }
  }
  return undefined;
}

function modelEntryForPicker(
  entries: ModelEntry[],
  providerFilter: string | undefined,
  query: string,
  selected: number
): ModelEntry | undefined {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = entries
    .filter((entry) => !providerFilter || entry.provider.id === providerFilter)
    .filter((entry) => tokens.every((token) => entry.search.includes(token)))
    .slice(0, 2500);
  return filtered[selected];
}

function providerForPicker(
  catalog: Catalog,
  credentials: Map<string, CredentialStatus>,
  query: string,
  selected: number
): CatalogProvider | undefined {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const providers = [...catalog.providers].sort((a, b) => {
    const aReady = credentials.get(a.id)?.configured ? 1 : 0;
    const bReady = credentials.get(b.id)?.configured ? 1 : 0;
    if (aReady !== bReady) return bReady - aReady;
    return a.name.localeCompare(b.name);
  });
  return providers
    .filter((provider) => tokens.every((token) => `${provider.id} ${provider.name}`.toLowerCase().includes(token)))
    .slice(0, 500)[selected];
}

function sessionForPicker(
  sessions: SessionRecord[],
  query: string,
  selected: number
): SessionRecord | undefined {
  const normalized = query.trim().toLowerCase();
  return sessions
    .filter((record) => {
      if (!normalized) return true;
      return `${record.title} ${record.provider} ${record.model} ${record.cwd}`.toLowerCase().includes(normalized);
    })[selected];
}

function padBlock(lines: string[], height: number, width: number): string[] {
  const result = lines.slice(0, height).map((line) => fit(line, width));
  while (result.length < height) result.push(' '.repeat(width));
  return result;
}

function centerBlock(lines: string[], height: number): string[] {
  if (lines.length >= height) return lines.slice(0, height);
  const top = Math.max(0, Math.floor((height - lines.length) / 2));
  return [...Array.from({ length: top }, () => ''), ...lines];
}

function providerReady(
  provider: CatalogProvider,
  credentials: Map<string, CredentialStatus>,
  config: SurfConfig
): boolean {
  if (!credentials.get(provider.id)?.configured) return false;
  if (!providerHasEndpoint(provider, config)) return false;
  if (!localAvailable(provider, config)) return false;
  return true;
}

function localAvailable(provider: CatalogProvider, config: SurfConfig): boolean {
  const endpoint =
    config.providers[provider.id]?.baseURL ??
    config.customProviders[provider.id]?.baseURL ??
    provider.api ??
    '';
  const localEndpoint = provider.local || /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/i.test(endpoint);
  if (!localEndpoint) return true;
  return Boolean(
    provider.discovered ||
      config.providers[provider.id]?.baseURL ||
      config.customProviders[provider.id]?.baseURL
  );
}

function formatAge(timestamp: number): string {
  const delta = Math.max(0, Date.now() - timestamp);
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  if (delta < 604_800_000) return `${Math.round(delta / 86_400_000)}d ago`;
  return new Date(timestamp).toISOString().slice(0, 10);
}

function describeError(error: unknown): string {
  if (error instanceof SurfError) {
    return `${error.message}${error.hint ? `\n${error.hint}` : ''}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function transcriptMarkdown(session: SessionRecord): string {
  const lines: string[] = [];
  lines.push(`# ${session.title || 'SurfCode session'}`);
  lines.push('');
  lines.push(`- **Model:** ${session.provider}/${session.model}`);
  lines.push(`- **Workspace:** \`${session.cwd}\``);
  lines.push(`- **Mode:** ${session.mode}`);
  lines.push(`- **Started:** ${new Date(session.createdAt).toISOString()}`);
  lines.push(`- **Updated:** ${new Date(session.updatedAt).toISOString()}`);
  lines.push(`- **Cost:** $${session.usage.cost.toFixed(4)}`);
  lines.push('');
  for (const message of session.messages) {
    if (message.role === 'user') {
      lines.push('## User');
      lines.push('');
      lines.push(message.content);
      lines.push('');
      continue;
    }
    if (message.role === 'assistant') {
      lines.push('## SurfCode');
      lines.push('');
      if (message.reasoning) {
        lines.push('<details><summary>Reasoning</summary>');
        lines.push('');
        lines.push(message.reasoning);
        lines.push('');
        lines.push('</details>');
        lines.push('');
      }
      if (message.content) {
        lines.push(message.content);
        lines.push('');
      }
      for (const call of message.toolCalls ?? []) {
        const summary = typeof call.arguments.command === 'string'
          ? call.arguments.command
          : typeof call.arguments.path === 'string'
            ? call.arguments.path
            : '';
        lines.push(`<details><summary>Tool: ${call.name}${summary ? ` — ${summary}` : ''}</summary>`);
        lines.push('');
        lines.push('```json');
        lines.push(JSON.stringify(call.arguments, null, 2));
        lines.push('```');
        lines.push('');
        lines.push('</details>');
        lines.push('');
      }
      continue;
    }
    lines.push(`### Tool result · ${message.name}${message.isError ? ' (error)' : ''}`);
    lines.push('');
    lines.push('```');
    lines.push(message.content);
    lines.push('```');
    lines.push('');
  }
  return `${lines.join('\n').trim()}\n`;
}
