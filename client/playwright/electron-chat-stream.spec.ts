import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page } from 'playwright';

import electronPath from 'electron';

import { TEST_IDS } from '../src/renderer/app/testIds';

type StubServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function getEvidencePath(): string {
  return path.resolve(process.cwd(), '..', '.sisyphus', 'evidence', 'task-9-chat-stream.png');
}

async function getDebugPanelPage(app: ElectronApplication): Promise<Page> {
  const timeoutMs = 5_000;
  const pollIntervalMs = 100;
  const deadline = Date.now() + timeoutMs;

  let pages: Page[] = app.windows();
  while (pages.length < 2 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    pages = app.windows();
  }

  if (pages.length === 0) throw new Error('E2E_NO_ELECTRON_WINDOWS');

  let bestPage: Page = pages[0]!;
  let bestWidth = -1;

  for (const page of pages) {
    if (page.isClosed()) continue;

    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 1_000 });
    } catch {
    }

    let width = 0;
    try {
      const w = await page.evaluate(() => window.innerWidth);
      width = typeof w === 'number' ? w : 0;
    } catch {
      width = 0;
    }

    if (width > bestWidth) {
      bestWidth = width;
      bestPage = page;
    }
  }

  return bestPage;
}

function randomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex');
}

function computeWebSocketAccept(key: string): string {
  return crypto.createHash('sha1').update(`${key}${WS_GUID}`, 'utf8').digest('base64');
}

function encodeServerFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  if (len <= 125) {
    return Buffer.concat([Buffer.from([0x80 | (opcode & 0x0f), len]), payload]);
  }
  if (len <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
    return Buffer.concat([header, payload]);
  }
  throw new Error('WS_FRAME_TOO_LARGE');
}

function encodeServerTextFrame(text: string): Buffer {
  return encodeServerFrame(0x1, Buffer.from(text, 'utf8'));
}

type DecodedFrame = {
  opcode: number;
  payload: Buffer;
};

function decodeOneWsFrame(buf: Buffer): { frame: DecodedFrame; rest: Buffer } | null {
  if (buf.length < 2) return null;

  const b1 = buf[0];
  const b2 = buf[1];
  const fin = (b1 & 0x80) !== 0;
  const opcode = b1 & 0x0f;
  const masked = (b2 & 0x80) !== 0;

  if (!fin) throw new Error('WS_FRAGMENT_NOT_SUPPORTED');

  let payloadLen = b2 & 0x7f;
  let offset = 2;

  if (payloadLen === 126) {
    if (buf.length < offset + 2) return null;
    payloadLen = buf.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLen === 127) {
    if (buf.length < offset + 8) return null;
    const bigLen = buf.readBigUInt64BE(offset);
    if (bigLen > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WS_PAYLOAD_TOO_LARGE');
    payloadLen = Number(bigLen);
    offset += 8;
  }

  let maskKey: Buffer | null = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    maskKey = Buffer.alloc(4);
    buf.copy(maskKey, 0, offset, offset + 4);
    offset += 4;
  }

  if (buf.length < offset + payloadLen) return null;

  const payload = Buffer.alloc(payloadLen);
  buf.copy(payload, 0, offset, offset + payloadLen);

  const restLen = buf.length - (offset + payloadLen);
  const rest = Buffer.alloc(restLen);
  if (restLen > 0) buf.copy(rest, 0, offset + payloadLen);

  if (maskKey) {
    for (let i = 0; i < payload.length; i++) {
      payload[i] = payload[i] ^ maskKey[i % 4];
    }
  }

  return { frame: { opcode, payload }, rest };
}

