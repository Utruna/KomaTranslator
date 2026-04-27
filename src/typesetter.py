"""
typesetter.py
"""

from __future__ import annotations
from pathlib import Path
from typing import Optional
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from src.utils import get_logger
logger = get_logger(__name__)

class Typesetter:
    def __init__(
        self,
        font_path: str = "src/police/animeace2bb_tt/animeace2_reg.ttf",
        font_size: int = 48,
        font_color: tuple[int, int, int] = (0, 0, 0),
        line_spacing: int = 4,
        max_font_size: int = 200,
        min_font_size: int = 12,
        stroke_width: int = 1,
        stroke_color: tuple[int, int, int] = (255, 255, 255),
    ):
        """
        Typesetter initialisation.
        
        Args:
            font_path: Chemin vers la police TTF/OTF
            font_size: Taille de police de départ (pt)
            font_color: Couleur du texte (RGB)
            line_spacing: Espacement entre les lignes
            max_font_size: Taille maximale de police
            min_font_size: Taille minimale de police
            stroke_width: Épaisseur du contour du texte
            stroke_color: Couleur du contour (par défaut blanc)
        """
        self.font_path = Path(font_path)
        self.font_size = font_size
        self.max_font_size = max_font_size
        self.min_font_size = min_font_size
        self.line_spacing = line_spacing
        self.font_color = font_color
        self.stroke_width = stroke_width
        self.stroke_color = stroke_color
        self._default_font = None

    def _load_font(self, size: int) -> ImageFont:
        """Charger la police ou utiliser un fallback système."""
        try:
            return ImageFont.truetype(str(self.font_path), size)
        except Exception:
            # Fallbacks système
            for path in [
                "C:/Windows/Fonts/arial.ttf",
                "/Library/Fonts/Arial.ttf",
                "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            ]:
                if Path(path).exists():
                    return ImageFont.truetype(str(path), size)
            logger.warning("Aucune police trouvée, utilisation de la police par défaut de Pillow.")
            return ImageFont.load_default()

    def render(self, image: np.ndarray, text: str, bbox: list[int], padding: int = 6) -> np.ndarray:
        """
        Rendre le texte dans la bulle.
        
        Args:
            image: Image numpy (H, W, 3)
            text: Texte à afficher
            bbox: Bounding box [x_min, y_min, x_max, y_max]
            padding: Padding interne
        
        Returns:
            Image modifiée avec le texte dessiné
        """
        x_min, y_min, x_max, y_max = bbox
        width = x_max - x_min - 2 * padding
        height = y_max - y_min - 2 * padding
        
        if width <= 0 or height <= 0:
            logger.warning("Bounding box trop petit, skipping.")
            return image.copy()
        
        # Ajuster la taille de police
        font, wrapped_text = self._fit_text(text, width, height)
        
        pil_img = Image.fromarray(image)
        draw = ImageDraw.Draw(pil_img)
        
        # Centrer le texte
        cx = x_min + padding + width // 2
        # Calculer la hauteur réelle du texte pour centrer verticalement
        text_bbox = font.getbbox(wrapped_text)
        text_height = text_bbox[3] - text_bbox[1]
        cy = y_min + padding + (height - text_height) // 2
        
        # Dessiner avec ou sans contour
        draw_kwargs: dict = {
            "xy": (cx, cy),
            "text": wrapped_text,
            "font": font,
            "fill": self.font_color,
            "align": "center",
            "spacing": self.line_spacing,
            "anchor": "mm",
        }
        
        if self.stroke_width > 0:
            draw_kwargs["stroke_width"] = self.stroke_width
            draw_kwargs["stroke_fill"] = self.stroke_color
        
        draw.multiline_text(**draw_kwargs)
        
        return np.array(pil_img)

    def _fit_text(self, text: str, width: int, height: int) -> tuple[ImageFont, str]:
        """Ajuster la taille de police pour que le texte tienne."""
        # Commencer avec une taille raisonnable
        starting_size = min(height, self.max_font_size)
        
        while starting_size >= self.min_font_size:
            font = self._load_font(starting_size)
            wrapped_text = self._wrap(text, font, width)
            bbox = font.getbbox(wrapped_text)
            
            text_height = bbox[3] - bbox[1]
            text_width = bbox[2] - bbox[0]
            
            # Vérifier si le texte tient dans la boîte
            if text_height <= height and text_width <= width:
                return font, wrapped_text
            
            # Réduire la taille
            starting_size -= 4  # Réduire progressivement
        
        # Dernier recours
        font = self._load_font(self.min_font_size)
        wrapped_text = self._wrap(text, font, width)
        return font, wrapped_text

    def _wrap(self, text: str, font: ImageFont, max_width: int) -> str:
        """Wrapper simple pour le texte."""
        lines = []
        for line in text.split("\n"):
            words = line.split()
            if not words:
                lines.append("")
                continue
            
            current = words[0]
            for word in words[1:]:
                test = current + (" " + word if current else word)
                test_bbox = font.getbbox(test)
                test_width = test_bbox[2] - test_bbox[0]
                
                if test_width <= max_width:
                    current = test
                else:
                    lines.append(current)
                    current = word
            lines.append(current)
        return "\n".join(lines)