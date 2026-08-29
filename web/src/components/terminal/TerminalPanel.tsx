import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import type { WebTerminalCreateResultV1, WebTerminalMetadataV1 } from '../../types';
import type { WorkbenchActions } from '../../useWorkbench';
import { Icon } from '../Icon';
import { requiresTerminalPasteConfirmation, summarizeTerminalPaste } from './terminal-input';
import {
  adjacentTerminalTab,
  clampTerminalFontSize,
  readTerminalPreference,
  terminalShellLabel,
  terminalTabAfterClose,
  terminalWorkspaceLabel,
  writeTerminalPreference,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  type TerminalPreferenceV1,
  type TerminalTabNavigationKey,
} from './terminal-preferences';
import { closeTerminalSocket } from './terminal-socket';

const TERMINAL_FONT_SIZES = Array.from(
  { length: TERMINAL_FONT_SIZE_MAX - TERMINAL_FONT_SIZE_MIN + 1 },
  (_, index) => TERMINAL_FONT_SIZE_MIN + index
);

export function TerminalPanel({
  workspaceId,
  workspacePath,
  styleNonce,
  available,
  actions,
}: {
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly styleNonce: string;
  readonly available: boolean;
  readonly actions: WorkbenchActions;
}) {
  const [terminals, setTerminals] = useState<readonly WebTerminalMetadataV1[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [ticket, setTicket] = useState<WebTerminalCreateResultV1 | null>(null);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'live' | 'lost' | 'error'>('idle');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pendingPaste, setPendingPaste] = useState<string | null>(null);
  const [screenReaderMode, setScreenReaderMode] = useState(false);
  const [creating, setCreating] = useState(false);
  const [riskDialogOpen, setRiskDialogOpen] = useState(false);
  const [preference, setPreference] = useState<TerminalPreferenceV1>(readTerminalPreference);
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const generationRef = useRef(0);
  const creatingRef = useRef(false);
  const terminalsRef = useRef<readonly WebTerminalMetadataV1[]>([]);
  const activeIdRef = useRef<string | null>(null);
  const terminalTabRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingTabFocusRef = useRef<string | null>(null);
  const createTriggerRef = useRef<HTMLElement | null>(null);
  const focusTerminalOnReadyRef = useRef(false);
  const terminalTabsId = useId();
  const cwdLabel = terminalWorkspaceLabel(workspacePath);
  const activeTerminal = terminals.find(terminal => terminal.id === activeId);

  terminalsRef.current = terminals;
  activeIdRef.current = activeId;

  const refresh = async (generation = generationRef.current) => {
    try {
      const items = await actions.terminals();
      if (generation !== generationRef.current) return;
      terminalsRef.current = items;
      setTerminals(items);
      setActiveId(current =>
        current && items.some(item => item.id === current) ? current : (items[0]?.id ?? null)
      );
    } catch (caught) {
      if (generation !== generationRef.current) return;
      setError(message(caught));
    }
  };

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    terminalsRef.current = [];
    activeIdRef.current = null;
    creatingRef.current = false;
    focusTerminalOnReadyRef.current = false;
    setTerminals([]);
    setActiveId(null);
    setTicket(null);
    setStatus('idle');
    setError('');
    setNotice('');
    setPendingPaste(null);
    setCreating(false);
    setRiskDialogOpen(false);
    if (workspaceId && available) void refresh(generation);
  }, [available, workspaceId]);

  const create = async () => {
    if (creatingRef.current) return;
    const generation = generationRef.current;
    creatingRef.current = true;
    setCreating(true);
    setError('');
    try {
      const result = await actions.createTerminal(100, 30);
      if (generation !== generationRef.current) return;
      setTerminals(current => {
        const next = [...current.filter(item => item.id !== result.terminal.id), result.terminal];
        terminalsRef.current = next;
        return next;
      });
      activeIdRef.current = result.terminal.id;
      focusTerminalOnReadyRef.current = true;
      setActiveId(result.terminal.id);
      setTicket(result);
    } catch (caught) {
      if (generation !== generationRef.current) return;
      setError(message(caught));
    } finally {
      if (generation === generationRef.current) {
        creatingRef.current = false;
        setCreating(false);
      }
    }
  };

  const requestCreate = () => {
    createTriggerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (preference.riskAcknowledged) {
      void create();
      return;
    }
    setRiskDialogOpen(true);
  };

  const finishRiskConfirmation = (accepted: boolean) => {
    setRiskDialogOpen(false);
    requestAnimationFrame(() => createTriggerRef.current?.focus());
    if (!accepted) return;
    const next = Object.freeze({
      ...preference,
      riskAcknowledged: true,
    }) satisfies TerminalPreferenceV1;
    setPreference(next);
    writeTerminalPreference(next);
    void create();
  };

  const close = async (terminalId: string) => {
    const generation = generationRef.current;
    setError('');
    try {
      await actions.closeTerminal(terminalId);
      if (generation !== generationRef.current) return;
      const currentTerminals = terminalsRef.current;
      const successor = terminalTabAfterClose(currentTerminals, terminalId);
      const next = currentTerminals.filter(item => item.id !== terminalId);
      terminalsRef.current = next;
      setTerminals(next);
      if (activeIdRef.current === terminalId) {
        closeTerminalSocket(socketRef.current, 'User closed terminal');
        setTicket(null);
        focusTerminalOnReadyRef.current = false;
        activeIdRef.current = successor;
        pendingTabFocusRef.current = successor;
        setActiveId(successor);
      }
    } catch (caught) {
      if (generation !== generationRef.current) return;
      setError(message(caught));
    }
  };

  const activateTerminal = (terminalId: string, moveFocus = false) => {
    setTicket(null);
    focusTerminalOnReadyRef.current = false;
    activeIdRef.current = terminalId;
    if (moveFocus) pendingTabFocusRef.current = terminalId;
    setActiveId(terminalId);
  };

  const onTerminalTabKeyDown = (key: string) => {
    if (!isTerminalTabNavigationKey(key) || !activeId) return false;
    const next = adjacentTerminalTab(terminals, activeId, key);
    if (next) activateTerminal(next, true);
    return true;
  };

  useEffect(() => {
    const pending = pendingTabFocusRef.current;
    if (!pending || activeId !== pending) return;
    pendingTabFocusRef.current = null;
    requestAnimationFrame(() => terminalTabRefs.current.get(pending)?.focus());
  }, [activeId, terminals]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !activeId || !available) return undefined;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', monospace",
      fontSize: preference.fontSize,
      lineHeight: 1.25,
      scrollback: 8_000,
      screenReaderMode,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    openTerminalWithStyleNonce(terminal, host, styleNonce);
    terminalRef.current = terminal;
    fitRef.current = fit;
    requestAnimationFrame(() => fit.fit());
    const syncTheme = () => {
      terminal.options.theme = terminalTheme();
    };
    const themeObserver = new MutationObserver(syncTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    const colorScheme = window.matchMedia('(prefers-color-scheme: light)');
    colorScheme.addEventListener('change', syncTheme);

    let disposed = false;
    let socket: WebSocket | null = null;
    let dataDisposable: { dispose(): void } | undefined;
    const afterSequence = readTerminalSequence(activeId);
    const onPaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (!text || !requiresTerminalPasteConfirmation(text)) return;
      event.preventDefault();
      event.stopPropagation();
      setPendingPaste(text);
    };
    host.addEventListener('paste', onPaste, true);

    const connect = async () => {
      setStatus('connecting');
      try {
        const credential =
          ticket?.terminal.id === activeId ? ticket : await actions.terminalAttachTicket(activeId);
        if (disposed) return;
        socket = actions.terminalSocket(activeId);
        socketRef.current = socket;
        socket.onopen = () => {
          socket?.send(
            JSON.stringify({ type: 'authenticate', ticket: credential.ticket, afterSequence })
          );
        };
        socket.onmessage = event => {
          if (disposed) return;
          const frame = parseTerminalFrame(event.data);
          if (!frame) return;
          if (frame.type === 'ready') {
            setStatus('live');
            requestAnimationFrame(() => {
              fit.fit();
              sendResize(socket, terminal.cols, terminal.rows);
              if (focusTerminalOnReadyRef.current) {
                focusTerminalOnReadyRef.current = false;
                terminal.focus();
              }
            });
          } else if (frame.type === 'output') {
            terminal.write(frame.data);
            writeTerminalSequence(activeId, frame.sequence);
          } else if (frame.type === 'gap') {
            terminal.writeln(
              '\r\n\x1b[33m[Orion] Earlier terminal output is no longer retained.\x1b[0m'
            );
          } else if (frame.type === 'exit') {
            terminal.writeln(`\r\n\x1b[90m[process exited ${frame.exitCode}]\x1b[0m`);
            setStatus('lost');
            void refresh();
          } else if (frame.type === 'error') {
            setError(`Terminal protocol: ${frame.code}`);
            setStatus('error');
          }
        };
        socket.onclose = event => {
          if (!disposed && event.code !== 1000) setStatus('lost');
        };
        socket.onerror = () => {
          if (!disposed) setStatus('error');
        };
        dataDisposable = terminal.onData(data => {
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'input', data }));
          }
        });
      } catch (caught) {
        if (!disposed) {
          setError(message(caught));
          setStatus('error');
        }
      }
    };

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        if (disposed) return;
        fit.fit();
        sendResize(socket, terminal.cols, terminal.rows);
      });
    });
    resizeObserver.observe(host);
    void connect();

    return () => {
      disposed = true;
      themeObserver.disconnect();
      colorScheme.removeEventListener('change', syncTheme);
      resizeObserver.disconnect();
      dataDisposable?.dispose();
      host.removeEventListener('paste', onPaste, true);
      closeTerminalSocket(socket, 'Panel detached');
      if (socketRef.current === socket) socketRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
    // Ticket is single-use and intentionally consumed by the current connection only.
  }, [activeId, available, connectionEpoch, screenReaderMode, styleNonce, workspaceId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const fit = fitRef.current;
    if (!terminal || !fit) return;
    terminal.options.fontSize = preference.fontSize;
    requestAnimationFrame(() => {
      if (terminalRef.current !== terminal) return;
      fit.fit();
      sendResize(socketRef.current, terminal.cols, terminal.rows);
    });
  }, [preference.fontSize]);

  const updateFontSize = (value: number) => {
    const next = Object.freeze({
      ...preference,
      fontSize: clampTerminalFontSize(value),
    }) satisfies TerminalPreferenceV1;
    setPreference(next);
    writeTerminalPreference(next);
  };

  const copySelection = async () => {
    const selection = terminalRef.current?.getSelection() ?? '';
    if (!selection) {
      setNotice('请先在终端中选择要复制的文本。');
      return;
    }
    try {
      await navigator.clipboard.writeText(selection);
      setNotice('已复制所选终端文本。');
    } catch {
      setNotice('浏览器未允许复制，请使用系统复制快捷键。');
    }
  };

  const finishPaste = (accepted: boolean) => {
    const text = pendingPaste;
    setPendingPaste(null);
    if (accepted && text) terminalRef.current?.paste(text);
    requestAnimationFrame(() => terminalRef.current?.focus());
  };

  if (!available) {
    return (
      <div className="resource-empty">
        <Icon name="terminal" />
        <strong>Terminal backend 不可用</strong>
        <p>当前安装没有可加载的原生 PTY；Workbench 不会伪造命令输出。</p>
      </div>
    );
  }

  return (
    <div className="terminal-panel" aria-busy={creating}>
      <div className="terminal-tabs">
        <div className="terminal-tab-list" role="tablist" aria-label="终端会话">
          {terminals.map(item => {
            const stateLabel = terminalProcessState(item.state, item.exitCode);
            const shellLabel = terminalShellLabel(item.shell);
            return (
              <div key={item.id} className={activeId === item.id ? 'active' : ''}>
                <button
                  ref={element => {
                    if (element) terminalTabRefs.current.set(item.id, element);
                    else terminalTabRefs.current.delete(item.id);
                  }}
                  id={`${terminalTabsId}-${item.id}`}
                  type="button"
                  role="tab"
                  aria-label={`${item.title}，Shell ${shellLabel}，${stateLabel}，cwd ${cwdLabel}`}
                  aria-selected={activeId === item.id}
                  aria-controls={`${terminalTabsId}-${item.id}-panel`}
                  tabIndex={activeId === item.id ? 0 : -1}
                  onClick={() => activateTerminal(item.id)}
                  onKeyDown={event => {
                    if (!onTerminalTabKeyDown(event.key)) return;
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                >
                  <span
                    className={`connection-dot ${item.state === 'running' ? 'live' : 'closed'}`}
                    aria-hidden="true"
                  />
                  <span className="terminal-tab-copy">
                    <span>{item.title}</span>
                    <small>
                      {shellLabel} · {stateLabel}
                    </small>
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`关闭终端 ${item.title}`}
                  title={`关闭终端 ${item.title}`}
                  tabIndex={activeId === item.id ? 0 : -1}
                  onClick={() => void close(item.id)}
                >
                  <Icon name="close" size={12} />
                </button>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          className="terminal-new"
          disabled={creating}
          onClick={requestCreate}
          aria-label="新建终端"
          title="新建终端"
        >
          <Icon name="add" size={14} />
        </button>
      </div>
      {error ? (
        <p className="terminal-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="terminal-notice" role="status">
          {notice}
        </p>
      ) : null}
      {activeId ? (
        <>
          <div className="terminal-status">
            <div className="terminal-context" role="group" aria-label="活动终端信息">
              <span className="terminal-connection-status" role="status" aria-live="polite">
                <span
                  className={`connection-dot ${
                    status === 'live' ? 'live' : status === 'error' ? 'closed' : 'reconnecting'
                  }`}
                  aria-hidden="true"
                />
                {terminalStatus(status)}
              </span>
              {activeTerminal ? (
                <>
                  <span className="terminal-context-item">
                    <span className="sr-only">Shell</span>
                    <code>{terminalShellLabel(activeTerminal.shell)}</code>
                  </span>
                  <span className="terminal-context-item">
                    <span className="sr-only">当前工作目录</span>
                    cwd <code>{cwdLabel}</code>
                  </span>
                  <span className="terminal-context-item">
                    <span className="sr-only">进程状态</span>
                    {terminalProcessState(activeTerminal.state, activeTerminal.exitCode)}
                  </span>
                </>
              ) : null}
            </div>
            <div className="terminal-toolbar" role="toolbar" aria-label="终端操作">
              {status === 'lost' || status === 'error' ? (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setTicket(null);
                    focusTerminalOnReadyRef.current = true;
                    setConnectionEpoch(epoch => epoch + 1);
                  }}
                >
                  重新连接
                </button>
              ) : null}
              <label className="terminal-font-control">
                <span>字号</span>
                <select
                  aria-label="终端字体大小"
                  value={preference.fontSize}
                  onChange={event => updateFontSize(Number(event.target.value))}
                >
                  {TERMINAL_FONT_SIZES.map(size => (
                    <option key={size} value={size}>
                      {size}px
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className="text-button" onClick={() => void copySelection()}>
                复制所选
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => terminalRef.current?.clear()}
              >
                清屏
              </button>
              <button
                type="button"
                className="text-button"
                aria-pressed={screenReaderMode}
                onClick={() => {
                  setTicket(null);
                  setScreenReaderMode(value => !value);
                  setConnectionEpoch(epoch => epoch + 1);
                }}
              >
                屏幕阅读
              </button>
            </div>
          </div>
          <div
            ref={hostRef}
            id={`${terminalTabsId}-${activeId}-panel`}
            className="terminal-host"
            role="tabpanel"
            aria-labelledby={`${terminalTabsId}-${activeId}`}
          />
        </>
      ) : (
        <div className="resource-empty">
          <Icon name="terminal" />
          <strong>没有活动终端</strong>
          <p>终端仅在明确点击后创建，并绑定当前项目目录。</p>
          <button
            type="button"
            className="primary-button"
            disabled={creating}
            onClick={requestCreate}
          >
            <Icon name="add" size={14} />
            {creating ? '正在创建…' : '新建终端'}
          </button>
        </div>
      )}
      {riskDialogOpen ? <TerminalRiskDialog onDecision={finishRiskConfirmation} /> : null}
      {pendingPaste ? <TerminalPasteDialog text={pendingPaste} onDecision={finishPaste} /> : null}
    </div>
  );
}

function TerminalRiskDialog({ onDecision }: { readonly onDecision: (accepted: boolean) => void }) {
  const [understood, setUnderstood] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useTerminalModalInert(dialogRef);

  return (
    <div className="terminal-paste-backdrop">
      <section
        ref={dialogRef}
        className="terminal-paste-dialog terminal-risk-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={event => trapTerminalDialogFocus(event, () => onDecision(false))}
      >
        <span className="eyebrow">PRIVILEGED LOCAL SURFACE</span>
        <h3 id={titleId}>创建本地终端前请确认风险</h3>
        <div id={descriptionId} className="terminal-risk-copy">
          <p>
            终端能够在当前项目中执行本地命令，也可能显示凭证或其他敏感内容。只在信任此项目和命令时继续。
          </p>
          <p>终端输出不会写入聊天记录、Workbench 诊断或发布证据。</p>
        </div>
        <label className="terminal-risk-check">
          <input
            type="checkbox"
            checked={understood}
            onChange={event => setUnderstood(event.target.checked)}
          />
          <span>我理解终端可以执行本地命令</span>
        </label>
        <div className="dialog-actions">
          <button
            type="button"
            className="secondary-button"
            autoFocus
            onClick={() => onDecision(false)}
          >
            取消
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!understood}
            onClick={() => onDecision(true)}
          >
            我理解，创建终端
          </button>
        </div>
      </section>
    </div>
  );
}

function TerminalPasteDialog({
  text,
  onDecision,
}: {
  readonly text: string;
  readonly onDecision: (accepted: boolean) => void;
}) {
  const summary = summarizeTerminalPaste(text);
  const dialogRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useTerminalModalInert(dialogRef);

  return (
    <div className="terminal-paste-backdrop">
      <section
        ref={dialogRef}
        className="terminal-paste-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={event => trapTerminalDialogFocus(event, () => onDecision(false))}
      >
        <span className="eyebrow">TERMINAL SAFETY</span>
        <h3 id={titleId}>确认向终端粘贴</h3>
        <p id={descriptionId}>
          这段内容含 {summary.lineCount} 行、{summary.characterCount}{' '}
          个字符，可能立即执行命令。正文不会显示或记录。
        </p>
        <div className="dialog-actions">
          <button
            type="button"
            className="secondary-button"
            autoFocus
            onClick={() => onDecision(false)}
          >
            取消
          </button>
          <button type="button" className="danger-button" onClick={() => onDecision(true)}>
            仍然粘贴
          </button>
        </div>
      </section>
    </div>
  );
}

function useTerminalModalInert(dialogRef: RefObject<HTMLElement>): void {
  useEffect(() => {
    const dialog = dialogRef.current;
    const panel = dialog?.closest<HTMLElement>('.terminal-panel');
    if (!dialog || !panel) return undefined;
    const background = Array.from(panel.children).filter(element => !element.contains(dialog));
    for (const element of background) (element as HTMLElement).inert = true;
    return () => {
      for (const element of background) (element as HTMLElement).inert = false;
    };
  }, [dialogRef]);
}

function trapTerminalDialogFocus(event: KeyboardEvent<HTMLElement>, onCancel: () => void): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    onCancel();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'
    )
  );
  if (focusable.length === 0) return;
  const current = focusable.indexOf(document.activeElement as HTMLElement);
  if (event.shiftKey && current <= 0) {
    event.preventDefault();
    focusable.at(-1)?.focus();
  } else if (!event.shiftKey && (current < 0 || current === focusable.length - 1)) {
    event.preventDefault();
    focusable[0].focus();
  }
}

