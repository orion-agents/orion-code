/**
 * orion code - MCP Transport Layer
 *
 * 支持 SSE、WebSocket、HTTP 多协议传输。
 */

import { EventEmitter } from 'events';

// ============================================================================
// 类型定义
// ============================================================================

export type TransportType = 'sse' | 'websocket' | 'http';

export interface TransportConfig {
  type: TransportType;
  endpoint: string;
  timeout?: number;
  headers?: Record<string, string>;
  reconnect?: boolean;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
}

export interface TransportMessage {
  id?: string;
  type: 'request' | 'response' | 'notification';
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface TransportEvents {
  message: (msg: TransportMessage) => void;
  error: (err: Error) => void;
  connected: () => void;
  disconnected: () => void;
  reconnecting: (attempt: number) => void;
}

// ============================================================================
// Base Transport
// ============================================================================

export abstract class BaseTransport extends EventEmitter {
  protected config: TransportConfig;
  protected connected: boolean = false;

  constructor(config: TransportConfig) {
    super();
    this.config = config;
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract send(message: TransportMessage): Promise<void>;

  isConnected(): boolean {
    return this.connected;
  }

  protected emitMessage(msg: TransportMessage): void {
    this.emit('message', msg);
  }

  protected emitError(err: Error): void {
    this.emit('error', err);
  }

  protected emitConnected(): void {
    this.connected = true;
    this.emit('connected');
  }

  protected emitDisconnected(): void {
    this.connected = false;
    this.emit('disconnected');
  }
}

// ============================================================================
// SSE Transport
// ============================================================================

export class SseTransport extends BaseTransport {
  private eventSource: EventSource | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts: number = 0;

  constructor(config: TransportConfig) {
    super(config);
  }

  async connect(): Promise<void> {
    if (this.eventSource) {
      this.eventSource.close();
    }

    const url = this.buildUrl();
    this.eventSource = new EventSource(url, {
      // Node.js 环境可能需要额外配置
    } as EventSourceInit);

    this.eventSource.onopen = () => {
      this.reconnectAttempts = 0;
      this.emitConnected();
    };

    this.eventSource.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as TransportMessage;
        this.emitMessage(msg);
      } catch (err) {
        this.emitError(new Error(`Failed to parse SSE message: ${err}`));
      }
    };

    this.eventSource.onerror = () => {
      this.emitDisconnected();

      if (this.config.reconnect !== false) {
        this.attemptReconnect();
      }
    };
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.emitDisconnected();
  }

  async send(message: TransportMessage): Promise<void> {
    // SSE 是单向的，需要通过 HTTP POST 发送
    const response = await fetch(this.config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.config.headers,
      },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
  }

  private buildUrl(): string {
    const url = new URL(this.config.endpoint);
    if (this.config.headers) {
      Object.entries(this.config.headers).forEach(([key, value]) => {
        url.searchParams.set(key, value);
      });
    }
    return url.toString();
  }

  // Issue #32 #3.6: SSE 重连指数退避
  private attemptReconnect(): void {
    const maxAttempts = this.config.maxReconnectAttempts || 5;

    // 指数退避：3s → 6s → 12s → 24s → 48s
    const baseInterval = 3000;
    const exponentialBackoff = (attempt: number): number => {
      return Math.min(baseInterval * Math.pow(2, attempt - 1), 48000);
    };

    if (this.reconnectAttempts >= maxAttempts) {
      this.emitError(new Error('Max reconnect attempts reached'));
      return;
    }

    this.reconnectAttempts++;
    this.emit('reconnecting', this.reconnectAttempts);

    // Clear any pending reconnect timer before scheduling a new one.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const interval = exponentialBackoff(this.reconnectAttempts);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(err => {
        this.emitError(err);
      });
    }, interval);
  }
}

// ============================================================================
// WebSocket Transport
// ============================================================================

export class WebSocketTransport extends BaseTransport {
  private ws: WebSocket | null = null;
  private reconnectAttempts: number = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(config: TransportConfig) {
    super(config);
  }

