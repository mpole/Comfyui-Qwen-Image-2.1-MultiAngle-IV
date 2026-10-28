import base64
import copy
import io
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
import zlib
import zipfile

from PIL import Image

sys.path.insert(0, str(Path(__file__).parents[1]))
from storage import StudioStore, BASE_PROMPT


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = StudioStore(self.directory.name)
        buffer = io.BytesIO()
        Image.new("RGB", (96, 64), (32, 77, 119)).save(buffer, "PNG")
        self.png = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()
        raw = json.dumps({"asset": {"version": "2.0"}}).encode()
        raw += b" " * (-len(raw) % 4)
        glb = struct.pack("<4sII", b"glTF", 2, 20 + len(raw)) + struct.pack("<I4s", len(raw), b"JSON") + raw
        self.scene = {"version": 1, "width": 96, "height": 64, "source": {**self.store.asset(glb, "glb"), "kind": "glb"},
                      "camera": {"azimuth": 45, "elevation": 15, "zoom": 1, "offsetX": 0, "offsetY": 0}}

    def test_applied_scene_survives_new_store_and_preserves_pixels(self):
        token = self.store.save_scene(self.scene, self.png)
        document, data = StudioStore(self.directory.name).load_scene(json.dumps(token))
        self.assertEqual(document["scene"], self.scene)
        self.assertEqual(Image.open(io.BytesIO(data)).getpixel((0, 0)), (32, 77, 119))
        self.assertEqual(self.store.save_scene(self.scene, self.png), token)

    def test_camera_only_revision_keeps_distinct_scene(self):
        first = self.store.save_scene(self.scene, self.png)
        self.scene["camera"]["azimuth"] = 90
        second = self.store.save_scene(self.scene, self.png)
        self.assertNotEqual(first, second)
        self.assertEqual(self.store.load_scene(first)[0]["scene"]["camera"]["azimuth"], 45)

    def test_batch_archive_contains_distinct_guides_and_camera_manifest(self):
        first = self.store.save_scene(self.scene, self.png)
        self.scene["camera"]["azimuth"] = 90
        buffer = io.BytesIO(); Image.new("RGB", (96, 64), (119, 77, 32)).save(buffer, format="PNG")
        second = self.store.save_scene(self.scene, "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode())
        batch = self.store.save_batch([{"snapshot": first, "prompt_id": "first-job"}, {"snapshot": second, "prompt_id": "second-job"}])
        self.assertEqual(batch["count"], 2)
        with self.store.batch_archive(batch["id"]) as archive:
            data = archive.read()
        with zipfile.ZipFile(io.BytesIO(data)) as package:
            self.assertEqual(package.namelist(), ["manifest.json", "view-0001.png", "view-0002.png"])
            manifest = json.loads(package.read("manifest.json"))
            self.assertEqual([view["camera"]["azimuth"] for view in manifest["views"]], [45, 90])
            self.assertEqual([view["prompt_id"] for view in manifest["views"]], ["first-job", "second-job"])
            self.assertEqual(Image.open(io.BytesIO(package.read("view-0001.png"))).getpixel((0, 0)), (32, 77, 119))
            self.assertEqual(Image.open(io.BytesIO(package.read("view-0002.png"))).getpixel((0, 0)), (119, 77, 32))

    def test_batch_rejects_missing_snapshots_and_other_json_documents(self):
        for views in [[], None, [None], [{"snapshot": {"version": 1, "id": "../private"}}]]:
            with self.subTest(views=views), self.assertRaises(ValueError):
                self.store.save_batch(views)
        token = self.store.save_scene(self.scene, self.png)
        with self.assertRaisesRegex(ValueError, "not an AnyAngle batch"):
            self.store.batch_archive(token["id"])

    def test_base_model_changes_prompt_and_removed_guides_are_rejected(self):
        scene = copy.deepcopy(self.scene)
        scene["conditioning"] = {"model": "base", "guide": "coarse"}
        self.assertEqual(self.store.load_scene(self.store.save_scene(scene, self.png))[0]["prompt"], BASE_PROMPT)
        for guide in ("pose", "depth", "canny"):
            scene["conditioning"]["guide"] = guide
            with self.subTest(guide=guide), self.assertRaisesRegex(ValueError, "Unknown model or guide"):
                self.store.save_scene(scene, self.png)
        scene = copy.deepcopy(self.scene)
        scene["source"] = {"kind": "empty"}
        with self.assertRaisesRegex(ValueError, "reconstructed scene or GLB"):
            self.store.save_scene(scene, self.png)

    def test_unknown_guide_or_model_is_rejected(self):
        scene = copy.deepcopy(self.scene)
        scene["conditioning"] = {"model": "other", "guide": "coarse"}
        with self.assertRaisesRegex(ValueError, "Unknown model"):
            self.store.save_scene(scene, self.png)

    def test_missing_and_corrupted_guide_fail(self):
        token = self.store.save_scene(self.scene, self.png)
        document, _ = self.store.load_scene(token)
        path = self.store.path(document["guide"]["name"])
        path.write_bytes(b"corrupt")
        with self.assertRaisesRegex(ValueError, "integrity"):
            self.store.load_scene(token)
        path.unlink()
        with self.assertRaisesRegex(ValueError, "missing"):
            self.store.load_scene(token)

    def test_3d_assets_go_to_the_scratch_folder_and_older_ones_are_still_found(self):
        root, scratch = Path(self.directory.name) / "kept", Path(self.directory.name) / "scratch"
        store = StudioStore(root, scratch)
        glb = self.store.read_asset(self.scene["source"]["name"])
        asset = store.asset(glb, "glb")
        self.assertEqual([path.name for path in scratch.iterdir()], [asset["name"]])
        self.assertEqual(list(root.iterdir()), [])
        scene = {**self.scene, "source": {**asset, "kind": "glb"}}
        token = store.save_scene(scene, self.png)
        self.assertEqual(sorted(path.suffix for path in root.iterdir()), [".json", ".png"])
        # An applied shot still runs after the scratch folder was cleared; only the 3D asset is gone.
        (scratch / asset["name"]).unlink()
        document, guide = StudioStore(root, scratch).load_scene(token)
        self.assertEqual(document["scene"]["source"]["name"], asset["name"])
        self.assertTrue(guide.startswith(b"\x89PNG"))
        with self.assertRaisesRegex(ValueError, "missing"):
            store.read_asset(asset["name"])
        (root / asset["name"]).write_bytes(glb)
        self.assertEqual(StudioStore(root, scratch).read_asset(asset["name"]), glb)

    def test_path_escape_rejected(self):
        for name in ("../private.png", "C:/secret.png", "a" * 64 + ".png/../x", "\\server\\share"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.store.path(name)

    def test_wrong_capture_size_and_nonfinite_camera_rejected(self):
        scene = copy.deepcopy(self.scene)
        scene["width"] = 128
        with self.assertRaisesRegex(ValueError, "dimensions"):
            self.store.save_scene(scene, self.png)
        scene = copy.deepcopy(self.scene)
        scene["camera"]["azimuth"] = float("nan")
        with self.assertRaisesRegex(ValueError, "camera"):
            self.store.save_scene(scene, self.png)

    def test_glb_external_resources_rejected(self):
        raw = json.dumps({"asset": {"version": "2.0"}, "images": [{"uri": "https://example.org/private.png"}]}).encode()
        raw += b" " * (-len(raw) % 4)
        glb = struct.pack("<4sII", b"glTF", 2, 20 + len(raw)) + struct.pack("<I4s", len(raw), b"JSON") + raw
        with self.assertRaisesRegex(ValueError, "embed"):
            self.store.asset(glb, "glb")

    def test_malformed_glb_resources_are_user_errors(self):
        for invalid in ({"asset": {"version": "2.0"}, "images": None},
                        {"asset": {"version": "2.0"}, "extensionsRequired": None}):
            raw = json.dumps(invalid).encode()
            raw += b" " * (-len(raw) % 4)
            glb = struct.pack("<4sII", b"glTF", 2, 20 + len(raw)) + struct.pack("<I4s", len(raw), b"JSON") + raw
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.store.asset(glb, "glb")

    def test_malformed_scene_assets_and_base64_are_user_errors(self):
        source = self.store.asset(base64.b64decode(self.png.split(",")[1]), "png")
        scene = copy.deepcopy(self.scene)
        scene["source"] = {**source, "kind": "glb"}
        with self.assertRaisesRegex(ValueError, "format"):
            self.store.save_scene(scene, self.png)
        scene["source"] = copy.deepcopy(self.scene["source"])
        scene["reference"] = {"name": source["name"]}
        with self.assertRaisesRegex(ValueError, "valid PNG"):
            self.store.save_scene(scene, "data:image/png;base64,???")

    def test_oversized_png_is_rejected_before_decode(self):
        def chunk(kind, payload):
            return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload))

        for width, height in ((8000, 5000), (20000, 10000)):
            header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
            png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IEND", b"")
            with self.subTest(size=(width, height)), self.assertRaisesRegex(ValueError, "32 megapixels"):
                self.store.asset(png, "png")

    def test_gaussian_asset_roundtrip_and_reference_binding(self):
        fields = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
                  'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']
        header = 'ply\nformat binary_little_endian 1.0\nelement vertex 1\n'
        header += ''.join(f'property float {field}\n' for field in fields) + 'end_header\n'
        ply = header.encode() + struct.pack('<14f', *([0] * 14))
        asset = self.store.asset(ply, 'ply')
        self.assertEqual(self.store.read_asset(asset['name']), ply)
        with self.assertRaisesRegex(ValueError, 'record lengths'):
            self.store.asset(ply[:-4], 'ply')
        reference = self.store.asset(base64.b64decode(self.png.split(',')[1]), 'png')
        self.scene['reference'] = reference
        self.scene['source'] = {**asset, 'kind': 'splat', 'reference': reference,
                                'camera_token': [1, 0, 0, 0, .75]}
        token = self.store.save_scene(self.scene, self.png)
        self.assertEqual(self.store.load_scene(token)[0]['scene']['source']['camera_token'], [1, 0, 0, 0, .75])
        self.scene['reference'] = {'name': 'a' * 64 + '.png'}
        with self.assertRaisesRegex(ValueError, 'does not match'):
            self.store.save_scene(self.scene, self.png)


if __name__ == "__main__":
    unittest.main()
