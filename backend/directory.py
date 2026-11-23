import json
import logging
import re
import time
import urllib.parse
from typing import Any, Dict, List, Optional
import requests

logger = logging.getLogger("directory")

# Fallback curated receivers in case network fetch is unavailable
FALLBACK_RECEIVERS = [
    {
        "id": "vk5arg",
        "name": "VK5ARG Remote Receiver Site",
        "loc": "Near Tarlee, South Australia",
        "region": "Oceania / Asia",
        "host": "kiwisdr.areg.org.au",
        "port": 8073,
        "users": "1",
        "users_max": "8",
        "antenna": 'Broadband Monopole ("J-Dart")',
        "snr": "39,40",
    },
    {
        "id": "zl1rot",
        "name": "ZL1ROT Rotorua",
        "loc": "Rotorua, New Zealand",
        "region": "Oceania / Asia",
        "host": "sdr.rogerh.co.nz",
        "port": 8073,
        "users": "2",
        "users_max": "6",
        "antenna": "Full Size G5RV",
        "snr": "43,40",
    },
    {
        "id": "ironstone1",
        "name": "Ironstone Range SDR",
        "loc": "South Australia",
        "region": "Oceania / Asia",
        "host": "sdr.ironstonerange.com",
        "port": 8073,
        "users": "2",
        "users_max": "8",
        "antenna": "Bicone Antenna",
        "snr": "40,40",
    },
    {
        "id": "kfs",
        "name": "KFS Half Moon Bay",
        "loc": "California, United States",
        "region": "North America",
        "host": "kfs.ddns.net",
        "port": 8073,
        "users": "3",
        "users_max": "8",
        "antenna": "TCI-530 Log Periodic",
        "snr": "45,42",
    },
    {
        "id": "sk3w",
        "name": "SK3W Contest Station",
        "loc": "Sweden",
        "region": "Europe",
        "host": "sk3w.se",
        "port": 8073,
        "users": "1",
        "users_max": "8",
        "antenna": "Dipole Array",
        "snr": "38,36",
    },
]

# Radio Browser API base mirrors
RADIO_BROWSER_MIRRORS = [
    "https://de1.api.radio-browser.info",
    "https://nl1.api.radio-browser.info",
    "https://at1.api.radio-browser.info",
]


