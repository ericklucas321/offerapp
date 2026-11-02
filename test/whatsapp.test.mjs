import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { WhatsAppPublisher } from '../src/infrastructure/whatsapp.mjs';
const logger = { error() {} };
test('falha de rede informa diagnóstico legível e respeita limite de reconexão', async () => {
  const deps = dependencies();
  const publisher = new WhatsAppPublisher({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wa-network-')),
    logger,
    dependencyLoader: async () => deps,
    maxReconnectAttempts: 0,
  });
  await publisher.connect();
  deps.socket.ev.emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: 408 }, message: 'private diagnostic' } },
  });
  assert.equal(publisher.status().lastError, 'whatsapp_network_unavailable');
  assert.match(publisher.status().errorMessage, /rede|internet/i);
  assert.equal(publisher.reconnectTimer, null);
  assert.equal(JSON.stringify(publisher.status()).includes('private diagnostic'), false);
  await publisher.close();
});
test('sessão substituída não provoca disputa por reconexão automática', async () => {
  const deps = dependencies(),
    publisher = setup(async () => deps);
  await publisher.connect();
  deps.socket.ev.emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: 440 } } },
  });
  assert.equal(publisher.status().lastError, 'whatsapp_connection_replaced');
  assert.equal(publisher.reconnectTimer, null);
  await publisher.close();
});
function setup(loader) {
  return new WhatsAppPublisher({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wa-tests-')),
    logger,
    dependencyLoader: loader,
  });
}
function dependencies({ authError } = {}) {
  const socket = {
    ev: new EventEmitter(),
    async groupFetchAllParticipating() {
      return { '123@g.us': { id: '123@g.us', subject: 'Ofertas', participants: [{}] } };
    },
  };
  return {
    socket,
    baileys: {
      default: () => socket,
      DisconnectReason: { loggedOut: 401 },
      async useMultiFileAuthState() {
        if (authError) throw new Error(authError);
        return { state: {}, saveCreds: async () => {} };
      },
    },
    pino: () => ({}),
    qrcode: {
      async toDataURL() {
        return 'data:image/png;base64,MOCK';
      },
    },
  };
}
test('pacotes ausentes retornam código claro, desconectam e permitem nova tentativa', async () => {
  let attempts = 0;
  const deps = dependencies();
  const p = setup(async () => {
    attempts++;
    if (attempts === 1) throw new Error('whatsapp_dependencies_missing');
    return deps;
  });
  await assert.rejects(p.connect(), /whatsapp_dependencies_missing/);
  assert.equal(p.status().state, 'disconnected');
  assert.equal(p.status().lastError, 'whatsapp_dependencies_missing');
  assert.equal(p.connecting, null);
  assert.equal(await p.qrDataUrl(), null);
  await p.connect();
  assert.equal(attempts, 2);
  assert.equal(p.status().state, 'connecting');
  assert.equal(p.status().lastError, null);
});
test('falha na autenticação inicial não deixa estado connecting preso', async () => {
  const p = setup(async () => dependencies({ authError: 'private-detail' }));
  await assert.rejects(p.connect(), /whatsapp_initialization_failed/);
  assert.equal(p.status().state, 'disconnected');
  assert.equal(p.sock, null);
  assert.equal(p.status().lastError, 'whatsapp_initialization_failed');
});
test('cliques simultâneos compartilham inicialização, QR aparece e grupos são listados após parear', async () => {
  let loads = 0;
  const deps = dependencies();
  const p = setup(async () => {
    loads++;
    await new Promise((r) => setTimeout(r, 10));
    return deps;
  });
  await Promise.all([p.connect(), p.connect()]);
  assert.equal(loads, 1);
  await p.connect();
  assert.equal(loads, 1);
  deps.socket.ev.emit('connection.update', { qr: 'fake-pairing-code' });
  assert.equal(p.status().state, 'qr');
  assert.match(await p.qrDataUrl(), /^data:image\/png/);
  await assert.rejects(p.groups(), /whatsapp_not_connected/);
  deps.socket.ev.emit('connection.update', { connection: 'open' });
  assert.equal(p.isReady(), true);
  assert.equal(await p.qrDataUrl(), null);
  assert.deepEqual(await p.groups(), [{ id: '123@g.us', name: 'Ofertas', size: 1 }]);
  deps.socket.ev.emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: 401 } } },
  });
  assert.equal(p.status().state, 'disconnected');
  assert.equal(p.status().lastError, 'whatsapp_logged_out');
  assert.equal(p.reconnectTimer, null);
});

