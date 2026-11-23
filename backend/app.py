import asyncio
import json
import logging
import os
from typing import Optional
from fastapi import FastAPI, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
import requests

from backend.directory import directory
from backend.kiwi_client import KiwiClient

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("radio_app")

app = FastAPI(title="SDR & Internet Radio Hub", version="1.0.0")

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")


@app.get("/api/receivers")
async def get_receivers(refresh: bool = False):
    """List available online KiwiSDR receivers."""
    receivers = directory.get_kiwisdr_receivers(force_refresh=refresh)
    return {"status": "ok", "count": len(receivers), "receivers": receivers}


@app.get("/api/radio/top")
async def get_top_radio_stations(limit: int = 30):
    """Get top rated internet radio stations."""
    stations = directory.get_top_stations(limit=limit)
    return {"status": "ok", "count": len(stations), "stations": stations}


@app.get("/api/radio/search")
async def search_radio_stations(
    q: Optional[str] = Query(None, description="Station name search"),
    genre: Optional[str] = Query(None, description="Music/Content genre"),
    country: Optional[str] = Query(None, description="Country"),
    limit: int = 30,
):
    """Search internet radio stations by keyword, genre, or country."""
    stations = directory.search_stations(name=q, genre=genre, country=country, limit=limit)
    return {"status": "ok", "count": len(stations), "stations": stations}


@app.get("/api/radio/genres")
async def get_genres():
    """Return common popular genres for quick filtering."""
    genres = [
        "News", "Jazz", "Classical", "Rock", "Electronic",
        "Chillout", "Ambient", "Pop", "Retro", "Talk",
        "Blues", "Country", "Folk", "Reggae", "Dance"
    ]
    return {"status": "ok", "genres": genres}


def resolve_stream_url(url: str) -> str:
    """Resolve stream URL, handling HTTP redirects and M3U/PLS playlist files."""
    headers = {"User-Agent": "VLC/3.0.18 LibVLC/3.0.18"}
    try:
        req = requests.get(url, headers=headers, stream=True, timeout=6, allow_redirects=True)
        content_type = req.headers.get("Content-Type", "").lower()
        if "mpegurl" in content_type or "pls" in content_type or url.endswith(".m3u") or url.endswith(".pls"):
            chunk = next(req.iter_content(chunk_size=4096)).decode("utf-8", errors="ignore")
            req.close()
            for line in chunk.splitlines():
                line = line.strip()
                if line.startswith("http://") or line.startswith("https://"):
                    return line
                if line.startswith("File1="):
                    return line.split("=", 1)[1]
        req.close()
        return req.url
    except Exception as e:
        logger.debug(f"Error resolving playlist for {url}: {e}")
        return url


@app.api_route("/api/proxy/stream", methods=["GET", "HEAD"])
def proxy_audio_stream(url: str, request: Request):
    """
    Robust audio stream proxy that handles:
    - User-Agent whitelisting (bypassing 401 on Zeno.fm and Icecast servers)
    - CORS header injection
    - HEAD requests from HTML5 <audio>
    - M3U and PLS playlist parsing
    """
    if request.method == "HEAD":
        return Response(
            status_code=200,
            headers={
                "Content-Type": "audio/mpeg",
                "Accept-Ranges": "none",
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "no-cache, no-store",
            },
        )

    try:
        resolved_url = resolve_stream_url(url)
        headers = {
            "User-Agent": "VLC/3.0.18 LibVLC/3.0.18",
            "Accept": "*/*",
            "Icy-MetaData": "1",
        }
        req = requests.get(
            resolved_url,
            stream=True,
            timeout=8,
            headers=headers,
            allow_redirects=True,
        )

        if req.status_code >= 400:
            logger.warning(f"Remote stream {resolved_url} returned HTTP {req.status_code}")
            return Response(
                status_code=req.status_code,
                content=f"Remote stream error: HTTP {req.status_code}",
                media_type="text/plain",
            )

        content_type = req.headers.get("Content-Type", "audio/mpeg")
        if "text/html" in content_type:
            content_type = "audio/mpeg"

        def iter_stream():
            try:
                for chunk in req.iter_content(chunk_size=8192):
                    if chunk:
                        yield chunk
            except Exception as stream_err:
                logger.debug(f"Stream playback stopped: {stream_err}")
            finally:
                req.close()

        response_headers = {
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
            "Accept-Ranges": "none",
            "Access-Control-Allow-Origin": "*",
        }
        # Forward ICY station name if present
        if "icy-name" in req.headers:
            response_headers["icy-name"] = req.headers["icy-name"]

        return StreamingResponse(
            iter_stream(),
            status_code=200,
            media_type=content_type,
            headers=response_headers,
        )
    except Exception as e:
        logger.error(f"Error proxying stream {url}: {e}")
        return Response(status_code=502, content=f"Stream proxy error: {str(e)}", media_type="text/plain")



