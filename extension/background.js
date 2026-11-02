import { createBrowserWorker } from './browser-worker.js';
const worker = createBrowserWorker();
chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.type !== 'pair') return;
  if (
    !sender.tab?.url?.startsWith(message.base + '/') ||
    !/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(message.base) ||
    !/^[a-f0-9]{64}$/.test(message.token || '')
  )
    return;
  chrome.storage.local
    .set({ token: message.token, base: message.base })
    .then(() => {
      chrome.alarms.create('offer-worker', { periodInMinutes: 0.5 });
      respond({ ok: true });
      worker.run();
    })
    .catch(() => respond({ ok: false }));
  return true;
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'offer-worker') worker.run();
});
const initialize = () => {
  chrome.alarms.create('offer-worker', { periodInMinutes: 0.5 });
  worker.run();
};
chrome.runtime.onStartup.addListener(initialize);
chrome.runtime.onInstalled.addListener(initialize);
