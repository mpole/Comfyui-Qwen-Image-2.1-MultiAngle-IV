# AnyAngle Studio · ImageVision fork

A trimmed, English-only fork of **[Comfyui-Qwen-Image-2.1-MultiAngle-T8](https://github.com/T8mars/Comfyui-Qwen-Image-2.1-MultiAngle-T8)** by T8mars / T8star (version 1.1.0, MIT). All credit for the original node, editor and workflows goes to the original author; this fork removes features and adds camera controls.

It is a ComfyUI custom node with an interactive 3D camera editor for Qwen Image 2.1: load or reconstruct a 3D subject, choose a camera, and export a coarse render of that view as the guide image for the [QI 2.1 AnyAngle LoRA](https://huggingface.co/lilylilith/QI_2.1_AnyAngle).

## Changes from the original

- **Removed:** pose, depth and canny guides, the MakeHuman mannequin workbench, the `structure_image` input, their Python dependencies and model downloads, and the documentation screenshots.
- **Translated:** the editor, node texts and error messages are English only.
- **Added:** a *Focal length (35 mm equiv.)* control for the shot camera, 8–400 mm. It is a dolly zoom: the subject keeps its size while the perspective changes. For GLB scenes the camera never moves inside the asset, so a very short lens shows more of the scene instead.
- **Added:** *Tilt* and *Roll* for the shot camera, a *Fit to frame* that measures the asset itself, and the aspect options *Fit to model* and *Auto fit*.
- **Added:** *Bake GLB* extracts a mesh from a reconstructed splat on request (ComfyUI's *Extract Mesh from Splat*) and loads it turned to the source photo's view. *Tilt* and *Edit scene* need a mesh and stay disabled for a splat. The splat and the GLB can be exported from the left panel.
- **Renamed:** node IDs (`AnyAngleStudioIV`, `AnyAngleOptionalLoRAIV`), routes (`/anyangle-studio-iv/*`), the data folder and the browser storage keys carry an IV suffix, so this fork can be installed next to the original. Workflows made with the original keep using the original nodes; use the bundled workflows or replace the nodes to switch to this fork.

## Install

Copy this folder into `ComfyUI/custom_nodes/` and restart ComfyUI. There are no Python dependencies.

| Feature | Files | Source |
|---|---|---|
| AnyAngle camera changes | `models/loras/QI2.1_AnyAngle.safetensors` (install manually) | [lilylilith/QI_2.1_AnyAngle](https://huggingface.co/lilylilith/QI_2.1_AnyAngle) |
| Photo-to-3D reconstruction | five TripoSplat files, installed by `python install_reconstruction.py` (about 3.78 GB) | [VAST-AI/TripoSplat](https://huggingface.co/VAST-AI/TripoSplat/tree/main) |
| Qwen Image 2.1 model, text encoder, VAE | provide separately | weights compatible with the workflow |

`install_reconstruction.py` places `triposplat_fp16.safetensors` in `models/diffusion_models/`, `birefnet.safetensors` in `models/background_removal/`, `dino_v3_vit_h.safetensors` in `models/clip_vision/`, and `flux2-vae.safetensors` and `triposplat_vae_decoder_fp16.safetensors` in `models/vae/`. Importing a GLB needs none of them.

## Use

1. Load `workflows/AnyAngle-Studio-Qwen21.json`.
2. Connect the original image to the Studio `reference_image` input and to the encoder's `image_1`. Connect `guide_image_2` to `image_2`, `prompt` to the encoder prompt, and `anyangle_lora_strength` to **AnyAngle Optional LoRA** `strength_model`.
3. Open the studio from the node, reconstruct the subject or import a GLB, set the camera, click **Apply to node**, and run the workflow.

The **Guide strategy** switch only changes the LoRA strength output and the prompt. *AnyAngle LoRA* outputs strength 1 with the LoRA's trained prompt `Change the camera angle from <image2> to <image1>.`; *Qwen base model* outputs strength 0 with a descriptive prompt and treats the guide as a second reference image.

## Notes

- Applied shots, guides and images are stored in `ComfyUI/input/anyangle_studio_iv/`, separate from the original's `anyangle_studio/`.
- Splats and GLBs are large, so they are stored in `ComfyUI/temp/anyangle_studio_iv/`, which ComfyUI clears when it starts. Applied shots keep running in workflows; to edit such a scene again, the studio reconstructs the connected photo anew, and imported or baked GLBs have to be imported or baked again. Use the export buttons to keep a splat or GLB.
- GLBs must embed their textures; Draco, Meshopt and KTX2 compression are not supported.
- The node's routes (`/anyangle-studio-iv/*`) have no login of their own. Keep ComfyUI on `127.0.0.1` or behind an authenticated proxy.
- `workflows/AnyAngle-Studio-Qwen21-Advanced.json` needs additional custom nodes that are not part of this fork.

## Credits and license

Original work: [T8mars/Comfyui-Qwen-Image-2.1-MultiAngle-T8](https://github.com/T8mars/Comfyui-Qwen-Image-2.1-MultiAngle-T8), MIT, Copyright (c) 2026 AnyAngle Studio T8 contributors. This fork stays under the same [MIT license](LICENSE) and keeps the original copyright notice.

Thanks, as in the original, to [AnyAngle](https://huggingface.co/lilylilith/QI_2.1_AnyAngle), [TripoSplat](https://github.com/VAST-AI-Research/TripoSplat), [Fisher Pose](https://github.com/Work-Fisher/ComfyUI-Fisher-Pose), [VNCCS](https://github.com/AHEKOT/ComfyUI_VNCCS_Utils) and [GaussianSplats3D](https://github.com/mkkellogg/GaussianSplats3D). Bundled third-party code keeps its own licenses; see [THIRD_PARTY.md](THIRD_PARTY.md). This is an independent integration, not an official plugin from the model authors.
