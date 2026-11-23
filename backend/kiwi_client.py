import asyncio
import logging
import re
import struct
import time
from typing import AsyncGenerator, Optional, Tuple
import websockets

logger = logging.getLogger("kiwi_client")

# Default audio filter passbands for different modes (in Hz)
DEFAULT_PASSBANDS = {
    "am": (-5000, 5000),
    "amn": (-2500, 2500),
    "amw": (-6000, 6000),
    "usb": (300, 2700),
    "lsb": (-2700, -300),
    "cw": (400, 800),
    "nbfm": (-6000, 6000),
}


class KiwiClient:
    """
    Asynchronous client for streaming demodulated audio and S-meter data
    from a remote KiwiSDR receiver over WebSockets.
    """

    def __init__(
        self,
        host: str,
        port: int = 8073,
        freq_khz: float = 1000.0,
        mode: str = "am",
        user: str = "WebRadioConsole",
    ):
        self.host = host
        self.port = port
        self.freq_khz = float(freq_khz)
        self.mode = mode.lower()
        self.user = user

        passband = DEFAULT_PASSBANDS.get(self.mode, (-5000, 5000))
        self.low_cut = passband[0]
        self.high_cut = passband[1]

        self.ws: Optional[websockets.WebSocketClientProtocol] = None
        self._running = False
        self._last_keepalive = 0.0
        self.sample_rate = 12000
        self.latest_rssi = -100.0

    async def connect(self):
        """Establish WebSocket connection with the KiwiSDR server."""
        ts = int(time.time())
        uri = f"ws://{self.host}:{self.port}/{ts}/SND"
        logger.info(f"Connecting to KiwiSDR at {uri}...")

        self.ws = await websockets.connect(
            uri,
            ping_interval=None,
            ping_timeout=None,
            close_timeout=5,
            open_timeout=10,
        )
        self._running = True

        # Initial protocol setup
        await self.ws.send("SET auth t=kiwi p=")
        await self.ws.send(f"SET ident_user={self.user}")
        await self.ws.send("SET compression=0")
        await self.ws.send("SET agc=1 hang=0 thresh=-100 slope=0 decay=1000 manGain=50")
        await self._send_tune_command()

    async def _send_tune_command(self):
        """Send frequency and modulation settings to KiwiSDR."""
        if not self.ws:
            return
        cmd = f"SET mod={self.mode} low_cut={int(self.low_cut)} high_cut={int(self.high_cut)} freq={self.freq_khz:.3f}"
        logger.info(f"Sending to KiwiSDR: {cmd}")
        await self.ws.send(cmd)

    async def tune(
        self,
        freq_khz: float,
        mode: Optional[str] = None,
        low_cut: Optional[int] = None,
        high_cut: Optional[int] = None,
    ):
        """Dynamically tune to a new frequency, modulation, or bandwidth."""
        self.freq_khz = float(freq_khz)
        if mode:
            self.mode = mode.lower()
            if low_cut is None or high_cut is None:
                pb = DEFAULT_PASSBANDS.get(self.mode, (-5000, 5000))
                self.low_cut = pb[0]
                self.high_cut = pb[1]

        if low_cut is not None:
            self.low_cut = low_cut
        if high_cut is not None:
            self.high_cut = high_cut

        await self._send_tune_command()

    async def stream(self) -> AsyncGenerator[Tuple[float, bytes], None]:
        """
        Yields (rssi_dbm, pcm_16bit_bytes) audio chunks as received from KiwiSDR.
        """
        if not self.ws:
            await self.connect()

        while self._running and self.ws:
            try:
                now = time.time()
                if now - self._last_keepalive > 1.5:
                    await self.ws.send("SET keepalive")
                    self._last_keepalive = now

                msg = await asyncio.wait_for(self.ws.recv(), timeout=5.0)

                if isinstance(msg, bytes):
                    tag = msg[:3].decode("ascii", errors="ignore")
                    body = msg[3:]

                    if tag == "SND":
                        if len(body) >= 7:
                            smeter = struct.unpack(">H", body[5:7])[0]
                            rssi = 0.1 * smeter - 127.0
                            self.latest_rssi = rssi
                            pcm_data = body[7:]
                            if pcm_data:
                                yield (rssi, pcm_data)

                    elif tag == "MSG":
                        text = body.decode("latin1", errors="ignore").strip()
                        m = re.search(r"audio_rate=(\d+)", text)
                        if m:
                            self.sample_rate = int(m.group(1))
                            logger.info(f"KiwiSDR audio_rate={self.sample_rate}")
                            await self.ws.send(f"SET AR OK in={self.sample_rate} out={self.sample_rate}")

                elif isinstance(msg, str):
                    logger.debug(f"Received text msg: {msg[:80]}")

            except asyncio.TimeoutError:
                if self.ws:
                    await self.ws.send("SET keepalive")
            except websockets.ConnectionClosed:
                logger.warning("KiwiSDR connection closed.")
                break
            except Exception as e:
                logger.error(f"Error in Kiwi stream: {e}")
                break

    async def close(self):
        """Close the connection gracefully."""
        self._running = False
        if self.ws:
            try:
                await self.ws.close()
            except Exception:
                pass
            self.ws = None