test('loader real identifica instalação ausente antes de criar sessão', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-no-deps-'));
  const modulePath = path.join(dir, 'whatsapp.mjs');
  fs.copyFileSync(
    fileURLToPath(new URL('../src/infrastructure/whatsapp.mjs', import.meta.url)),
    modulePath,
  );
  const { WhatsAppPublisher: IsolatedPublisher } = await import(pathToFileURL(modulePath).href);
  const publisher = new IsolatedPublisher({ dataDir: dir, logger });
  await assert.rejects(publisher.connect(), /whatsapp_dependencies_missing/);
  assert.equal(publisher.status().state, 'disconnected');
  assert.equal(fs.existsSync(path.join(dir, 'wa-auth')), false);
});

test('encerrar publisher cancela reconexão e ignora eventos do socket anterior', async () => {
  const deps = dependencies();
  let ended = 0;
  deps.socket.end = () => {
    ended++;
    deps.socket.ev.emit('connection.update', { connection: 'close' });
  };
  const publisher = setup(async () => deps);
  await publisher.connect();
  deps.socket.ev.emit('connection.update', { connection: 'open' });
  publisher.close();
  assert.equal(ended, 1);
  assert.equal(publisher.isReady(), false);
  assert.equal(publisher.reconnectTimer, null);
  publisher.close();
  assert.equal(ended, 1);
});

test('desconexão anterior ao transporte é falha segura, sem resultado incerto', async () => {
  const publisher = setup(async () => dependencies());
  await assert.rejects(
    publisher.send('123@g.us', 'Teste'),
    (error) => error.safeToRetry === true && error.message === 'whatsapp_not_connected',
  );
});

test('socket encerrado não grava credenciais nem sobrescreve diagnóstico da conexão atual', async () => {
  const first = dependencies();
  const second = dependencies();
  let saved = 0;
  first.baileys.useMultiFileAuthState = async () => ({
    state: {},
    saveCreds: async () => {
      saved++;
      throw new Error('old socket');
    },
  });
  let loads = 0;
  const publisher = setup(async () => (++loads === 1 ? first : second));
  await publisher.connect();
  await publisher.close();
  await publisher.connect();
  second.socket.ev.emit('connection.update', { connection: 'open' });
  first.socket.ev.emit('creds.update');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saved, 0);
  assert.equal(publisher.status().lastError, null);
  assert.equal(publisher.isReady(), true);
  await publisher.close();
});

test('encerramento aguarda gravação da sessão antes de liberar a aplicação', async () => {
  const deps = dependencies();
  let finishSave;
  let saved = false;
  deps.baileys.useMultiFileAuthState = async () => ({
    state: {},
    saveCreds: () =>
      new Promise((resolve) => {
        finishSave = () => {
          saved = true;
          resolve();
        };
      }),
  });
  const publisher = setup(async () => deps);
  await publisher.connect();
  deps.socket.ev.emit('creds.update');
  await new Promise((resolve) => setImmediate(resolve));
  let closed = false;
  const stopping = Promise.resolve(publisher.close()).then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  finishSave();
  await stopping;
  assert.equal(saved, true);
});

test('sessão Baileys persiste e restaura credenciais em disco sem conectar à rede', async (t) => {
  const real = await import('@whiskeysockets/baileys');
  const deps = dependencies();
  deps.baileys.useMultiFileAuthState = real.useMultiFileAuthState;
  const publisher = setup(async () => deps);
  t.after(async () => {
    await publisher.close();
    fs.rmSync(publisher.dataDir, { recursive: true, force: true });
  });
  await publisher.connect();
  deps.socket.ev.emit('creds.update');
  await publisher.close();
  const auth = await real.useMultiFileAuthState(path.join(publisher.dataDir, 'wa-auth'));
  const file = path.join(publisher.dataDir, 'wa-auth', 'creds.json');
  assert.equal(fs.existsSync(file), true);
  const restoredId = auth.state.creds.signedIdentityKey.public;
  assert.ok(restoredId.length > 0);
  await publisher.connect();
  const restored = await real.useMultiFileAuthState(path.join(publisher.dataDir, 'wa-auth'));
  assert.deepEqual(restored.state.creds.signedIdentityKey.public, restoredId);
});
