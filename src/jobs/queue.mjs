export function createQueueWorker({
  store,
  publisher,
  intervalMs = 5000,
  maxAttempts = 3,
  logger = console,
  preflight,
  finalCheck,
}) {
  if (typeof preflight !== 'function') throw new Error('publication_policy_required');
  let timer = null;
  let busy = false;
  let stopped = false;
  const idleWaiters = [];

  async function tick() {
    if (busy || stopped) return;
    busy = true;
    try {
      if (store.setting('publication_paused', 'false') === 'true') return;
      if (publisher.isReady && !publisher.isReady()) return;
      const job = store.nextDelivery();
      if (!job) return;
      {
        const check = await preflight(job);
        if (!check.allowed) {
          store.deferDelivery(job.delivery_id, check.reason, check.retryAfterMs ?? 15000);
          return;
        }
      }
      if (store.setting('publication_paused', 'false') === 'true') return;
      if (stopped) return;
      if (finalCheck) {
        const check = finalCheck(job);
        if (check?.then) throw new Error('publication_final_check_must_be_synchronous');
        if (!check.allowed) {
          store.deferDelivery(job.delivery_id, check.reason, check.retryAfterMs ?? 15000);
          return;
        }
      }
      if (!store.markSending(job.delivery_id)) return;
      let sendStarted = false;
      try {
        const { message, priceCents } = store.messageFor(job, { includePrice: true });
        store.saveAttemptMessage(job.delivery_id, message, priceCents);
        sendStarted = true;
        await publisher.send(job.delivery_destination, message, job.image_url || '');
        store.markSent(job.delivery_id, job.offer_id);
      } catch (e) {
        logger.error?.('delivery failed', e);
        if (sendStarted && e?.safeToRetry !== true)
          store.markUncertain(job.delivery_id, job.offer_id);
        else store.markRetry(job.delivery_id, job.offer_id, e?.message || e, maxAttempts);
      }
    } catch (e) {
      logger.error?.('queue error', e);
    } finally {
      busy = false;
      for (const resolve of idleWaiters.splice(0)) resolve();
    }
  }

  return {
    start() {
      stopped = false;
      if (!timer) timer = setInterval(tick, intervalMs);
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      return busy ? new Promise((resolve) => idleWaiters.push(resolve)) : Promise.resolve();
    },
    tick,
  };
}