async function startWsStubServer(): Promise<StubServer> {
  const sockets = new Set<Duplex>();

  const server = http.createServer((_req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: 'not found' }));
  });

  server.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '';
    if (!url.startsWith('/ws/v1')) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const keyHeader = req.headers['sec-websocket-key'];
    const key = typeof keyHeader === 'string' ? keyHeader.trim() : '';
    if (!key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = computeWebSocketAccept(key);
    const protocolHeader = req.headers['sec-websocket-protocol'];
    const protocolRaw = typeof protocolHeader === 'string' ? protocolHeader.trim() : '';
    const selectedProtocol = protocolRaw ? protocolRaw.split(',')[0]?.trim() ?? '' : '';

    const responseLines = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      ...(selectedProtocol ? [`Sec-WebSocket-Protocol: ${selectedProtocol}`] : [])
    ];
    socket.write(responseLines.join('\r\n') + '\r\n\r\n');

    sockets.add(socket);

    let buf: Buffer = Buffer.alloc(0);
    if (head && head.length > 0) {
      buf = Buffer.concat([buf, head]);
    }

    let seq = 0;
    let streamingTimer: NodeJS.Timeout | null = null;

    const stopStreaming = () => {
      if (streamingTimer) {
        clearInterval(streamingTimer);
        streamingTimer = null;
      }
    };

    const sendJson = (payload: unknown) => {
      try {
        socket.write(encodeServerTextFrame(JSON.stringify(payload)));
      } catch {
      }
    };

    sendJson({ type: 'HELLO', seq: 0, server_event_id: null });

    const startStreaming = (clientRequestId: unknown) => {
      stopStreaming();

      const streamingStressText = `AI: ${'streaming '.repeat(40)}ok`;
      const tokenChars = Array.from(streamingStressText);
      let idx = 0;

      const sendNext = () => {
        if (idx >= tokenChars.length) {
          stopStreaming();
          seq += 1;
          sendJson({
            type: 'CHAT_DONE',
            seq,
            server_event_id: randomId(),
            payload: {
              interrupted: false,
              reason: 'ok',
              client_request_id: typeof clientRequestId === 'string' ? clientRequestId : null
            }
          });
          return;
        }

        const ch = tokenChars[idx] ?? '';
        idx += 1;
        seq += 1;
        sendJson({
          type: 'CHAT_TOKEN',
          seq,
          server_event_id: randomId(),
          payload: { token: ch }
        });
      };

      sendNext();
      streamingTimer = setInterval(sendNext, 12);
    };

    const cleanup = () => {
      stopStreaming();
      sockets.delete(socket);
    };

    socket.on('close', cleanup);
    socket.on('error', cleanup);

    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);

      while (true) {
        let decoded: { frame: DecodedFrame; rest: Buffer } | null = null;
        try {
          decoded = decodeOneWsFrame(buf);
        } catch {
          try {
            socket.destroy();
          } catch {
          }
          cleanup();
          return;
        }

        if (!decoded) return;
        buf = decoded.rest;

        const { opcode, payload } = decoded.frame;

        if (opcode === 0x8) {
          cleanup();
          try {
            socket.end();
          } catch {
          }
          return;
        }

        if (opcode === 0x9) {
          try {
            socket.write(encodeServerFrame(0x0a, payload));
          } catch {
          }
          continue;
        }

        if (opcode !== 0x1) continue;

        const text = payload.toString('utf8');
        if (!text) continue;

        let msg: unknown;
        try {
          msg = JSON.parse(text);
        } catch {
          continue;
        }

        const type =
          typeof msg === 'object' && msg !== null && 'type' in msg
            ? (msg as { type?: unknown }).type
            : undefined;

        if (type === 'CHAT_SEND') {
          const clientRequestId =
            typeof msg === 'object' && msg !== null && 'client_request_id' in msg
              ? (msg as { client_request_id?: unknown }).client_request_id
              : undefined;
          startStreaming(clientRequestId);
          continue;
        }

        if (type === 'INTERRUPT') {
          stopStreaming();
          seq += 1;
          sendJson({
            type: 'CHAT_DONE',
            seq,
            server_event_id: randomId(),
            payload: {
              interrupted: true,
              reason: 'interrupted'
            }
          });
          continue;
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('STUB_SERVER_NO_ADDRESS');
  const port = (addr as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      for (const s of sockets) {
        try {
          s.destroy();
        } catch {
        }
      }
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

async function withTempUserDataDir<T>(fn: (userDataDir: string) => Promise<T>): Promise<T> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'para-e2e-userdata-'));
  try {
    return await fn(dir);
  } finally {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
    } catch {
    }
  }
}

test('Electron chat stream: first token within 3s', async () => {
  const mainEntry = path.resolve(process.cwd(), 'dist/main/index.js');
  expect(fs.existsSync(mainEntry)).toBeTruthy();

  const stub = await startWsStubServer();

  try {
    await withTempUserDataDir(async (userDataDir) => {
      const tokensPath = path.join(userDataDir, 'auth.tokens.json');
      await fs.promises.mkdir(userDataDir, { recursive: true });
      await fs.promises.writeFile(
        tokensPath,
        JSON.stringify({
          secure: false,
          accessToken: `e2e-access-${randomId()}`,
          refreshToken: `e2e-refresh-${randomId()}`
        }),
        { encoding: 'utf8' }
      );

      const app = await electron.launch({
        executablePath: electronPath as unknown as string,
        args: [mainEntry],
        env: {
          ...process.env,
          NODE_ENV: 'test',
          PARA_SERVER_BASE_URL: stub.baseUrl,
          PARA_USER_DATA_DIR: userDataDir
        }
      });

      try {
        const page = await getDebugPanelPage(app);

        await page.evaluate(() => {
          window.location.hash = '#/chat';
        });

        await expect(page.getByTestId(TEST_IDS.chatInput)).toBeVisible();

        await page.getByRole('button', { name: '连接' }).click();

        const connectionSettleMs = 1_000;
        await page.waitForTimeout(connectionSettleMs);

        await page.getByTestId(TEST_IDS.chatInput).fill('hello');
        await page.getByTestId(TEST_IDS.chatSend).click();

        await expect(page.getByTestId(TEST_IDS.chatLastAiMessage)).toContainText('AI:', { timeout: 3_000 });

        await page.getByTestId(TEST_IDS.chatInput).fill('typing while streaming');
        await expect(page.getByTestId(TEST_IDS.chatInput)).toHaveValue('typing while streaming');

        const evidencePath = getEvidencePath();
        await fs.promises.mkdir(path.dirname(evidencePath), { recursive: true });
        await page.screenshot({ path: evidencePath, fullPage: true });
        expect(fs.existsSync(evidencePath)).toBeTruthy();
      } finally {
        await app.close();
      }
    });
  } finally {
    await stub.close();
  }
});
