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

import os
from typing import Any

from src.utils import get_logger

logger = get_logger(__name__)

# Instructions in English: LLMs follow English system prompts more reliably
# across providers, including local models like llama3.1.
_SYSTEM_PROMPT = """You are a manga/manhua translator. Translate the given Chinese text into natural, idiomatic French.

OUTPUT RULES (mandatory):
Return ONLY the translated text. No quotes, no preface, no explanation.
Never repeat the source text. Never justify your translation.

TRANSLATION RULES:
Use natural French, not word-for-word. Preserve the speaker register (vulgar stays vulgar, formal stays formal, childlike stays childlike).
Be concise: French runs longer than Chinese, so compress actively. If your translation exceeds 1.3x the source character count, rephrase shorter.
Do not translate character names or place names.

SPECIAL CASES:
UI or game notifications (e.g. 能量+1, 经验值+500, 等级提升): translate once, literally and briefly. 能量+1 becomes Energie +1. Keep operators like + and -.
Onomatopoeia (e.g. 啊 轰 嗖 哈哈): use the French manga equivalent (啊 -> Aah, 哈哈 -> Ha ha, 轰 -> BOOM). If no clear equivalent, transliterate.
Text already in Latin script: return it unchanged.
Fragmented or unreadable OCR text: return the source as-is."""

# Context is capped at 3 entries: enough for coherence without overloading
# local models whose effective context window for instructions is short.
_CONTEXT_LIMIT = 3

_SFX_SYSTEM_PROMPT = """You are translating manga sound effects and ambient text into French.
Return ONLY the translated text. No quotes, no comment.
Sound effects: use French onomatopoeia in ALL CAPS (轰 -> BOOM, 嗖 -> SWISH, 砰 -> BANG).
If no French equivalent exists, keep the original phonetics in ALL CAPS.
Game or UI text: translate literally and briefly, keep operators like + and -."""

