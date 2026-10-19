// Tab Control — offscreen document (no UI).
// The background service worker has no DOM, so it cannot write to the clipboard;
// it opens this page and asks it to copy. navigator.clipboard needs a focused
// document, which an offscreen page never is, so this uses execCommand('copy'),
// which works here thanks to the clipboardWrite permission.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen' || msg.type !== 'copy') return false;
  const textarea = document.createElement('textarea');
  textarea.value = msg.text;
  document.body.append(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  textarea.remove();
  sendResponse({ ok });
  return false;
});
