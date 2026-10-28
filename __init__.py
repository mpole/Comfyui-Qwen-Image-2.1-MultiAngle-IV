import io
import json

import folder_paths
import numpy as np
from PIL import Image
import torch

from .storage import StudioStore, conditioning_for
from .routes import register_routes
from .reconstruction import AnyAngleReconstructionOutput, AnyAngleBakeMesh
from .optional_lora import AnyAngleOptionalLoRA


def store():
    # Splats and meshes go to ComfyUI's temp folder, which is cleared when ComfyUI starts.
    return StudioStore(folder_paths.get_input_directory() + "/anyangle_studio_iv",
                       folder_paths.get_temp_directory() + "/anyangle_studio_iv")


class AnyAngleStudio:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"snapshot": ("STRING", {"default": "", "multiline": True})},
                "optional": {"reference_image": ("IMAGE", {"tooltip": "Original image for the studio. Also connect this image to Qwen image_1."})}}

    RETURN_TYPES = ("IMAGE", "STRING", "STRING", "FLOAT")
    RETURN_NAMES = ("guide_image_2", "prompt", "scene_json", "anyangle_lora_strength")
    FUNCTION = "render"
    CATEGORY = "IV/AnyAngle"
    DESCRIPTION = "Edit a 3D camera and apply its clean guide. Connect the original separately to Qwen image_1."

    @classmethod
    def VALIDATE_INPUTS(cls, snapshot):
        try:
            store().load_scene(snapshot)
        except (ValueError, OSError) as error:
            return str(error)
        return True

    # structure_image is accepted but unused: workflows saved with the upstream node may still link it.
    def render(self, snapshot, reference_image=None, structure_image=None):
        document, png = store().load_scene(snapshot)
        ui = {}
        model = conditioning_for(document["scene"])
        if reference_image is not None:
            pixels = np.clip(reference_image[0].cpu().float().numpy() * 255, 0, 255).astype(np.uint8)
            buffer = io.BytesIO()
            Image.fromarray(pixels).save(buffer, format="PNG")
            reference = store().asset(buffer.getvalue(), "png")
            source = document["scene"]["source"]
            if source["kind"] == "splat" and source["reference"]["name"] != reference["name"]:
                raise ValueError("The source image changed; open AnyAngle Studio, reconstruct again and apply the shot")
            reference["label"] = "IMAGE input"
            document["scene"]["reference"] = reference
            ui["anyangle_reference"] = [reference]
        with Image.open(io.BytesIO(png)) as image:
            pixels = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
        result = (torch.from_numpy(pixels)[None], document["prompt"],
                  json.dumps(document["scene"], ensure_ascii=False), 1.0 if model == "anyangle" else 0.0)
        return {"ui": ui, "result": result}


NODE_CLASS_MAPPINGS = {"AnyAngleStudioIV": AnyAngleStudio, "AnyAngleOptionalLoRAIV": AnyAngleOptionalLoRA,
                       "AnyAngleReconstructionOutputIV": AnyAngleReconstructionOutput,
                       "AnyAngleBakeMeshIV": AnyAngleBakeMesh}
NODE_DISPLAY_NAME_MAPPINGS = {"AnyAngleStudioIV": "Comfyui-Qwen-Image-2.1-MultiAngle-IV",
                              "AnyAngleOptionalLoRAIV": "AnyAngle Optional LoRA · IV"}
WEB_DIRECTORY = "./web"
register_routes(store)
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
