import cv2
import numpy as np
from pathlib import Path
from src.ocr_engine import OCREngine
from src.bubble_segmentation import classify_text_region
from src.utils import load_image, save_image, get_logger

logger = get_logger("DetectionZone")

class ZoneVisualizer:
    def __init__(self, ocr_url="http://127.0.0.1:4000/api/v1"):
        # On initialise juste l'OCR, pas besoin de traducteur ou d'inpainter ici
        self.ocr = OCREngine(backend_url=ocr_url)

    def debug_page(self, image_path: str, output_path: str):
        logger.info(f"Analyse des zones pour : {image_path}")
        
        # 1. Charger l'image
        image = load_image(Path(image_path))
        display_img = image.copy()
        overlay = np.zeros_like(image)

        # 2. Détection OCR (Koharu doit être lancé !)
        boxes = self.ocr.detect(image)
        if not boxes:
            logger.warning("Aucun texte détecté. Vérifiez que Koharu est lancé.")
            return

        # 3. Segmentation Intelligente
        # C'est ici qu'on utilise ton nouveau module bubble_segmentation
        segmentation_data = classify_text_region(image, boxes)

        # 4. Dessin des zones
        for idx, res in segmentation_data.items():
            # BLEU = Bulle (Calme, Propre)
            # ROUGE = Texte Flottant (Attention, Risqué)
            color = (255, 0, 0) if res.label == "bubble" else (0, 0, 255) # BGR
            
            # Dessiner le masque sur l'overlay
            overlay[res.mask == 255] = color
            
            # Dessiner le polygone (la zone que le typesetter utilisera)
            pts = np.array(res.polygon, np.int32)
            cv2.polylines(display_img, [pts], True, color, 3)
            
            # Ajouter le label et la variance pour debug
            label_text = f"{res.label} (v:{res.variance:.3f})"
            cv2.putText(display_img, label_text, (res.polygon[0][0], res.polygon[0][1] - 10),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)

        # 5. Fusion et Sauvegarde
        # On mélange l'image originale avec les zones colorées (transparence 30%)
        result = cv2.addWeighted(overlay, 0.4, display_img, 0.6, 0)
        
        # Convertir en BGR pour OpenCV avant de sauvegarder avec ton utilitaire RGB
        save_image(result, output_path)
        logger.info(f"Visualisation sauvegardée dans : {output_path}")

if __name__ == "__main__":
    # Script rapide pour tester une image
    visualizer = ZoneVisualizer()
    
    # Remplace par le chemin d'une de tes images de test
    test_img = "input/803.jpg" 
    if Path(test_img).exists():
        visualizer.debug_page(test_img, "output/debug_zones_803.png")
    else:
        logger.error(f"Fichier {test_img} introuvable pour le test.")