@app.websocket("/ws/sdr")
async def sdr_websocket_endpoint(websocket: WebSocket):
    """
    WebSocket endpoint bridging browser Web Audio API to KiwiSDR receivers.
    Accepts JSON commands (connect, tune, mode, switch) and streams
    telemetry (JSON) and 16-bit PCM audio chunks (binary).
    """
    await websocket.accept()
    client: Optional[KiwiClient] = None
    stream_task: Optional[asyncio.Task] = None
    current_freq = 1000.0
    current_mode = "am"
    current_host = "kiwisdr.areg.org.au"
    current_port = 8073

    # Send initial welcome & default status
    await websocket.send_text(json.dumps({
        "type": "status",
        "message": "Connected to SDR Gateway. Ready to tune.",
    }))

    async def run_streamer(kiwi: KiwiClient):
        last_telemetry_time = 0.0
        try:
            async for rssi, pcm_bytes in kiwi.stream():
                now = asyncio.get_event_loop().time()
                # Send telemetry (RSSI, sample rate) every ~100ms
                if now - last_telemetry_time > 0.1:
                    await websocket.send_text(json.dumps({
                        "type": "telemetry",
                        "rssi": round(rssi, 1),
                        "sample_rate": kiwi.sample_rate,
                        "freq": kiwi.freq_khz,
                        "mode": kiwi.mode,
                    }))
                    last_telemetry_time = now

                # Send binary 16-bit PCM audio samples
                await websocket.send_bytes(pcm_bytes)
        except asyncio.CancelledError:
            pass
        except Exception as err:
            logger.error(f"Streaming error: {err}")
            try:
                await websocket.send_text(json.dumps({
                    "type": "error",
                    "message": f"SDR stream disconnected: {str(err)}",
                }))
            except Exception:
                pass

    try:
        while True:
            data = await websocket.receive_text()
            cmd = json.loads(data)
            action = cmd.get("action")

            if action == "connect":
                current_host = cmd.get("host", current_host)
                current_port = int(cmd.get("port", current_port))
                current_freq = float(cmd.get("freq", current_freq))
                current_mode = cmd.get("mode", current_mode)

                if stream_task and not stream_task.done():
                    stream_task.cancel()
                if client:
                    await client.close()

                client = KiwiClient(
                    host=current_host,
                    port=current_port,
                    freq_khz=current_freq,
                    mode=current_mode,
                )

                try:
                    await client.connect()
                    stream_task = asyncio.create_task(run_streamer(client))
                    await websocket.send_text(json.dumps({
                        "type": "status",
                        "connected": True,
                        "host": current_host,
                        "port": current_port,
                        "freq": current_freq,
                        "mode": current_mode,
                        "message": f"Tuned to {current_freq:.1f} kHz on {current_host}",
                    }))
                except Exception as e:
                    logger.error(f"Failed to connect to KiwiSDR {current_host}:{current_port}: {e}")
                    await websocket.send_text(json.dumps({
                        "type": "error",
                        "message": f"Could not connect to receiver: {str(e)}",
                    }))

            elif action == "tune":
                new_freq = cmd.get("freq")
                new_mode = cmd.get("mode")
                low_cut = cmd.get("low_cut")
                high_cut = cmd.get("high_cut")

                if new_freq is not None:
                    current_freq = float(new_freq)
                if new_mode is not None:
                    current_mode = new_mode

                if client and client._running:
                    await client.tune(
                        freq_khz=current_freq,
                        mode=new_mode,
                        low_cut=low_cut,
                        high_cut=high_cut,
                    )
                    await websocket.send_text(json.dumps({
                        "type": "tuned",
                        "freq": current_freq,
                        "mode": current_mode,
                    }))
                else:
                    # Not connected yet, connect now
                    client = KiwiClient(
                        host=current_host,
                        port=current_port,
                        freq_khz=current_freq,
                        mode=current_mode,
                    )
                    await client.connect()
                    stream_task = asyncio.create_task(run_streamer(client))

            elif action == "stop":
                if stream_task and not stream_task.done():
                    stream_task.cancel()
                if client:
                    await client.close()
                    client = None
                await websocket.send_text(json.dumps({
                    "type": "status",
                    "connected": False,
                    "message": "Radio stopped.",
                }))

    except WebSocketDisconnect:
        logger.info("WebSocket client disconnected.")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
    finally:
        if stream_task and not stream_task.done():
            stream_task.cancel()
        if client:
            await client.close()


# Serve frontend static assets
if os.path.exists(FRONTEND_DIR):
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


@app.get("/")
async def root():
    index_file = os.path.join(FRONTEND_DIR, "index.html")
    if os.path.exists(index_file):
        return FileResponse(index_file)
    return {"message": "Radio App Backend Running. Frontend assets missing."}
