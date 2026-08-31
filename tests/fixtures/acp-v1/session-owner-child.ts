import { ProductOrionAcpRuntimePort } from '../../../src/acp/product-runtime-port';
import { createProductUiRuntime } from '../../../src/runtime/product-bootstrap';
import { loadSessionMeta } from '../../../src/services/session-storage';
import { WebWorkbenchController } from '../../../src/web/workbench-controller';

async function main(): Promise<void> {
  const [mode, sessionId, cwd] = process.argv.slice(2);
  const session = loadSessionMeta(sessionId);
  if (!session) throw new Error(`Fixture session ${sessionId} was not found.`);

  let close: () => Promise<void>;
  if (mode === 'cli') {
    const runtime = await createProductUiRuntime({
      cwd,
      uiRenderer: 'terminal',
      shutdownReason: 'CLI ownership fixture shutdown',
    });
    const activate = runtime.activateSession;
    if (!activate) throw new Error('CLI runtime has no ownership coordinator.');
    await activate(session);
    close = () => runtime.shutdown();
  } else if (mode === 'web') {
    const workbench = await WebWorkbenchController.create({ cwd });
    await workbench.activateSession(sessionId);
    close = () => workbench.shutdown();
  } else if (mode === 'acp') {
    const port = new ProductOrionAcpRuntimePort();
    await port.loadSession({ sessionId, cwd, mcpServers: [], observer: fixtureObserver });
    close = () => port.close();
  } else {
    throw new Error(`Unknown fixture mode ${mode}.`);
  }

  process.send?.({ type: 'ready', mode });
  const shutdown = async () => {
    await close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

const fixtureObserver = {
  update: async () => undefined,
  requestPermission: async () => false,
};

void main().catch(error => {
  process.send?.({
    type: 'error',
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
