import { VERSION } from '../shared/version.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Platform } from '../application/platform.mjs';
import { RULES } from '../domain/rules.mjs';
import { CAPTURE_PROTOCOL, importMessages } from '../shared/capture-contract.mjs';
const messages = {
  ...importMessages,
  capture_browser_required:
    'Abra o Chrome com a extensão Offer conectada para validar o produto e gerar o link automaticamente.',
  publication_paused: 'Os envios estão pausados. Use Retomar envios ou ligue o Offer.',
  publication_evidence_expires_before_schedule:
    'A confirmação de preço e estoque vencerá antes do horário disponível. Aprove menos ofertas por vez ou confira novamente perto do envio.',
  publication_review_required: 'Abra a prévia atual antes de aprovar o envio.',
  publication_review_changed:
    'Os dados, a mensagem ou o grupo mudaram. Confira a prévia atualizada e confirme novamente.',
  publication_confirmation_required: 'Confira a mensagem e confirme a aprovação.',
  publication_not_ready: 'Atualize os dados antes de aprovar.',
  destination_not_configured: 'Escolha um grupo para receber ofertas em Canais.',
  invalid_whatsapp_group: 'Escolha um grupo da conta conectada.',
  whatsapp_not_connected: 'Conecte o WhatsApp em Canais.',
  whatsapp_dependencies_missing: 'Execute INSTALAR.bat para instalar a conexão do WhatsApp.',
  whatsapp_initialization_failed: 'O WhatsApp não iniciou. Tente conectar novamente.',
  affiliate_confirmation_required: 'Confirme que gerou este link na sua conta.',
  affiliate_link_required: 'Informe o link da sua conta afiliada.',
  invalid_affiliate_domain: 'Use o link oficial gerado na sua conta.',
  official_short_link_required: 'Use o link curto oficial https://meli.la/…',
  duplicate_offer: 'Essa oferta já foi salva. Use a oferta existente.',
  offer_not_found: 'Oferta não encontrada.',
  offer_not_editable: 'Cancele o agendamento antes de editar.',
  offer_identity_locked: 'Produto ou link mudou. Cadastre uma nova oferta.',
  invalid_url: 'Use um link HTTPS válido.',
  invalid_price: 'Informe um preço válido.',
  invalid_schedule: 'Escolha uma data válida para o agendamento.',
  title_required: 'Informe o título.',
  delivery_not_cancellable: 'Este envio já iniciou ou terminou.',
  delivery_confirmation_required: 'Confira o grupo e confirme que a mensagem não foi enviada.',
  unsupported_marketplace: 'Escolha Mercado Livre, Amazon ou Shopee.',
  invalid_request: 'Confira os campos e tente novamente.',
  invalid_image_url:
    'Use uma imagem HTTPS hospedada pela própria loja ou deixe a imagem em branco.',
  publication_duplicate_product:
    'O lote contém duas versões do mesmo produto para o mesmo grupo. Selecione apenas uma.',
  stock_confirmation_required: 'Confirme preço e estoque depois de conferir o produto.',
};
function reply(res, status, data) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(data));
}
async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || ''))
    throw new Error('invalid_request');
  let total = 0,
    chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > CAPTURE_PROTOCOL.maxBodyBytes) throw new Error('invalid_request');
    chunks.push(chunk);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!v || Array.isArray(v) || typeof v !== 'object') throw new Error();
    return v;
  } catch {
    throw new Error('invalid_request');
  }
}
export function createServer({
  store,
  publisher,
  offers,
  root,
  platform = new Platform({ store, offers, policy: offers.policy }),
}) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    try {
      const url = new URL(req.url, 'http://127.0.0.1'),
        route = url.pathname,
        port = server.address().port,
        origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
      const bridgePath = /^\/api\/bridge\/(jobs|result)$/.test(route);
      const extensionOrigin = `chrome-extension://${store.setting('bridge_extension_id')}`;
      const bridgeOrigin = bridgePath && req.headers.origin === extensionOrigin;
      // Opening the public shell from a link is navigation, not an API request.
      const panelNavigation =
        req.method === 'GET' &&
        route === '/' &&
        req.headers['sec-fetch-mode'] === 'navigate' &&
        req.headers['sec-fetch-dest'] === 'document';
      if (
        !origins.has(`http://${req.headers.host}`) ||
        (!bridgeOrigin &&
          !panelNavigation &&
          (req.headers['sec-fetch-site'] === 'cross-site' ||
            (req.headers.origin && !origins.has(req.headers.origin))))
      )
        return reply(res, 403, {
          ok: false,
          error: 'origin_rejected',
          message: 'Acesso permitido somente pelo painel local.',
        });
      if (bridgeOrigin) {
        res.setHeader('Access-Control-Allow-Origin', extensionOrigin);
        res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          return res.end();
        }
      }
      if (bridgePath && !platform.authenticate(req.headers.authorization?.replace(/^Bearer /, '')))
        return reply(res, 403, {
          ok: false,
          error: 'bridge_unauthorized',
          message: 'Conecte a extensão pelo painel.',
        });
      const files = {
        '/': ['index.html', 'text/html; charset=utf-8'],
        '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
        '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
        '/downloads/browser-extension.zip': ['browser-extension.zip', 'application/zip'],
      };
      if (req.method === 'GET' && route === '/capture-protocol.js') {
        res.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
        });
        return res.end(
          'export const CAPTURE_PROTOCOL = Object.freeze(' +
            JSON.stringify(CAPTURE_PROTOCOL) +
            ');',
        );
      }
      if (req.method === 'GET' && files[route]) {
        const [name, type] = files[route];
        res.writeHead(200, {
          'content-type': type,
          'cache-control': 'no-store',
          ...(type === 'application/zip'
            ? { 'content-disposition': 'attachment; filename=offer-machine-extension.zip' }
            : {}),
        });
        return res.end(fs.readFileSync(path.join(root, 'public', name)));
      }
      const state = async (section) => {
        const captures = store.captures();
        return {
          ok: true,
          version: VERSION,
          platform: platform.status(),
          whatsapp: {
            ...publisher.status(),
            ...(section === 'settings' ? { qrDataUrl: await publisher.qrDataUrl() } : {}),
          },
          destination: {
            id: store.setting('whatsapp_group_id'),
            name: store.setting('whatsapp_group_name'),
          },
          publicationPaused: store.setting('publication_paused', 'true') === 'true',
          automatic: platform.status().automaticEnabled,
          queue: store.queueStats(),
          daily: store.dailyStats(),
          rules: RULES,
          extension: {
            captures: captures.length,
            lastCaptureAt: captures[0]?.observed_at || null,
            productCaptures: captures.filter((c) => c.stage === 'product').length,
          },
          ...(section === 'offers' ? { items: platform.reviewItems() } : {}),
          ...(section === 'deliveries' ? deliveryPage() : {}),
        };
      };
      const deliveryPage = () =>
        store.deliveryPage({
          filter: url.searchParams.get('filter') || 'all',
          destination:
            url.searchParams.get('group') === 'all' ? null : url.searchParams.get('group'),
          before: url.searchParams.has('before') ? Number(url.searchParams.get('before')) : null,
        });
      if (req.method === 'GET') {
        const resolution = route.match(/^\/api\/captures\/(\d+)\/resolution$/);
        if (resolution)
          return reply(res, 200, { ok: true, ...platform.captureResolution(resolution[1]) });
        if (route === '/api/bridge/jobs')
          return reply(res, 200, { ok: true, job: platform.claimJob() });
        if (route === '/api/platform') return reply(res, 200, { ok: true, ...platform.status() });
        if (route === '/api/health')
          return reply(res, 200, { ok: true, version: VERSION, queue: store.queueStats() });
        if (route === '/api/view')
          return reply(res, 200, await state(url.searchParams.get('section') || 'offers'));
        if (route === '/api/state') return reply(res, 200, await state('settings'));
        if (route === '/api/offers')
          return reply(res, 200, { ok: true, items: platform.reviewItems() });
        if (route === '/api/queue') return reply(res, 200, { ok: true, ...deliveryPage() });
        if (route === '/api/browser-import/drafts')
          return reply(res, 200, { ok: true, drafts: store.captures() });
        if (route === '/api/whatsapp/groups')
          return reply(res, 200, { ok: true, groups: await publisher.groups() });
        const detail = route.match(/^\/api\/offers\/(\d+)(?:\/preview)?$/);
        if (detail) {
          const offer = store.getOffer(detail[1]);
          if (!offer) throw new Error('offer_not_found');
          return reply(res, 200, { ok: true, ...offers.preview(offer.id) });
        }
      }
      if (req.method === 'POST') {
        const data = await body(req);
        const resolveCapture = route.match(/^\/api\/captures\/(\d+)\/resolve$/);
        if (resolveCapture)
          return reply(res, 202, { ok: true, jobId: platform.resolveCapture(resolveCapture[1]) });
        if (route === '/api/bridge/pair')
          return reply(res, 200, { ok: true, ...platform.pair(data.extensionId) });
        if (route === '/api/bridge/result') {
          platform.completeJob(data.id, data.result);
          return reply(res, 200, { ok: true });
        }
        if (route === '/api/platform/groups')
          return reply(res, 200, {
            ok: true,
            groups: platform.saveGroup(
              data,
              platform.groups().some((g) => g.id === data.id)
                ? platform.groups()
                : await publisher.groups(),
            ),
          });
        if (route === '/api/platform/operation')
          return reply(res, 200, { ok: true, ...platform.setOperation(data.enabled) });
        if (route === '/api/platform/groups/delete')
          return reply(res, 200, { ok: true, groups: platform.deleteGroup(data.id) });
        if (route === '/api/platform/topics/delete')
          return reply(res, 200, { ok: true, topics: platform.deleteTopic(data.id) });
        if (route === '/api/platform/topics')
          return reply(res, 200, { ok: true, topics: platform.saveTopic(data) });
        if (route === '/api/platform/automatic') {
          const configured = platform.automation.configure(data);
          if (data.enabled) {
            store.setSetting('search_enabled', 'true');
            platform.tick(true);
          }
          return reply(res, 200, { ok: true, ...configured });
        }
        if (route === '/api/platform/search') {
          if (typeof data.enabled !== 'boolean') throw new Error('invalid_request');
          store.setSetting('search_enabled', String(data.enabled));
          if (!data.enabled)
            store.db
              .prepare(
                "UPDATE browser_jobs SET state='cancelled' WHERE state='pending' AND kind IN ('search','product')",
              )
              .run();
          if (data.enabled) platform.tick(true);
          return reply(res, 200, { ok: true, ...platform.status() });
        }
        if (route === '/api/platform/test')
          return reply(res, 202, {
            ok: true,
            diagnostic: platform.startDiagnostic(data.marketplace || 'mercadolivre'),
          });
        if (route === '/api/platform/validate')
          return reply(res, 202, {
            ok: true,
            jobId: platform.validateConnection(data.marketplace, data.productUrl),
          });
        if (route === '/api/review/preview')
          return reply(res, 200, { ok: true, ...platform.batchPreview(data.selection) });
        if (route === '/api/review/approve') {
          if (data.resume === true) store.setSetting('publication_paused', 'false');
          return reply(res, 200, { ok: true, ...platform.approveBatch(data) });
        }
        if (route === '/api/review/discard') {
          platform.discard(data);
          return reply(res, 200, { ok: true });
        }
        if (route === '/api/browser-import/capture')
          return reply(res, 201, {
            ok: true,
            items: offers.capture(data.packet, data.confirmed),
            queued: false,
          });
        const prepare = route.match(/^\/api\/captures\/(\d+)\/prepare$/);
        if (prepare) {
          const offer = offers.prepare(prepare[1], data);
          return reply(res, 201, {
            ok: true,
            offer,
            ...offers.preview(offer.id),
            queued: false,
          });
        }
        if (route === '/api/offers') {
          const offer = offers.manual(data);
          return reply(res, 201, {
            ok: true,
            offer,
            ...offers.preview(offer.id),
            queued: false,
          });
        }
        const edit = route.match(/^\/api\/offers\/(\d+)\/edit$/);
        if (edit) {
          const offer = offers.manual(data, edit[1]);
          return reply(res, 200, { ok: true, ...offers.preview(offer.id) });
        }
        const publish = route.match(/^\/api\/offers\/(\d+)\/publish$/);
        if (publish)
          return reply(res, 200, { ok: true, delivery: offers.publish(Number(publish[1]), data) });
        const cancel = route.match(/^\/api\/queue\/(\d+)\/cancel$/);
        if (cancel) return reply(res, 200, { ok: true, delivery: store.cancelDelivery(cancel[1]) });
        const retry = route.match(/^\/api\/queue\/(\d+)\/retry$/);
        if (retry) {
          store.retryUncertain(retry[1], data.confirmedNotSent);
          return reply(res, 200, { ok: true });
        }
        if (route === '/api/publication/pause') {
          if (typeof data.paused !== 'boolean') throw new Error('invalid_request');
          store.setSetting('publication_paused', String(data.paused));
          store.event('publication_pause_changed', null, { paused: data.paused });
          return reply(res, 200, { ok: true, paused: data.paused });
        }
        if (route === '/api/whatsapp/connect')
          return reply(res, 200, { ok: true, ...(await publisher.connect()) });
        if (route === '/api/whatsapp/reconnect')
          return reply(res, 200, { ok: true, ...(await publisher.reconnect()) });
        if (route === '/api/whatsapp/logout')
          return reply(res, 200, { ok: true, ...(await publisher.logout()) });
      }
      return reply(res, 404, {
        ok: false,
        error: 'not_found',
        message: 'Esta operação não faz parte da versão atual.',
      });
    } catch (error) {
      const known =
        messages[error.message] ||
        /^(invalid_|affiliate_|coupon_|product_|browser_import_|offer_|publication_|whatsapp_|delivery_|destination_)/.test(
          error.message,
        );
      if (!known) console.error('Request failed', { code: 'internal_error' });
      reply(
        res,
        ['duplicate_offer', 'publication_review_changed'].includes(error.message)
          ? 409
          : error.message === 'offer_not_found'
            ? 404
            : known
              ? 400
              : 500,
        {
          ok: false,
          error: known ? error.message : 'internal_error',
          message:
            error.userMessage ||
            messages[error.message] ||
            (known
              ? 'Confira os dados e tente novamente.'
              : 'Falha interna; consulte o diagnóstico local.'),
        },
      );
    }
  });
  return server;
}