function openTerminalWithStyleNonce(terminal: Terminal, host: HTMLElement, nonce: string): void {
  const ownerDocument = host.ownerDocument;
  const originalCreateElement = ownerDocument.createElement;
  ownerDocument.createElement = ((tagName: string, options?: ElementCreationOptions) => {
    const element = originalCreateElement.call(ownerDocument, tagName, options);
    if (tagName.toLocaleLowerCase() === 'style' && nonce) element.setAttribute('nonce', nonce);
    return element;
  }) as typeof ownerDocument.createElement;
  try {
    terminal.open(host);
  } finally {
    ownerDocument.createElement = originalCreateElement;
  }
}

type TerminalFrame =
  | { readonly type: 'ready' }
  | { readonly type: 'output'; readonly sequence: number; readonly data: string }
  | { readonly type: 'gap'; readonly earliestSequence: number; readonly latestSequence: number }
  | { readonly type: 'exit'; readonly exitCode: number }
  | { readonly type: 'error'; readonly code: string };

function parseTerminalFrame(raw: unknown): TerminalFrame | null {
  if (typeof raw !== 'string') return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.type === 'ready') return { type: 'ready' };
    if (
      value.type === 'output' &&
      Number.isSafeInteger(value.sequence) &&
      typeof value.data === 'string'
    ) {
      return { type: 'output', sequence: Number(value.sequence), data: value.data };
    }
    if (
      value.type === 'gap' &&
      Number.isSafeInteger(value.earliestSequence) &&
      Number.isSafeInteger(value.latestSequence)
    ) {
      return {
        type: 'gap',
        earliestSequence: Number(value.earliestSequence),
        latestSequence: Number(value.latestSequence),
      };
    }
    if (value.type === 'exit' && Number.isSafeInteger(value.exitCode)) {
      return { type: 'exit', exitCode: Number(value.exitCode) };
    }
    if (value.type === 'error' && typeof value.code === 'string') {
      return { type: 'error', code: value.code };
    }
  } catch {
    return null;
  }
  return null;
}

