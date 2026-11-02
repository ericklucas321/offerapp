// Runs only in the local Offer panel; store credentials remain in the browser.
window.addEventListener('message', async (event) => {
  if (
    event.source !== window ||
    event.origin !== location.origin ||
    event.data?.source !== 'offer-panel'
  )
    return;
  if (event.data.type === 'identify')
    window.postMessage(
      { source: 'offer-extension', type: 'identity', extensionId: chrome.runtime.id },
      location.origin,
    );
  if (event.data.type === 'pair' && /^[a-f0-9]{64}$/.test(event.data.token || '')) {
    const response = await chrome.runtime.sendMessage({
      type: 'pair',
      token: event.data.token,
      base: location.origin,
    });
    if (response?.ok)
      window.postMessage({ source: 'offer-extension', type: 'paired' }, location.origin);
  }
});
