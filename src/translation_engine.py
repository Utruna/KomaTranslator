"""
translation_engine.py
---------------------
Translates manga/manhua dialogue using a Large Language Model (LLM).

The :class:`TranslationEngine` is provider-agnostic: swap the ``provider``
field in ``config.yaml`` and implement the matching ``_call_*`` method to use
a different backend (OpenAI, Anthropic, DeepSeek, …).

TODO integration points are marked with ``# TODO`` comments below.
"""

from __future__ import annotations

from typing import Any

from src.utils import get_logger

logger = get_logger(__name__)

# System prompt used for every translation request.
# It anchors the model to its role and expected output format.
_SYSTEM_PROMPT = """You are an expert manga and manhua translator.
Your task is to translate comic dialogue naturally and faithfully.

Rules:
- Preserve tone, register and character personality.
- Keep the translation concise so it fits inside a speech bubble.
- Output ONLY the translated text, with no additional commentary.
- If the input is already in the target language, return it unchanged.
- Never add quotation marks around your answer."""

_SYSTEM_PROMPT_SFX = """You are translating manga sound effects and game notifications.

Rules:
- Output 1 to 4 words maximum, in ALL CAPS.
- Phonetic sounds (impacts, explosions…): use French onomatopoeia (BOUM, CRAC, WHOOSH…).
- Game/cultivation UI text (e.g. "Energy +1"): translate literally and briefly.
- Keep operators like + and - as-is.
- Output ONLY the translated text."""


class TranslationEngine:
    """LLM-backed translation engine.

    Args:
        api_key:          API key for the chosen provider.
        provider:         LLM provider string: ``"openai"``, ``"anthropic"``,
                          ``"deepseek"``, or ``"custom"``.
        model:            Model identifier (e.g. ``"gpt-4o"``).
        source_language:  Language of the original text (e.g. ``"Chinese"``).
        target_language:  Desired output language (e.g. ``"French"``).
        max_tokens:       Maximum number of tokens in the model response.
        temperature:      Sampling temperature.

    Example::

        engine = TranslationEngine(
            api_key="sk-…",
            provider="openai",
            model="gpt-4o",
            source_language="Chinese",
            target_language="French",
        )
        translated = engine.translate("你好，世界！")
    """

    def __init__(
        self,
        api_key: str = "ollama",
        provider: str = "openai",
        model: str = "llama3.1",
        source_language: str = "Chinese",
        target_language: str = "French",
        max_tokens: int = 256,
        temperature: float = 0.3,
        base_url: str = "http://localhost:11434/v1",
    ) -> None:
        self.api_key = api_key
        self.provider = provider.lower()
        self.model = model
        self.base_url = base_url
        self.source_language = source_language
        self.target_language = target_language
        self.max_tokens = max_tokens
        self.temperature = temperature
        

        self._client: Any = self._build_client()

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _build_client(self) -> Any:
        """Instantiate the provider-specific API client.

        TODO: Add your preferred provider's client initialisation here.
              Example for Anthropic::

                  import anthropic
                  return anthropic.Anthropic(api_key=self.api_key)
        """
        if self.provider == "openai":
            return self._build_openai_client()
        elif self.provider == "anthropic":
            # TODO: implement Anthropic client
            raise NotImplementedError("Anthropic provider not yet implemented.")
        elif self.provider == "deepseek":
            # TODO: implement DeepSeek client (compatible with the OpenAI SDK)
            raise NotImplementedError("DeepSeek provider not yet implemented.")
        elif self.provider == "custom":
            # TODO: implement a generic REST / httpx client for custom endpoints
            raise NotImplementedError("Custom provider not yet implemented.")
        else:
            raise ValueError(f"Unknown translation provider: '{self.provider}'")

    def _build_openai_client(self) -> Any:
        """Build an OpenAI client.

        TODO: To target an OpenAI-compatible endpoint (e.g. a local Ollama
              instance), pass ``base_url="http://localhost:11434/v1"`` to the
              ``OpenAI()`` constructor.
        """
        try:
            from openai import OpenAI  # type: ignore[import]
            return OpenAI(
                api_key=self.api_key, 
                base_url=self.base_url
            )
        except ImportError as exc:
            raise ImportError(
                "openai package is not installed.  Run: pip install openai"
            ) from exc

    def _build_user_message(self, text: str) -> str:
        """Format the user turn for the LLM.

        Args:
            text: Source text to translate.

        Returns:
            Formatted prompt string.
        """
        return (
            f"Translate the following {self.source_language} manga dialogue "
            f"into {self.target_language}.\n\n"
            f"Original text:\n{text}"
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def translate(self, text: str) -> str:
        """Translate a single piece of text.

        Args:
            text: Source text extracted from a speech bubble.

        Returns:
            Translated string.

        Raises:
            RuntimeError: If the API call fails or returns an empty response.

        TODO: Add retry logic / exponential back-off for network errors.
        TODO: Add a local cache (e.g. ``functools.lru_cache`` or a simple
              dict) to avoid re-translating identical strings.
        """
        if not text.strip():
            return text

        logger.debug("Translating: '%s'", text)

        if self.provider == "openai":
            return self._call_openai(text)
        # TODO: route other providers here once implemented
        raise NotImplementedError(f"Provider '{self.provider}' has no call implementation yet.")

    def translate_sfx(self, text: str) -> str:
        """Translate a sound effect or game notification with the SFX prompt."""
        if not text.strip():
            return text
        logger.debug("Translating SFX: '%s'", text)
        if self.provider == "openai":
            return self._call_openai(text, system_prompt=_SYSTEM_PROMPT_SFX)
        raise NotImplementedError(f"Provider '{self.provider}' has no call implementation yet.")

    def translate_batch(self, texts: list[str]) -> list[str]:
        """Translate a list of strings sequentially.

        Args:
            texts: List of source strings.

        Returns:
            List of translated strings in the same order.

        TODO: Replace with a true batch call if the chosen provider
              supports it, to reduce latency and API costs.
        """
        return [self.translate(t) for t in texts]

    # ------------------------------------------------------------------
    # Provider-specific call implementations
    # ------------------------------------------------------------------

    def _call_openai(self, text: str, system_prompt: str = _SYSTEM_PROMPT) -> str:
        """Send a translation request to the OpenAI Chat Completions API."""
        user_msg = self._build_user_message(text)
        logger.info("\n--- LLM API INPUT ---\nModel: %s\nPrompt:\n%s\n---------------------", self.model, user_msg)

        response = self._client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_msg},
            ],
            max_tokens=self.max_tokens,
            temperature=self.temperature,
        )

        if not response.choices:
            raise RuntimeError("OpenAI/Local LLM returned an empty response.")

        translated = response.choices[0].message.content or ""
        logger.info("\n--- LLM API OUTPUT ---\n%s\n----------------------", translated.strip())
        
        return translated.strip()
