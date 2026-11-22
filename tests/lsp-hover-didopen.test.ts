/**
 * v0.3.67 #281 — before a hover request the target document must be
 * synchronised with the language server (textDocument/didOpen). Without it
 * the server initializes successfully but has no document to inspect, and
 * hover returns success:true with an empty output.
 *
 * The client-side contract is pinned here without spawning a real server
 * (a long-lived LSP child would keep the Jest worker alive). The real-server
 * behaviour was verified with the issue's reproduction against
 * typescript-language-server 5.3.0: hover now returns the symbol type and
 * the doc comment on the first call.
 */
import { LspClient } from '../src/tools/lsp';

describe('v0.3.67 #281 — document synchronisation before hover', () => {
  test('announces didOpen exactly once per URI with the on-disk text', () => {
    const client = new LspClient('typescript', '/tmp');
    const send = jest
      .spyOn(client as unknown as { sendNotification: () => void }, 'sendNotification')
      .mockImplementation(() => {});

    client.openDocument('file:///tmp/example.ts', 'typescript', 'const greeting = "hello";\n');
    client.openDocument('file:///tmp/example.ts', 'typescript', 'const greeting = "hello";\n');
    client.openDocument('file:///tmp/other.ts', 'typescript', 'export {};\n');

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, 'textDocument/didOpen', {
      textDocument: {
        uri: 'file:///tmp/example.ts',
        languageId: 'typescript',
        version: 1,
        text: 'const greeting = "hello";\n',
      },
    });
  });
});