function sendResize(socket: WebSocket | null, cols: number, rows: number): void {
  if (socket?.readyState !== WebSocket.OPEN || cols < 2 || rows < 1) return;
  socket.send(JSON.stringify({ type: 'resize', cols, rows }));
}

function readTerminalSequence(terminalId: string): number {
  try {
    const value = Number(sessionStorage.getItem(`orion.terminal.sequence.${terminalId}`));
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

function writeTerminalSequence(terminalId: string, sequence: number): void {
  try {
    sessionStorage.setItem(`orion.terminal.sequence.${terminalId}`, String(sequence));
  } catch {
    // Sequence persistence is an optional reconnect optimization.
  }
}

function terminalTheme() {
  const style = getComputedStyle(document.documentElement);
  return {
    background: style.getPropertyValue('--terminal-background').trim() || '#12131a',
    foreground: style.getPropertyValue('--terminal-foreground').trim() || '#e8e9f0',
    cursor: style.getPropertyValue('--terminal-cursor').trim() || '#9d8cff',
    selectionBackground: style.getPropertyValue('--terminal-selection').trim() || '#3b3566',
  };
}

function terminalStatus(status: string): string {
  if (status === 'live') return 'PTY 已连接';
  if (status === 'connecting') return '正在连接 PTY…';
  if (status === 'lost') return '连接已断开';
  if (status === 'error') return '终端连接失败';
  return '等待连接';
}

function terminalProcessState(state: WebTerminalMetadataV1['state'], exitCode?: number): string {
  if (state === 'running') return '运行中';
  if (state === 'closing') return '正在关闭';
  return exitCode === undefined ? '已退出' : `已退出 ${exitCode}`;
}

function isTerminalTabNavigationKey(key: string): key is TerminalTabNavigationKey {
  return key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Home' || key === 'End';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : '终端请求失败。';
}
