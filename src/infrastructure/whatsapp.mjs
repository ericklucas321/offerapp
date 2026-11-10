import path from 'node:path';
import fs from 'node:fs';
const diagnostics = {
  whatsapp_network_unavailable:
    'Não foi possível acessar a rede do WhatsApp. Confira a internet e as permissões de rede do aplicativo, depois tente novamente.',
  whatsapp_connection_closed: 'A conexão com o WhatsApp foi encerrada. Tente conectar novamente.',
  whatsapp_connection_replaced:
    'Esta sessão foi aberta em outra instância. Use apenas uma instância do Offer para esta sessão.',
  whatsapp_logged_out:
    'A sessão foi desconectada no WhatsApp. Conecte novamente e escaneie o novo QR.',
  whatsapp_protocol_rejected:
    'O WhatsApp recusou a conexão desta versão. A integração precisa ser revisada antes de tentar novamente.',
  whatsapp_initialization_failed:
    'Não foi possível iniciar a conexão com o WhatsApp. Tente novamente.',
  whatsapp_session_save_failed:
    'Não foi possível salvar a sessão. Confira a permissão de gravação na pasta do aplicativo.',
  whatsapp_dependencies_missing: 'A conexão do WhatsApp não está instalada. Execute INSTALAR.bat.',
};

async function loadDependencies() {
  try {
    const [baileys, pino, qrcode] = await Promise.all([
      import('@whiskeysockets/baileys'),
      import('pino'),
      import('qrcode'),
    ]);
    return { baileys, pino: pino.default, qrcode: qrcode.default };
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND') {
      throw new Error('whatsapp_dependencies_missing', { cause: error });
    }
    throw error;
  }
}

export class WhatsAppPublisher {
  constructor({
    dataDir = './data',
    logger = console,
    dependencyLoader = loadDependencies,
    maxReconnectAttempts = 3,
  } = {}) {
    this.dataDir = path.resolve(dataDir);
    this.logger = logger;
    this.dependencyLoader = dependencyLoader;
    this.sock = null;
    this.qr = null;
    this.state = 'disconnected';
    this.connecting = null;
    this.lastError = null;
    this.reconnectTimer = null;
    this.qrcode = null;
    this.generation = 0;
    this.authWrites = Promise.resolve();
    this.maxReconnectAttempts = maxReconnectAttempts;
    this.reconnectAttempts = 0;
  }

  isReady() {
    return this.state === 'connected';
  }
  status() {
    return {
      state: this.state,
      hasQr: Boolean(this.qr),
      lastError: this.lastError,
      errorMessage: diagnostics[this.lastError] || '',
      retrying: !!this.reconnectTimer,
    };
  }

  async connect({ retry = false } = {}) {
    if (this.sock && ['connected', 'connecting', 'qr'].includes(this.state)) return this.status();
    if (this.connecting) return this.connecting;
    if (!retry) this.reconnectAttempts = 0;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.connecting = this.#connect()
      .catch((error) => {
        this.qr = null;
        this.sock = null;
        this.qrcode = null;
        this.state = 'disconnected';
        this.lastError =
          error.message === 'whatsapp_dependencies_missing'
            ? error.message
            : 'whatsapp_initialization_failed';
        this.logger.error?.('WhatsApp initialization failed', { code: this.lastError });
        throw new Error(this.lastError, { cause: error });
      })
      .finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }

  async #connect() {
    const generation = this.generation;
    this.state = 'connecting';
    this.lastError = null;
    const { baileys, pino, qrcode } = await this.dependencyLoader();
    if (generation !== this.generation) throw new Error('whatsapp_connection_cancelled');
    await this.authWrites;
    this.qrcode = qrcode;
    fs.mkdirSync(path.join(this.dataDir, 'wa-auth'), { recursive: true });
    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys;
    const { state, saveCreds } = await useMultiFileAuthState(path.join(this.dataDir, 'wa-auth'));
    if (generation !== this.generation) throw new Error('whatsapp_connection_cancelled');
    const sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      browser: ['Offer Machine', 'Chrome', '3.1'],
    });
    this.sock = sock;
    sock.ev.on('creds.update', () => {
      if (this.sock !== sock || generation !== this.generation) return;
      this.authWrites = this.authWrites.then(saveCreds).catch(() => {
        if (this.sock !== sock || generation !== this.generation) return;
        this.lastError = 'whatsapp_session_save_failed';
        this.logger.error?.('WhatsApp session could not be saved');
      });
    });
    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (this.sock !== sock) return;
      if (qr) {
        this.qr = qr;
        this.state = 'qr';
        this.lastError = null;
      }
      if (connection === 'open') {
        this.qr = null;
        this.state = 'connected';
        this.lastError = null;
        this.reconnectAttempts = 0;
      }
      if (connection === 'close') {
        this.qr = null;
        this.sock = null;
        this.state = 'disconnected';
        const code = lastDisconnect?.error?.output?.statusCode;
        this.lastError =
          code === DisconnectReason.loggedOut
            ? 'whatsapp_logged_out'
            : code === 440
              ? 'whatsapp_connection_replaced'
              : code === 405
                ? 'whatsapp_protocol_rejected'
                : code === 408
                  ? 'whatsapp_network_unavailable'
                  : 'whatsapp_connection_closed';
        this.logger.error?.('WhatsApp disconnected', { code, error: this.lastError });
        if (
          ![DisconnectReason.loggedOut, 440, 405, 403].includes(code) &&
          this.reconnectAttempts < this.maxReconnectAttempts
        ) {
          this.reconnectAttempts++;
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect({ retry: true }).catch(() => {});
          }, 3000 * this.reconnectAttempts);
        }
      }
    });
    return this.status();
  }

  async qrDataUrl() {
    if (!this.qr || !this.qrcode) return null;
    return this.qrcode.toDataURL(this.qr, { margin: 1, width: 280 });
  }

  async groups() {
    if (!this.sock || !this.isReady()) throw new Error('whatsapp_not_connected');
    const map = await this.sock.groupFetchAllParticipating();
    return Object.values(map)
      .map((g) => ({ id: g.id, name: g.subject || g.id, size: g.participants?.length || 0 }))
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }

  async send(destination, text, imageUrl = '') {
    if (!this.sock || !this.isReady())
      throw Object.assign(new Error('whatsapp_not_connected'), { safeToRetry: true });
    if (!destination?.endsWith('@g.us'))
      throw Object.assign(new Error('invalid_whatsapp_group'), { safeToRetry: true });
    if (imageUrl)
      await this.sock.sendMessage(destination, { image: { url: imageUrl }, caption: text });
    else await this.sock.sendMessage(destination, { text, linkPreview: true });
  }
  // Restart the session with the saved credentials (button "Reconectar").
  async reconnect() {
    await this.close();
    this.lastError = null;
    return this.connect();
  }
  // Leave this WhatsApp account and delete the local session (button "Desconectar").
  async logout() {
    const socket = this.sock;
    try {
      await socket?.logout?.();
    } catch {
      /* The phone may already be unlinked. */
    }
    await this.close();
    fs.rmSync(path.join(this.dataDir, 'wa-auth'), { recursive: true, force: true });
    this.lastError = null;
    return this.status();
  }
  close() {
    this.generation++;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.sock;
    this.sock = null;
    this.qr = null;
    this.state = 'disconnected';
    socket?.end?.(new Error('Application stopped'));
    return this.authWrites;
  }
}
