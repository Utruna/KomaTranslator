# KomaTranslator

KomaTranslator est un framework modulaire, extensible et automatisé dédié au scanlation (traduction de mangas, webtoons et comics). Il gère le processus de bout en bout : de la détection du texte original à l'insertion du texte traduit dans les bulles, en passant par le nettoyage (inpainting) et la traduction via LLM.

## ✨ Fonctionnalités

Le pipeline s'articule autour de 4 moteurs configurables indépendamment :

- **🔍 OCR (`ocr_engine.py`)** : Extraction du texte et de ses boîtes englobantes (basé sur PaddleOCR). Calcule automatiquement les boîtes de délimitation.
- **🧹 Inpainter (`inpainter.py`)** : Nettoyage des bulles et effacement du texte d'origine. Supporte `OpenCV` (méthodes Telea/NS) prêt à l'emploi. Prêt à intégrer un modèle avancé comme **LaMa** pour les décors complexes.
- **🌐 Traduction (`translation_engine.py`)** : Moteur agnostique basé sur des LLMs. Fournit un prompt système optimisé pour les BDs. Facilement extensible avec des fournisseurs externes (OpenAI, Anthropic, DeepSeek, Ollama local).
- **✍️ Typesetter (`typesetter.py`)** : Restitution du texte traduit dans les bulles nettoyées. Ajustement automatique de la taille de la police, gestion intelligente des retours à la ligne (Pillow) et support de contours (stroke/outline) pour la lisibilité.

## 🏗️ Architecture du Pipeline

L'orchestrateur central (`pipeline.py`) enchaîne les opérations étape par étape :
1. `OCR` identifie les blocs de texte sur l'image source.
2. `Translation` reçoit le texte extrait et renvoie la version cible.
3. `Inpainting` efface le texte d'origine pour préparer la zone `(bulle/background)`.
4. `Typesetting` dessine la traduction sur l'image « nettoyée ».

## 📂 Structure du projet

```text
KomaTranslator/
├── config.yaml          # Configuration centralisée (chemins, clés API, paramètres OCR/Inpainting/Typesetting)
├── main.py              # Point d'entrée CLI
├── README.md            # Ce fichier
├── requirements.txt     # Dépendances Python du projet
├── src/
│   ├── __init__.py
│   ├── inpainter.py        
│   ├── ocr_engine.py       
│   ├── pipeline.py         
│   ├── translation_engine.py 
│   ├── typesetter.py       
│   └── utils.py          # Outils utilitaires (logger, I/O images RGB NumPy, chargement de config)
├── fonts/               # Dossier pour vos polices TTF/OTF
├── input/               # Placez vos images source ici
├── output/              # Les images finalisées seront générées ici
└── models/              # Poids des modèles (PaddleOCR, points de contrôle LaMa, etc.)
```

## 🚀 Installation

1. **Cloner le dépôt** (ou naviguer dans le dossier du projet)
2. **Créer un environnement virtuel** (recommandé) :
   ```bash
   python -m venv venv
   .\venv\Scripts\Activate.ps1   # (Windows)
   # ou
   source venv/bin/activate      # (Linux/macOS)
   ```
3. **Installer les dépendances** :
   ```bash
   pip install -U pip
   pip install -r requirements.txt
   ```

## ⚙️ Configuration

Toutes les préférences de l'application sont centralisées dans `config.yaml`.  
C'est ici que vous définissez :
- Les répertoires de polices (`fonts/`), input/output.
- Vos clés API (pour le moteur de traduction).
- Les modèles à utiliser (ex: OpenCV ou LaMa pour l'inpainting).

## 🎮 Utilisation

L'utilisation se fait via le script principal `main.py`, qui embarque une interface CLI (Command Line Interface).

Exemple de commande standard :
```bash
python main.py --config config.yaml --input input/ --output output/
```

Il traitera toutes les images présentes dans le dossier d'entrée défini et recrachera les versions traduites dans le dossier de sortie.

## 🧾 Compte rendu des avancées

Les points suivants ont déjà été stabilisés dans le projet :

- **Typesetter** : mesure correcte du texte multiligne, centrage vertical corrigé avec `anchor="mm"`, et cohérence entre `font_size` et `max_font_size`.
- **OCR / Koharu** : polling plus robuste sur `GET /operations`, délai d'attente suffisant avant lecture de `scene.json`, logs DEBUG ajoutés, et fallback vers un engine OCR chinois valide.
- **Configuration** : paramètres rendus configurables dans `config.yaml` pour l'engine OCR et le seuil de clustering du pipeline.
- **Pipeline** : regroupement des blocs de texte resserré pour éviter les fusions excessives entre bulles distinctes.

État actuel : le pipeline OCR → Traduction → Inpainting → Typesetting fonctionne de bout en bout sur une image de test, avec sortie générée dans `output/`.

## 🗺️ Roadmap & TODOs

Une fondation solide est en place, les prochaines étapes documentées dans le code (stubs `TODO`) sont :
- [ ] Connecter véritablement les endpoints API dans `translation_engine.py` (Appels Batch API, Anthropic, DeepSeek).
- [ ] Finaliser l'intégration du modèle **LaMa** dans `inpainter.py` (chargement du checkpoint et inférence).
- [ ] Ajouter la détection et la gestion du **texte vertical** (spécifique aux mangas et certaines traductions asiatiques).
- [ ] Implémenter une fallback de robustesse JSON pour le traducteur (si le LLM renvoie un JSON mal formatté).
