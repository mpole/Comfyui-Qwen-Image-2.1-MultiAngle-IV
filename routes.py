import asyncio

from aiohttp import web
from PIL import UnidentifiedImageError
from server import PromptServer
from .reconstruction import reconstruction_config


def register_routes(store_factory):
    routes = PromptServer.instance.routes

    @routes.get("/anyangle-studio-iv/reconstruction-config")
    async def reconstruction_models(request):
        try:
            config = await asyncio.to_thread(reconstruction_config, dict(request.query))
            return web.json_response(config)
        except (ValueError, OSError) as error:
            return web.json_response({"error": str(error)}, status=400)

    @routes.post("/anyangle-studio-iv/assets")
    async def upload(request):
        try:
            reader = await request.multipart()
            part = await reader.next()
            if part is None or part.name != "file":
                raise ValueError("Choose a file to import")
            data = bytearray()
            while chunk := await part.read_chunk(1024 * 1024):
                data.extend(chunk)
                if len(data) > 256 * 1024 * 1024:
                    raise ValueError("Asset upload exceeds 256 MB")
            kind = "glb" if (part.filename or "").lower().endswith(".glb") else "png"
            asset = await asyncio.to_thread(store_factory().asset, bytes(data), kind)
            asset["label"] = (part.filename or "Imported asset")[:160]
            return web.json_response(asset)
        except (ValueError, OSError, UnidentifiedImageError) as error:
            return web.json_response({"error": str(error)}, status=400)

    @routes.get("/anyangle-studio-iv/assets/{name}")
    async def asset(request):
        try:
            name = request.match_info["name"]
            if not name.endswith((".png", ".glb", ".ply")):
                raise ValueError("Invalid asset")
            data = await asyncio.to_thread(store_factory().read_asset, name)
            content_type = "image/png" if name.endswith(".png") else "model/gltf-binary" if name.endswith(".glb") else "application/octet-stream"
            return web.Response(body=data, content_type=content_type,
                                headers={"Cache-Control": "private, max-age=31536000, immutable"})
        except (ValueError, OSError) as error:
            return web.json_response({"error": str(error)}, status=404)

    @routes.post("/anyangle-studio-iv/snapshots")
    async def snapshot(request):
        try:
            payload = await request.json()
            if not isinstance(payload, dict):
                raise ValueError("Invalid scene payload")
            result = await asyncio.to_thread(store_factory().save_scene, payload.get("scene"), payload.get("png"))
            return web.json_response(result)
        except (ValueError, OSError, UnidentifiedImageError) as error:
            return web.json_response({"error": str(error)}, status=400)

    @routes.post("/anyangle-studio-iv/batches")
    async def save_batch(request):
        try:
            payload = await request.json()
            if not isinstance(payload, dict):
                raise ValueError("Invalid batch payload")
            result = await asyncio.to_thread(store_factory().save_batch, payload.get("views"))
            return web.json_response(result)
        except (ValueError, OSError) as error:
            return web.json_response({"error": str(error)}, status=400)

    @routes.get("/anyangle-studio-iv/batch-guides/{id}")
    async def download_batch(request):
        try:
            archive = await asyncio.to_thread(store_factory().batch_archive, request.match_info["id"])
        except (ValueError, OSError) as error:
            return web.json_response({"error": str(error)}, status=404)
        try:
            response = web.StreamResponse(headers={"Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="anyangle-guides.zip"'})
            await response.prepare(request)
            while chunk := await asyncio.to_thread(archive.read, 1024 * 1024):
                await response.write(chunk)
            await response.write_eof()
            return response
        finally:
            archive.close()

    @routes.get("/anyangle-studio-iv/snapshots/{id}")
    async def read_snapshot(request):
        try:
            document, _ = await asyncio.to_thread(store_factory().load_scene, {"version": 1, "id": request.match_info["id"]})
            return web.json_response(document)
        except (ValueError, OSError) as error:
            return web.json_response({"error": str(error)}, status=404)
