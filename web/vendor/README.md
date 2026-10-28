# Vendored libraries

`vnccs_pose_studio_core.mjs` is the VNCCS Pose Studio core from https://github.com/AHEKOT/ComfyUI_VNCCS_Utils (commit 70b752f2), MIT License, Copyright (c) 2025 MiuProject — see `LICENSE`. It reached this project through https://github.com/Work-Fisher/ComfyUI-Fisher-Pose (commit d116451f).
It ships with three.js r160 (MIT, see `THREE-LICENSE`) and its OrbitControls and TransformControls.

Local changes to these files: the `.js` files were renamed to `.mjs` so ComfyUI does not auto-load them as extensions (it imports every `web/**/*.js`), and the three import paths inside them were updated to match.

In this fork the core is used only as the 3D viewer (renderer, cameras, orbit controls). The MakeHuman body pack, the skin texture, the morph runtime and the hand presets of the upstream distribution were removed together with the mannequin editor.

`gaussian-splats-3d.mjs` is `@mkkellogg/gaussian-splats-3d` 0.4.7 (MIT, see `GaussianSplats3D-LICENSE.txt`). `GLTFLoader.mjs` and `BufferGeometryUtils.mjs` are from three.js r160.
