// Charge les modules de l'extension (écrits pour le navigateur) dans Node: `self` = l'objet global.
globalThis.self = globalThis;
require("../extension/lib/translate.js");
require("../extension/lib/store.js");
module.exports = { T: self.KomaTranslate, S: self.KomaStore };