  async connect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
    }

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.config.endpoint);

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.emitConnected();
        resolve();
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as TransportMessage;
          this.emitMessage(msg);
        } catch (err) {
          this.emitError(new Error(`Failed to parse WebSocket message: ${err}`));
        }
      };

      this.ws.onerror = (err) => {
        this.emitError(new Error('WebSocket error'));
        reject(err);
      };

      this.ws.onclose = () => {
        this.emitDisconnected();

        if (this.config.reconnect !== false) {
          this.attemptReconnect();
        }
      };
    });
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.emitDisconnected();
  }

  async send(message: TransportMessage): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }

    this.ws.send(JSON.stringify(message));
  }

  // Issue #32 #3.6: WebSocket 重连指数退避
  private attemptReconnect(): void {
    const maxAttempts = this.config.maxReconnectAttempts || 5;

    // 指数退避：3s → 6s → 12s → 24s → 48s
    const baseInterval = 3000;
    const exponentialBackoff = (attempt: number): number => {
      return Math.min(baseInterval * Math.pow(2, attempt - 1), 48000);
    };

    if (this.reconnectAttempts >= maxAttempts) {
      this.emitError(new Error('Max reconnect attempts reached'));
      return;
    }

    this.reconnectAttempts++;
    this.emit('reconnecting', this.reconnectAttempts);

    const interval = exponentialBackoff(this.reconnectAttempts);

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(err => {
        this.emitError(err);
      });
    }, interval);
  }
}

// ============================================================================
// HTTP Transport
// ============================================================================

export class HttpTransport extends BaseTransport {
  constructor(config: TransportConfig) {
    super(config);
    // HTTP 不需要持久连接
    this.connected = true;
  }

  async connect(): Promise<void> {
    // HTTP 是无状态的，只需验证端点
    try {
      const response = await fetch(this.config.endpoint, {
        method: 'HEAD',
        headers: this.config.headers,
      });

      if (response.ok) {
        this.emitConnected();
      } else {
        throw new Error(`Endpoint returned ${response.status}`);
      }
    } catch (err) {
      this.emitError(new Error(`Failed to connect: ${err}`));
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.emitDisconnected();
  }

  async send(message: TransportMessage): Promise<void> {
    const timeout = this.config.timeout || 30000;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(this.config.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.config.headers,
        },
        body: JSON.stringify(message),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as TransportMessage;
      this.emitMessage(data);
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  }
}

// ============================================================================
// Transport Factory
// ============================================================================

export function createTransport(config: TransportConfig): BaseTransport {
  switch (config.type) {
    case 'sse':
      return new SseTransport(config);
    case 'websocket':
      return new WebSocketTransport(config);
    case 'http':
      return new HttpTransport(config);
    default:
      throw new Error(`Unknown transport type: ${config.type}`);
  }
}

// ============================================================================
// Transport Manager
// ============================================================================

export class TransportManager {
  private transports: Map<string, BaseTransport> = new Map();

  /**
   * 注册传输层
   */
  register(name: string, config: TransportConfig): BaseTransport {
    const transport = createTransport(config);
    this.transports.set(name, transport);
    return transport;
  }

  /**
   * 获取传输层
   */
  get(name: string): BaseTransport | undefined {
    return this.transports.get(name);
  }

  /**
   * 移除传输层
   */
  async remove(name: string): Promise<void> {
    const transport = this.transports.get(name);
    if (transport) {
      await transport.disconnect();
      this.transports.delete(name);
    }
  }

  /**
   * 连接所有传输层
   */
  async connectAll(): Promise<void> {
    const promises = Array.from(this.transports.values()).map(t => t.connect());
    await Promise.allSettled(promises);
  }

  /**
   * 断开所有传输层
   */
  async disconnectAll(): Promise<void> {
    const promises = Array.from(this.transports.values()).map(t => t.disconnect());
    await Promise.allSettled(promises);
  }

  /**
   * 广播消息到所有传输层
   */
  async broadcast(message: TransportMessage): Promise<void> {
    const promises = Array.from(this.transports.values())
      .filter(t => t.isConnected())
      .map(t => t.send(message));
    await Promise.allSettled(promises);
  }
}

// ============================================================================
// 单例
// ============================================================================

let transportManager: TransportManager | null = null;

export function getTransportManager(): TransportManager {
  if (!transportManager) {
    transportManager = new TransportManager();
  }
  return transportManager;
}

export function resetTransportManager(): void {
  if (transportManager) {
    transportManager.disconnectAll().catch(() => {});
  }
  transportManager = null;
}