class DirectoryService:
    def __init__(self):
        self._receivers_cache: List[Dict[str, Any]] = []
        self._receivers_cache_time = 0.0
        self._cache_ttl = 600  # 10 minutes

    def _infer_region(self, loc: str, host: str) -> str:
        text = f"{loc} {host}".lower()
        if any(c in text for c in ["australia", "zealand", "japan", "asia", "korea", "china", "india", ".au", ".nz", ".jp"]):
            return "Oceania & Asia"
        elif any(c in text for c in ["usa", "united states", "canada", "america", "california", "texas", "new york", "florida", ".us", ".ca"]):
            return "North America"
        elif any(c in text for c in ["brazil", "argentina", "chile", "colombia", "mexico"]):
            return "Central & South America"
        elif any(c in text for c in ["africa", "south africa", "kenya", "morocco"]):
            return "Africa"
        else:
            return "Europe"

    def get_kiwisdr_receivers(self, force_refresh: bool = False) -> List[Dict[str, Any]]:
        """Fetch and cache online KiwiSDR receivers."""
        now = time.time()
        if self._receivers_cache and not force_refresh and (now - self._receivers_cache_time < self._cache_ttl):
            return self._receivers_cache

        try:
            url = "http://rx.linkfanel.net/kiwisdr_com.js"
            resp = requests.get(url, timeout=6, headers={"User-Agent": "Mozilla/5.0"})
            if resp.status_code == 200:
                content = resp.text
                start = content.find("[")
                end = content.rfind("]") + 1
                if start != -1 and end != -1:
                    raw_json = content[start:end]
                    cleaned = re.sub(r",\s*([\]}])", r"\1", raw_json)
                    data = json.loads(cleaned)

                    receivers = []
                    for item in data:
                        if item.get("offline") == "no" and item.get("url"):
                            try:
                                users = int(item.get("users", 0))
                                users_max = int(item.get("users_max", 1))
                                if users >= users_max:
                                    continue  # Skip full receivers

                                parsed_url = urllib.parse.urlparse(item.get("url", ""))
                                host = parsed_url.hostname
                                port = parsed_url.port or 8073
                                if not host:
                                    continue

                                loc = item.get("loc", "Unknown Location")
                                region = self._infer_region(loc, host)

                                receivers.append({
                                    "id": item.get("id", f"{host}:{port}"),
                                    "name": item.get("name", loc),
                                    "loc": loc,
                                    "region": region,
                                    "host": host,
                                    "port": port,
                                    "url": item.get("url"),
                                    "users": str(users),
                                    "users_max": str(users_max),
                                    "antenna": item.get("antenna", "Wire/Monopole"),
                                    "snr": item.get("snr", "--"),
                                    "sw_version": item.get("sw_version", ""),
                                })
                            except Exception:
                                continue

                    if receivers:
                        # Sort by available slots and SNR
                        receivers.sort(key=lambda r: int(r["users_max"]) - int(r["users"]), reverse=True)
                        self._receivers_cache = receivers
                        self._receivers_cache_time = now
                        logger.info(f"Loaded {len(receivers)} active KiwiSDR receivers.")
                        return self._receivers_cache
        except Exception as e:
            logger.warning(f"Failed to fetch live KiwiSDR list: {e}. Using fallback receivers.")

        if not self._receivers_cache:
            self._receivers_cache = FALLBACK_RECEIVERS
            self._receivers_cache_time = now
        return self._receivers_cache

    def _query_radio_browser(self, endpoint: str, params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """Query Radio Browser API with fallback mirror selection."""
        headers = {"User-Agent": "WebRadioConsole/1.0"}
        for base in RADIO_BROWSER_MIRRORS:
            try:
                url = f"{base}/json/{endpoint}"
                resp = requests.get(url, params=params, headers=headers, timeout=6)
                if resp.status_code == 200:
                    return resp.json()
            except Exception as e:
                logger.debug(f"Radio browser mirror {base} failed: {e}")
                continue
        return []

    def get_top_stations(self, limit: int = 30) -> List[Dict[str, Any]]:
        """Return globally popular internet radio stations."""
        raw = self._query_radio_browser(f"stations/topclick/{limit}")
        return self._format_stations(raw)

    def search_stations(
        self,
        name: Optional[str] = None,
        genre: Optional[str] = None,
        country: Optional[str] = None,
        limit: int = 30,
    ) -> List[Dict[str, Any]]:
        """Search internet radio stations by query parameters."""
        params: Dict[str, Any] = {
            "limit": limit,
            "order": "clickcount",
            "reverse": "true",
            "hidebroken": "true",
        }
        if name:
            params["name"] = name
        if genre:
            params["tag"] = genre
        if country:
            params["country"] = country

        raw = self._query_radio_browser("stations/search", params=params)
        return self._format_stations(raw)

    def _format_stations(self, stations: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Clean and normalize station entries."""
        results = []
        for s in stations:
            stream_url = s.get("url_resolved") or s.get("url")
            if not stream_url:
                continue
            results.append({
                "stationuuid": s.get("stationuuid"),
                "name": s.get("name", "Unknown Station").strip(),
                "url": stream_url,
                "homepage": s.get("homepage", ""),
                "favicon": s.get("favicon", ""),
                "tags": [t.strip() for t in s.get("tags", "").split(",") if t.strip()][:5],
                "country": s.get("country", ""),
                "countrycode": s.get("countrycode", ""),
                "codec": s.get("codec", "MP3"),
                "bitrate": s.get("bitrate", 0),
                "votes": s.get("votes", 0),
            })
        return results


# Global singleton directory
directory = DirectoryService()
