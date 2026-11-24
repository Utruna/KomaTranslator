// KomaTranslator — traducteurs: réglages par défaut, préréglages d'API, profils (une clé par préréglage).
// Partagé par le background, le popup et les options. Fonctions pures: elles renvoient une nouvelle cfg.
(() => {
  const DEFAULT_BASE = "https://api.deepseek.com/v1";

  /** Réglages du traducteur (chrome.storage.local, clé « cfg »; les clés API ne sont jamais synchronisées). */
  const CFG_DEFAULTS = {
    provider: "google",          // google | ollama | openai | anthropic
    ollamaUrl: "http://localhost:11434",
    ollamaModel: "qwen3.5:latest",
    ollamaKeepAlive: "5m",       // durée pendant laquelle Ollama garde le modèle en VRAM après la dernière requête
    apiBase: DEFAULT_BASE,
    apiKey: "",
    apiModel: "deepseek-flash",
    anthropicKey: "",
    anthropicModel: "claude-haiku-5-5",
    review: true,                // relecture (seulement avec un LLM)
    profiles: {},                // { deepseek: { apiKey, apiModel }, gemini: {…}, custom: { apiBase, apiKey, apiModel } }
  };

  /** Préréglages du fournisseur « API compatible OpenAI ». */
  const PRESETS = {
    deepseek: {
      label: "DeepSeek", sub: "≈ 2 c / chapitre", apiBase: DEFAULT_BASE, apiModel: "deepseek-flash",
      note: "Clé payante (prépaiement), sur platform.deepseek.com. Environ 2 centimes par chapitre de 30 pages.",
    },
    gemini: {
      label: "Gemini", sub: "palier gratuit", apiBase: "https://generativelanguage.googleapis.com/v1beta/openai", apiModel: "gemini-3.5-flash-lite",
      note: "Clé gratuite sur aistudio.google.com/apikey. Le palier gratuit est limité en requêtes par minute et par jour (voir ton compte), "
        + "et Google peut y réutiliser les textes envoyés pour améliorer ses produits : à vérifier dans leurs conditions. "
        + "Les modèles changent vite : si le test répond 404, prends un autre « gemini-…-flash-lite ».",
    },
  };

  /** Les traducteurs proposés dans le menu, dans l'ordre d'affichage. */
  const PROVIDERS = [
    { id: "google", label: "Google", sub: "gratuit" },
    { id: "deepseek", label: PRESETS.deepseek.label, sub: PRESETS.deepseek.sub },
    { id: "gemini", label: PRESETS.gemini.label, sub: PRESETS.gemini.sub },
    { id: "ollama", label: "Ollama", sub: "local, GPU" },
    { id: "anthropic", label: "Claude", sub: "clé API" },
    { id: "custom", label: "Autre API", sub: "compatible OpenAI" },
  ];

  /** Préréglage correspondant à une URL d'API: « deepseek », « gemini », ou « custom » pour toute autre. */
  const presetOfBase = (base) => Object.keys(PRESETS).find((k) => PRESETS[k].apiBase === (base || DEFAULT_BASE)) || "custom";

  /** Traducteur actif d'une cfg: google | ollama | anthropic | deepseek | gemini | custom. */
  function activeId(cfg) {
    const p = cfg.provider || "google";
    return p === "openai" ? presetOfBase(cfg.apiBase) : p;
  }

  /** Copie de cfg où le profil du traducteur « API » actif est mis à jour (clé et modèle ne se perdent pas en changeant). */
  function remember(cfg) {
    if ((cfg.provider || "google") !== "openai") return { ...cfg, profiles: { ...(cfg.profiles || {}) } };
    const id = presetOfBase(cfg.apiBase);
    const profile = { apiKey: cfg.apiKey || "", apiModel: cfg.apiModel || PRESETS[id]?.apiModel || "" };
    if (id === "custom") profile.apiBase = cfg.apiBase || "";
    return { ...cfg, profiles: { ...(cfg.profiles || {}), [id]: profile } };
  }

  /** Ce traducteur est-il utilisable (clé présente quand il en faut une) ? */
  function isReady(cfg, id) {
    if (id === "google" || id === "ollama") return true;
    if (id === "anthropic") return !!cfg.anthropicKey;
    const key = activeId(cfg) === id && (cfg.provider || "google") === "openai" ? cfg.apiKey : cfg.profiles?.[id]?.apiKey;
    return !!key;
  }

  /** Passe sur ce traducteur: la cfg reçoit le fournisseur, l'URL, le modèle et la clé du profil correspondant. */
  function select(cfg, id) {
    const c = remember(cfg);
    if (id === "google" || id === "ollama" || id === "anthropic") return { ...c, provider: id };
    const prof = c.profiles[id] || {};
    return {
      ...c, provider: "openai",
      apiBase: PRESETS[id] ? PRESETS[id].apiBase : prof.apiBase || c.apiBase,
      apiModel: prof.apiModel || PRESETS[id]?.apiModel || c.apiModel,
      apiKey: prof.apiKey || "",
    };
  }

  /** Nom du modèle utilisé par ce traducteur ("" pour Google). */
  function modelOf(cfg, id) {
    if (id === "ollama") return cfg.ollamaModel || CFG_DEFAULTS.ollamaModel;
    if (id === "anthropic") return cfg.anthropicModel || CFG_DEFAULTS.anthropicModel;
    if (id === "google") return "";
    const v = activeId(cfg) === id && cfg.provider === "openai" ? cfg.apiModel : cfg.profiles?.[id]?.apiModel;
    return v || PRESETS[id]?.apiModel || CFG_DEFAULTS.apiModel;
  }

  /** Change le modèle de ce traducteur (et son profil, pour les API). */
  function setModel(cfg, id, model) {
    if (id === "ollama") return { ...cfg, ollamaModel: model };
    if (id === "anthropic") return { ...cfg, anthropicModel: model };
    const c = { ...cfg, profiles: { ...(cfg.profiles || {}) } };
    c.profiles[id] = { ...(c.profiles[id] || {}), apiModel: model };
    if (c.provider === "openai" && activeId(c) === id) c.apiModel = model;
    return c;
  }

  self.KomaPresets = { CFG_DEFAULTS, PRESETS, PROVIDERS, DEFAULT_BASE, presetOfBase, activeId, remember, isReady, select, modelOf, setModel };
})();