_ENV_KEYS: dict[str, str] = {
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
}


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
        self.provider = provider.lower()
        self.model = model
        self.base_url = base_url
        self.source_language = source_language
        self.target_language = target_language
        self.max_tokens = max_tokens
        self.temperature = temperature

        # Resolve API key from environment when not explicitly provided.
        if api_key == "" and self.provider in _ENV_KEYS:
            api_key = os.environ.get(_ENV_KEYS[self.provider], "")
            if not api_key:
                logger.warning(
                    "No API key provided for provider '%s'. Set the %s environment variable.",
                    self.provider,
                    _ENV_KEYS[self.provider],
                )
        self.api_key = api_key

        self._client: Any = self._build_client()

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _build_client(self) -> Any:
        """Instantiate the provider-specific API client."""
        if self.provider == "openai":
            return self._build_openai_client()
        elif self.provider == "anthropic":
            return self._build_anthropic_client()
        elif self.provider == "deepseek":
            return self._build_deepseek_client()
        elif self.provider == "custom":
            # TODO: implement a generic REST / httpx client for custom endpoints
            raise NotImplementedError("Custom provider not yet implemented.")
        else:
            raise ValueError(f"Unknown translation provider: '{self.provider}'")

    def _build_openai_client(self) -> Any:
        """Build an OpenAI client (also used for Ollama-compatible local endpoints)."""
        try:
            from openai import OpenAI  # type: ignore[import]
            return OpenAI(api_key=self.api_key, base_url=self.base_url)
        except ImportError as exc:
            raise ImportError(
                "openai package is not installed.  Run: pip install openai"
            ) from exc

    def _build_anthropic_client(self) -> Any:
        """Build an Anthropic client.

        Note: base_url is ignored — the Anthropic SDK manages its own endpoint.
        """
        try:
            import anthropic  # type: ignore[import]
            return anthropic.Anthropic(api_key=self.api_key)
        except ImportError as exc:
            raise ImportError(
                "anthropic package is not installed.  Run: pip install anthropic"
            ) from exc

    def _build_deepseek_client(self) -> Any:
        """Build a DeepSeek client using the OpenAI-compatible SDK.

        Note: base_url is ignored — the DeepSeek endpoint is fixed.
        """
        try:
            from openai import OpenAI  # type: ignore[import]
            return OpenAI(api_key=self.api_key, base_url="https://api.deepseek.com")
        except ImportError as exc:
            raise ImportError(
                "openai package is not installed.  Run: pip install openai"
            ) from exc

    def _build_user_message(
        self,
        text: str,
        context: list[str] | None = None,
        is_sfx: bool = False,
    ) -> str:
        """Format the user turn for the LLM.

        Args:
            text:    Source text to translate.
            context: Previous translations on the same page, for coherence.
            is_sfx:  True when translating a floating sound effect or UI element.

        Returns:
            Formatted prompt string.
        """
        if is_sfx:
            return f"Sound effect or ambient text to translate into {self.target_language}:\n{text}"

        if context:
            recent = context[-_CONTEXT_LIMIT:]
            ctx_lines = "\n".join(f"- {t}" for t in recent)
            return (
                f"Previous dialogue on this page (for context only, do not translate again):\n"
                f"{ctx_lines}\n\n"
                f"Now translate this bubble:\n{text}"
            )

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
        user_msg = self._build_user_message(text)

        if self.provider == "openai":
            return self._call_openai(user_msg)
        elif self.provider == "anthropic":
            return self._call_anthropic(user_msg)
        elif self.provider == "deepseek":
            return self._call_deepseek(user_msg)
        raise NotImplementedError(f"Provider '{self.provider}' has no call implementation yet.")

    def translate_sfx(self, text: str) -> str:
        """Translate a floating sound effect or game notification.

        Uses a tighter prompt tuned for short, punchy SFX output rather than
        dialogue naturalness.

        Args:
            text: Source SFX or UI string.

        Returns:
            Translated string (typically short, ALL CAPS for sounds).
        """
        if not text.strip():
            return text

        logger.debug("Translating SFX: '%s'", text)
        user_msg = self._build_user_message(text, is_sfx=True)

        if self.provider == "openai":
            return self._call_openai(user_msg, system_prompt=_SFX_SYSTEM_PROMPT)
        elif self.provider == "anthropic":
            return self._call_anthropic(user_msg, system_prompt=_SFX_SYSTEM_PROMPT)
        elif self.provider == "deepseek":
            return self._call_deepseek(user_msg, system_prompt=_SFX_SYSTEM_PROMPT)
        raise NotImplementedError(f"Provider '{self.provider}' has no call implementation yet.")

    def translate_with_context(self, text: str, context: list[str] | None = None) -> str:
        """Translate a bubble with awareness of preceding dialogue on the same page.

        Args:
            text:    Source text extracted from a speech bubble.
            context: List of already-translated strings from earlier bubbles on
                     this page. At most the last 3 are included in the prompt.

        Returns:
            Translated string.
        """
        if not text.strip():
            return text

        logger.debug("Translating with context (%d entries): '%s'", len(context or []), text)
        user_msg = self._build_user_message(text, context=context)

        if self.provider == "openai":
            return self._call_openai(user_msg)
        elif self.provider == "anthropic":
            return self._call_anthropic(user_msg)
        elif self.provider == "deepseek":
            return self._call_deepseek(user_msg)
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

    def _call_openai_compatible(self, user_msg: str, system_prompt: str = _SYSTEM_PROMPT) -> str:
        """Shared logic for OpenAI Chat Completions-compatible providers."""
        logger.info(
            "\n--- LLM API INPUT ---\nModel: %s\nPrompt:\n%s\n---------------------",
            self.model,
            user_msg,
        )

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

    def _call_openai(self, user_msg: str, system_prompt: str = _SYSTEM_PROMPT) -> str:
        """Send a translation request to the OpenAI Chat Completions API."""
        return self._call_openai_compatible(user_msg, system_prompt=system_prompt)

    def _call_deepseek(self, user_msg: str, system_prompt: str = _SYSTEM_PROMPT) -> str:
        """Send a translation request to the DeepSeek API (OpenAI-compatible)."""
        return self._call_openai_compatible(user_msg, system_prompt=system_prompt)

    def _call_anthropic(self, user_msg: str, system_prompt: str = _SYSTEM_PROMPT) -> str:
        """Send a translation request to the Anthropic Messages API."""
        logger.info(
            "\n--- LLM API INPUT ---\nModel: %s\nPrompt:\n%s\n---------------------",
            self.model,
            user_msg,
        )

        response = self._client.messages.create(
            model=self.model,
            max_tokens=self.max_tokens,
            temperature=self.temperature,
            system=system_prompt,
            messages=[{"role": "user", "content": user_msg}],
        )

        if not response.content or not response.content[0].text:
            raise RuntimeError("Anthropic returned an empty response.")

        translated = response.content[0].text
        logger.info("\n--- LLM API OUTPUT ---\n%s\n----------------------", translated.strip())
        return translated.strip()
