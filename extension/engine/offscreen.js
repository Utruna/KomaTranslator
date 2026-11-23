// Chrome: reçoit les images du service worker et renvoie le résultat de l'OCR
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== "offscreen" || msg.type !== "ocr") return false;
  const s = atob(msg.b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  KomaOCR.analyze(new Blob([bytes], { type: msg.mime }), msg.lang)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
  return true;
});
KomaOCR.warmup().catch(() => {});
