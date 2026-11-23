/**
 * WAVEHUB - SDR & Internet Radio Controller
 * Web Audio API streaming, real-time visualizer, KiwiSDR WebSocket bridge & Radio-Browser client.
 */

// Global Application State
const state = {
  power: true,
  mode: 'websdr', // 'websdr' | 'netradio'
  volume: 0.8,
  isMuted: false,
  isRecording: false,

  // SDR State
  sdr: {
    freq: 1000.0,
    mod: 'am',
    low_cut: -5000,
    high_cut: 5000,
    bandName: 'Medium Wave (AM)',
    sampleRate: 12000,
    rssi: -78.0,
    receiver: {
      host: 'kiwisdr.areg.org.au',
      port: 8073,
      name: 'VK5ARG Remote Receiver',
      loc: 'Near Tarlee, South Australia',
    },
    ws: null,
    connected: false,
    reconnectTimer: null,
  },

  // Internet Radio State
  net: {
    activeStation: null,
    isPlaying: false,
    genre: '',
    searchQuery: '',
    stations: [],
  },

  // Audio Processing State
  audio: {
    ctx: null,
    gainNode: null,
    analyser: null,
    nextStartTime: 0,
    vizMode: 'fft', // 'fft' | 'wave'
    mediaRecorder: null,
    recordChunks: [],
    destNode: null,
  },

  // Bookmarks
  bookmarks: {
    sdr: JSON.parse(localStorage.getItem('wavehub_sdr_bookmarks') || '[]'),
    net: JSON.parse(localStorage.getItem('wavehub_net_bookmarks') || '[]'),
  },
};

// ==========================================================================
// 1. INITIALIZATION & SETUP
// ==========================================================================
document.addEventListener('DOMContentLoaded', () => {
  initElements();
  initEventListeners();
  initAudioContext();
  updateFrequencyDisplay(state.sdr.freq);
  renderBookmarks();
  fetchInitialStations();
  fetchReceiversList();

  // Connect SDR stream on startup
  connectSdr();
  startVisualizerLoop();
});

// Cache DOM elements
let dom = {};
function initElements() {
  dom = {
    powerBtn: document.getElementById('power-btn'),
    recordBtn: document.getElementById('record-btn'),
    recLabel: document.getElementById('rec-label'),
    bookmarksBtn: document.getElementById('bookmarks-btn'),
    muteBtn: document.getElementById('mute-btn'),
    volIcon: document.getElementById('vol-icon'),
    masterVolume: document.getElementById('master-volume'),

    tabWebsdr: document.getElementById('tab-websdr'),
    tabNetradio: document.getElementById('tab-netradio'),
    websdrView: document.getElementById('websdr-view'),
    netradioView: document.getElementById('netradio-view'),

    // SDR Elements
    openRxPicker: document.getElementById('open-receiver-picker'),
    currentRxName: document.getElementById('current-rx-name'),
    currentRxLoc: document.getElementById('current-rx-loc'),
    telemetryDemod: document.getElementById('telemetry-demod'),
    telemetryRate: document.getElementById('telemetry-rate'),
    telemetryRssi: document.getElementById('telemetry-rssi'),
    currentBandLabel: document.getElementById('current-band-label'),
    displayFrequency: document.getElementById('display-frequency'),
    freqSlider: document.getElementById('freq-slider'),
    directTuneForm: document.getElementById('direct-tune-form'),
    directFreqInput: document.getElementById('direct-freq-input'),
    saveSdrBookmark: document.getElementById('save-sdr-bookmark'),
    modeBtns: document.querySelectorAll('.mode-btn'),
    bandChips: document.querySelectorAll('.band-chip'),
    stepBtns: document.querySelectorAll('.step-btn'),

    // S-Meter & Canvas
    smeterDbm: document.getElementById('smeter-dbm'),
    smeterUnit: document.getElementById('smeter-unit'),
    smeterNeedle: document.getElementById('smeter-needle'),
    vizModeFft: document.getElementById('viz-mode-fft'),
    vizModeWave: document.getElementById('viz-mode-wave'),
    vizCanvas: document.getElementById('audio-visualizer-canvas'),

    // Net Radio Elements
    stationSearchInput: document.getElementById('station-search-input'),
    clearSearchBtn: document.getElementById('clear-search-btn'),
    refreshStationsBtn: document.getElementById('refresh-stations-btn'),
    genrePills: document.querySelectorAll('.genre-pill'),
    stationsGrid: document.getElementById('stations-grid'),
    stationCountLabel: document.getElementById('station-count-label'),
    stationListTitle: document.getElementById('station-list-title'),
    netradioPlayerBar: document.getElementById('netradio-player-bar'),
    npAvatar: document.getElementById('np-avatar'),
    npStationName: document.getElementById('np-station-name'),
    npStationMeta: document.getElementById('np-station-meta'),
    npPlayPauseBtn: document.getElementById('np-play-pause-btn'),
    npPlayIcon: document.getElementById('np-play-icon'),
    npBookmarkBtn: document.getElementById('np-bookmark-btn'),
    htmlAudioPlayer: document.getElementById('html-audio-player'),

    // Modal & Drawers
    receiverModal: document.getElementById('receiver-modal'),
    closeReceiverModal: document.getElementById('close-receiver-modal'),
    rxFilterInput: document.getElementById('rx-filter-input'),
    receiversList: document.getElementById('receivers-list'),
    rxRegionTabs: document.getElementById('rx-region-tabs'),

    bookmarksDrawer: document.getElementById('bookmarks-drawer'),
    closeBookmarksDrawer: document.getElementById('close-bookmarks-drawer'),
    bookmarksList: document.getElementById('bookmarks-list'),
    drawerTabs: document.querySelectorAll('.drawer-tab'),
  };
}

// ==========================================================================
// 2. AUDIO ENGINE & WEB AUDIO API
// ==========================================================================
function initAudioContext() {
  if (state.audio.ctx) return;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  state.audio.ctx = new AudioCtx({ sampleRate: 48000 });

  // Master Gain Node
  state.audio.gainNode = state.audio.ctx.createGain();
  state.audio.gainNode.gain.value = state.volume;

  // Analyser Node for Visualizers
  state.audio.analyser = state.audio.ctx.createAnalyser();
  state.audio.analyser.fftSize = 256;
  state.audio.analyser.smoothingTimeConstant = 0.8;

  // Destination stream for recording
  state.audio.destNode = state.audio.ctx.createMediaStreamDestination();

  // Graph routing: Input -> Analyser -> Gain -> Destination & Recording
  state.audio.analyser.connect(state.audio.gainNode);
  state.audio.gainNode.connect(state.audio.ctx.destination);
  state.audio.gainNode.connect(state.audio.destNode);
}

function ensureAudioContextRunning() {
  if (state.audio.ctx && state.audio.ctx.state === 'suspended') {
    state.audio.ctx.resume().catch((e) => {
      console.warn('AudioContext resume requires user interaction:', e);
    });
  }
}

/**
 * Convert 16-bit Big-Endian PCM binary chunk into Web Audio Buffer and queue for playback
 */
function playPcmChunk(arrayBuffer) {
  if (!state.power || state.mode !== 'websdr') return;
  ensureAudioContextRunning();

  const byteLength = arrayBuffer.byteLength;
  const sampleCount = Math.floor(byteLength / 2);
  if (sampleCount === 0) return;

  const dataView = new DataView(arrayBuffer);
  const float32Data = new Float32Array(sampleCount);

  // Compute DC offset (KiwiSDR AM envelope has positive DC carrier level)
  let sum = 0;
  for (let i = 0; i < sampleCount; i++) {
    sum += dataView.getInt16(i * 2, false); // false = Big-Endian
  }
  const dcOffset = sum / sampleCount;

  for (let i = 0; i < sampleCount; i++) {
    // Remove carrier DC offset and scale to [-1.0, 1.0]
    const val = dataView.getInt16(i * 2, false) - dcOffset;
    float32Data[i] = Math.max(-1.0, Math.min(1.0, val / 32768.0));
  }

  const sampleRate = state.sdr.sampleRate || 12000;
  const audioBuf = state.audio.ctx.createBuffer(1, sampleCount, sampleRate);
  audioBuf.copyToChannel(float32Data, 0);

  const source = state.audio.ctx.createBufferSource();
  source.buffer = audioBuf;
  source.connect(state.audio.analyser);

  const currentTime = state.audio.ctx.currentTime;
  // If schedule has fallen behind or drifted too far ahead, resync smoothly
  if (state.audio.nextStartTime < currentTime || state.audio.nextStartTime > currentTime + 0.25) {
    state.audio.nextStartTime = currentTime + 0.035; // 35ms jitter buffer
  }

  source.start(state.audio.nextStartTime);
  state.audio.nextStartTime += audioBuf.duration;
}

// ==========================================================================
// 3. WEBSDR WEBSOCKET CLIENT
// ==========================================================================
function connectSdr() {
  if (state.sdr.ws) {
    try { state.sdr.ws.close(); } catch (_) {}
    state.sdr.ws = null;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/sdr`;
  console.log('Connecting SDR WebSocket:', wsUrl);

  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';
  state.sdr.ws = ws;

  ws.onopen = () => {
    console.log('SDR Gateway connected.');
    state.sdr.connected = true;
    sendSdrCommand({
      action: 'connect',
      host: state.sdr.receiver.host,
      port: state.sdr.receiver.port,
      freq: state.sdr.freq,
      mode: state.sdr.mod,
      low_cut: state.sdr.low_cut,
      high_cut: state.sdr.high_cut,
    });
  };

  ws.onmessage = (event) => {
    if (typeof event.data === 'string') {
      // JSON Telemetry & status
      try {
        const msg = JSON.parse(event.data);
        handleSdrTelemetry(msg);
      } catch (err) {
        console.error('Error parsing telemetry JSON:', err);
      }
    } else if (event.data instanceof ArrayBuffer) {
      // Binary 16-bit PCM audio samples
      playPcmChunk(event.data);
    }
  };

  ws.onclose = () => {
    state.sdr.connected = false;
    if (state.power && state.mode === 'websdr') {
      clearTimeout(state.sdr.reconnectTimer);
      state.sdr.reconnectTimer = setTimeout(connectSdr, 3000);
    }
  };

  ws.onerror = (err) => {
    console.error('SDR WebSocket error:', err);
  };
}

function sendSdrCommand(cmd) {
  if (state.sdr.ws && state.sdr.ws.readyState === WebSocket.OPEN) {
    state.sdr.ws.send(JSON.stringify(cmd));
  }
}

function handleSdrTelemetry(msg) {
  if (msg.type === 'telemetry') {
    state.sdr.rssi = msg.rssi;
    if (msg.sample_rate) state.sdr.sampleRate = msg.sample_rate;
    updateSMeter(msg.rssi);
    dom.telemetryRssi.textContent = `${msg.rssi.toFixed(1)} dBm`;
    dom.telemetryRate.textContent = `${(state.sdr.sampleRate / 1000).toFixed(1)} kHz`;
  } else if (msg.type === 'status') {
    console.log('SDR status message:', msg.message);
  }
}

// ==========================================================================
// 4. TUNING, BANDS & FREQUENCY CONTROLS
// ==========================================================================
function tuneFrequency(newFreq, newMod = null) {
  newFreq = Math.max(10, Math.min(30000, parseFloat(newFreq)));
  state.sdr.freq = newFreq;
  if (newMod) state.sdr.mod = newMod.toLowerCase();

  updateFrequencyDisplay(newFreq);
  detectBandName(newFreq);

  sendSdrCommand({
    action: 'tune',
    freq: newFreq,
    mode: state.sdr.mod,
  });
}

function updateFrequencyDisplay(freq) {
  const formatted = freq.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  // Pad with leading zeros to 8 chars (e.g. 07,200.00)
  const padded = formatted.length < 9 ? '0'.repeat(9 - formatted.length) + formatted : formatted;
  dom.displayFrequency.textContent = padded;
  dom.freqSlider.value = Math.round(freq);
  dom.directFreqInput.value = freq;
}

function detectBandName(freq) {
  let band = 'SHORTWAVE (HF)';
  if (freq >= 530 && freq <= 1710) {
    band = 'MEDIUM WAVE (AM BROADCAST)';
  } else if (freq >= 1800 && freq <= 2000) {
    band = '160m TOP BAND (AMATEUR)';
  } else if (freq >= 3500 && freq <= 4000) {
    band = '80m / 75m BAND (AMATEUR)';
  } else if (freq >= 5900 && freq <= 6200) {
    band = '49m INTERNATIONAL BROADCAST';
  } else if (freq >= 7200 && freq <= 7450) {
    band = '41m SHORTWAVE BROADCAST';
  } else if (freq >= 9400 && freq <= 9900) {
    band = '31m PRIME BROADCAST BAND';
  } else if (freq >= 11600 && freq <= 12100) {
    band = '25m SHORTWAVE BROADCAST';
  } else if (freq >= 15100 && freq <= 15800) {
    band = '19m DAYTIME BROADCAST';
  } else if (Math.abs(freq - 10000) < 5 || Math.abs(freq - 5000) < 5 || Math.abs(freq - 15000) < 5) {
    band = 'WWV TIME & FREQ STANDARD';
  } else if (Math.abs(freq - 7850) < 5) {
    band = 'CHU CANADA TIME SIGNAL';
  }

  state.sdr.bandName = band;
  dom.currentBandLabel.textContent = band;
}

// Update Analog S-Meter Needle & Units
function updateSMeter(rssi) {
  dom.smeterDbm.textContent = `${rssi.toFixed(1)} dBm`;

  // Standard S-unit calculation (S9 = -73 dBm, 6 dB per S-unit)
  let sVal = 'S0';
  if (rssi >= -73) {
    const overDb = Math.round(rssi - (-73));
    sVal = overDb > 0 ? `S9+${overDb}dB` : 'S9';
  } else {
    const sUnits = Math.max(0, Math.min(9, Math.round((rssi - (-127)) / 6)));
    sVal = `S${sUnits}`;
  }
  dom.smeterUnit.textContent = sVal;

  // Pivot at (100, 85), radius 65
  // Map RSSI [-120 dBm .. -40 dBm] to angle [150 deg .. 30 deg]
  const clampedRssi = Math.max(-125, Math.min(-35, rssi));
  const t = (clampedRssi - (-125)) / ((-35) - (-125)); // 0.0 to 1.0
  const angleDeg = 150 - t * 120; // 150 deg down-left to 30 deg down-right
  const rad = (angleDeg * Math.PI) / 180;
  const needleLength = 58;

  const tipX = 100 - needleLength * Math.cos(rad);
  const tipY = 85 - needleLength * Math.sin(rad);

  dom.smeterNeedle.setAttribute('x2', tipX.toFixed(1));
  dom.smeterNeedle.setAttribute('y2', tipY.toFixed(1));
}

// ==========================================================================
// 5. AUDIO VISUALIZER (CANVAS)
// ==========================================================================
function startVisualizerLoop() {
  const canvas = dom.vizCanvas;
  const ctx = canvas.getContext('2d');

  function resizeCanvas() {
    if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
      canvas.width = canvas.clientWidth * window.devicePixelRatio;
      canvas.height = canvas.clientHeight * window.devicePixelRatio;
    }
  }

  function render() {
    requestAnimationFrame(render);
    resizeCanvas();
    const w = canvas.width;
    const h = canvas.height;

    ctx.fillStyle = '#04060a';
    ctx.fillRect(0, 0, w, h);

    if (!state.power || !state.audio.analyser) {
      // Draw idle flatline
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.2)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();
      return;
    }

    if (state.audio.vizMode === 'fft') {
      // FFT Frequency Bars
      const bufferLength = state.audio.analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      state.audio.analyser.getByteFrequencyData(dataArray);

      const barCount = 48;
      const barWidth = (w / barCount) - 2;
      const step = Math.floor(bufferLength / barCount);

      for (let i = 0; i < barCount; i++) {
        const val = dataArray[i * step] || 0;
        const barHeight = (val / 255) * h * 0.88;
        const x = i * (barWidth + 2);
        const y = h - barHeight;

        // Gradient: Warm Amber to Gold
        const grad = ctx.createLinearGradient(0, y, 0, h);
        grad.addColorStop(0, '#fbbf24');
        grad.addColorStop(0.5, '#f59e0b');
        grad.addColorStop(1, '#78350f');

        ctx.fillStyle = grad;
        ctx.fillRect(x, y, barWidth, barHeight);

        // Glowing peak cap
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x, y - 2, barWidth, 2);
      }
    } else {
      // Oscilloscope Waveform
      const bufferLength = state.audio.analyser.fftSize;
      const dataArray = new Uint8Array(bufferLength);
      state.audio.analyser.getByteTimeDomainData(dataArray);

      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#f59e0b';
      ctx.shadowBlur = 8;
      ctx.shadowColor = '#f59e0b';
      ctx.beginPath();

      const sliceWidth = w / bufferLength;
      let x = 0;
      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = (v * h) / 2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        x += sliceWidth;
      }
      ctx.lineTo(w, h / 2);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
  }

  render();
}

// ==========================================================================
// 6. INTERNET RADIO CLIENT
// ==========================================================================
async function fetchInitialStations() {
  dom.stationCountLabel.textContent = 'Loading top stations...';
  try {
    const res = await fetch('/api/radio/top?limit=36');
    const data = await res.json();
    if (data.status === 'ok') {
      state.net.stations = data.stations;
      renderStationsGrid(data.stations);
      dom.stationCountLabel.textContent = `${data.stations.length} stations loaded`;
    }
  } catch (e) {
    console.error('Error fetching top stations:', e);
    dom.stationCountLabel.textContent = 'Failed to load stations.';
  }
}

async function searchStations() {
  const q = dom.stationSearchInput.value.trim();
  const genre = state.net.genre;
  dom.stationCountLabel.textContent = 'Searching...';
  dom.stationListTitle.textContent = q ? `Search Results for "${q}"` : (genre ? `${genre.toUpperCase()} Stations` : 'Top Global Stations');

  try {
    const params = new URLSearchParams();
    if (q) params.append('q', q);
    if (genre) params.append('genre', genre);
    params.append('limit', '36');

    const res = await fetch(`/api/radio/search?${params.toString()}`);
    const data = await res.json();
    if (data.status === 'ok') {
      state.net.stations = data.stations;
      renderStationsGrid(data.stations);
      dom.stationCountLabel.textContent = `${data.stations.length} stations found`;
    }
  } catch (e) {
    console.error('Search stations failed:', e);
    dom.stationCountLabel.textContent = 'Search failed.';
  }
}

function renderStationsGrid(stations) {
  dom.stationsGrid.innerHTML = '';
  if (!stations || stations.length === 0) {
    dom.stationsGrid.innerHTML = '<div style="grid-column: 1/-1; text-align:center; padding: 2rem; color: #6b7280;">No stations found. Try another genre or search term.</div>';
    return;
  }

  stations.forEach((station) => {
    const isPlaying = state.net.activeStation && state.net.activeStation.stationuuid === station.stationuuid && state.net.isPlaying;
    const card = document.createElement('div');
    card.className = `station-card ${isPlaying ? 'playing' : ''}`;
    card.dataset.uuid = station.stationuuid;

    const faviconHtml = station.favicon ? `<img src="${station.favicon}" alt="logo" onerror="this.onerror=null; this.parentElement.innerHTML='📻';" />` : '📻';

    card.innerHTML = `
      <div class="card-avatar">${faviconHtml}</div>
      <div class="card-info">
        <div class="card-title" title="${escapeHtml(station.name)}">${escapeHtml(station.name)}</div>
        <div class="card-sub">
          <span class="codec-tag">${station.codec} ${station.bitrate ? `${station.bitrate}k` : ''}</span>
          <span class="country-tag">${escapeHtml(station.country || 'Global')}</span>
        </div>
      </div>
      <button class="card-play-btn" title="${isPlaying ? 'Pause' : 'Play'}">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
          ${isPlaying ? '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>' : '<polygon points="5 3 19 12 5 21 5 3"/>'}
        </svg>
      </button>
    `;

    card.addEventListener('click', () => {
      playInternetStation(station);
    });

    dom.stationsGrid.appendChild(card);
  });
}

function playInternetStation(station) {
  ensureAudioContextRunning();
  state.net.activeStation = station;

  // Stop SDR streaming to avoid simultaneous audio
  sendSdrCommand({ action: 'stop' });

  // Update Now Playing Bar
  dom.netradioPlayerBar.classList.remove('hidden');
  dom.npStationName.textContent = station.name;
  dom.npStationMeta.textContent = `Connecting to stream...`;
  dom.npAvatar.innerHTML = station.favicon
    ? `<img src="${station.favicon}" alt="logo" onerror="this.onerror=null; this.parentElement.innerHTML='📻';" />`
    : '📻';

  const audio = dom.htmlAudioPlayer;
  audio.pause();

  // Cleanup any previous Hls instance
  if (window._currentHls) {
    try { window._currentHls.destroy(); } catch (_) {}
    window._currentHls = null;
  }

  // Visual status indicators
  audio.onwaiting = () => {
    console.log('[NetRadio] Buffering audio...');
    dom.npStationMeta.textContent = `Buffering stream • ${station.codec || 'MP3'}...`;
  };

  audio.onplaying = () => {
    console.log('[NetRadio] Playing:', station.name);
    state.net.isPlaying = true;
    updateNetRadioPlayIcons(true);
    dom.npStationMeta.textContent = `LIVE • ${station.codec || 'MP3'} ${station.bitrate ? `• ${station.bitrate} kbps` : ''} • ${station.country || 'Global'}`;
    renderStationsGrid(state.net.stations);
  };

  audio.onerror = (err) => {
    const mediaError = audio.error;
    let errMsg = 'Network or format error';
    if (mediaError) {
      switch (mediaError.code) {
        case 1: errMsg = 'Playback aborted'; break;
        case 2: errMsg = 'Network error while loading stream'; break;
        case 3: errMsg = 'Audio decoding error'; break;
        case 4: errMsg = 'Stream format not supported or remote server offline'; break;
      }
    }
    console.error('[NetRadio] Stream error:', errMsg, mediaError);
    dom.npStationMeta.textContent = `Stream Error: ${errMsg}`;
    state.net.isPlaying = false;
    updateNetRadioPlayIcons(false);
    renderStationsGrid(state.net.stations);
  };

  // Check if HLS stream (.m3u8)
  const isHls = station.url.includes('.m3u8') || (station.codec && station.codec.toUpperCase() === 'HLS');
  if (isHls && window.Hls && Hls.isSupported()) {
    console.log('[NetRadio] Using HLS.js for stream:', station.url);
    const hls = new Hls({ enableWorker: true });
    window._currentHls = hls;
    hls.loadSource(station.url);
    hls.attachMedia(audio);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      audio.play().catch(e => console.warn('HLS play blocked:', e));
    });
    hls.on(Hls.Events.ERROR, (event, data) => {
      console.warn('[NetRadio] HLS error:', data);
      if (data.fatal) {
        dom.npStationMeta.textContent = `HLS Stream error: ${data.details || data.type}`;
      }
    });
  } else {
    // Route through proxy to ensure CORS compliance and bypass anti-bot headers
    const proxyUrl = `/api/proxy/stream?url=${encodeURIComponent(station.url)}`;
    console.log('[NetRadio] Tuning to:', station.name, '| URL:', station.url, '| Proxy:', proxyUrl);

    audio.src = proxyUrl;
    audio.volume = state.isMuted ? 0 : state.volume;

    audio.play().then(() => {
      state.net.isPlaying = true;
      updateNetRadioPlayIcons(true);
      renderStationsGrid(state.net.stations);
    }).catch((err) => {
      console.error('[NetRadio] Playback trigger blocked or failed:', err);
      dom.npStationMeta.textContent = `Stream offline or blocked: ${err.message}`;
    });
  }
}

function updateNetRadioPlayIcons(isPlaying) {
  dom.npPlayIcon.innerHTML = isPlaying
    ? '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'
    : '<polygon points="5 3 19 12 5 21 5 3"/>';
}

// ==========================================================================
// 7. RECEIVER NODE PICKER MODAL
// ==========================================================================
let allReceivers = [];

async function fetchReceiversList() {
  try {
    const res = await fetch('/api/receivers');
    const data = await res.json();
    if (data.status === 'ok') {
      allReceivers = data.receivers;
      renderReceiversModal(allReceivers);
    }
  } catch (e) {
    console.error('Failed to load receivers:', e);
  }
}

function renderReceiversModal(receivers, filterRegion = 'All', filterText = '') {
  dom.receiversList.innerHTML = '';
  let filtered = receivers;

  if (filterRegion !== 'All') {
    filtered = filtered.filter(r => r.region === filterRegion);
  }
  if (filterText) {
    const q = filterText.toLowerCase();
    filtered = filtered.filter(r => r.name.toLowerCase().includes(q) || r.loc.toLowerCase().includes(q) || r.host.toLowerCase().includes(q));
  }

  if (filtered.length === 0) {
    dom.receiversList.innerHTML = '<div style="text-align:center; padding: 1.5rem; color:#6b7280;">No nodes matching filter.</div>';
    return;
  }

  filtered.forEach((rx) => {
    const isCurrent = state.sdr.receiver.host === rx.host && state.sdr.receiver.port === rx.port;
    const item = document.createElement('div');
    item.className = `rx-item ${isCurrent ? 'current' : ''}`;
    item.innerHTML = `
      <div class="rx-item-info">
        <div class="rx-item-name">${escapeHtml(rx.name || rx.loc)}</div>
        <div class="rx-item-loc">${escapeHtml(rx.loc)} • ${escapeHtml(rx.antenna || 'Wire')}</div>
      </div>
      <div class="rx-item-meta">
        <span class="rx-slots-badge">${rx.users}/${rx.users_max} slots</span>
        <button class="btn-pill">${isCurrent ? 'Selected' : 'Connect'}</button>
      </div>
    `;

    item.addEventListener('click', () => {
      switchReceiver(rx);
      dom.receiverModal.classList.add('hidden');
    });

    dom.receiversList.appendChild(item);
  });
}

function switchReceiver(rx) {
  state.sdr.receiver = rx;
  dom.currentRxName.textContent = rx.name || rx.loc;
  dom.currentRxLoc.textContent = rx.loc;

  sendSdrCommand({
    action: 'connect',
    host: rx.host,
    port: rx.port,
    freq: state.sdr.freq,
    mode: state.sdr.mod,
  });
}

// ==========================================================================
// 8. BOOKMARKS & PRESETS
// ==========================================================================
function saveSdrBookmark() {
  const name = prompt('Enter a label for this bookmark:', `${state.sdr.bandName} (${state.sdr.freq} kHz)`);
  if (!name) return;

  const b = {
    id: Date.now().toString(),
    freq: state.sdr.freq,
    mod: state.sdr.mod,
    label: name,
    date: new Date().toLocaleDateString(),
  };

  state.bookmarks.sdr.push(b);
  localStorage.setItem('wavehub_sdr_bookmarks', JSON.stringify(state.bookmarks.sdr));
  renderBookmarks();
  alert(`Preset saved: ${name}`);
}

function saveNetRadioBookmark() {
  if (!state.net.activeStation) return;
  const s = state.net.activeStation;
  if (state.bookmarks.net.some(b => b.stationuuid === s.stationuuid)) {
    alert('Station already bookmarked!');
    return;
  }
  state.bookmarks.net.push(s);
  localStorage.setItem('wavehub_net_bookmarks', JSON.stringify(state.bookmarks.net));
  renderBookmarks();
  alert(`Bookmarked station: ${s.name}`);
}

function renderBookmarks(type = 'sdr') {
  dom.bookmarksList.innerHTML = '';
  const list = type === 'sdr' ? state.bookmarks.sdr : state.bookmarks.net;

  if (list.length === 0) {
    dom.bookmarksList.innerHTML = '<div style="text-align:center; padding: 2rem; color:#6b7280;">No bookmarks saved yet.</div>';
    return;
  }

  list.forEach((item, index) => {
    const div = document.createElement('div');
    div.className = 'bookmark-item';

    if (type === 'sdr') {
      div.innerHTML = `
        <div>
          <div style="font-weight:600; font-size:0.9rem;">${escapeHtml(item.label)}</div>
          <div style="font-family:var(--font-mono); font-size:0.75rem; color:var(--amber-primary);">${item.freq} kHz (${item.mod.toUpperCase()})</div>
        </div>
        <button class="del-bookmark-btn" title="Delete Preset">&times;</button>
      `;
      div.querySelector('div').addEventListener('click', () => {
        tuneFrequency(item.freq, item.mod);
        dom.bookmarksDrawer.classList.add('hidden');
      });
    } else {
      div.innerHTML = `
        <div>
          <div style="font-weight:600; font-size:0.9rem;">${escapeHtml(item.name)}</div>
          <div style="font-size:0.75rem; color:var(--text-dim);">${item.codec} • ${item.country || 'Global'}</div>
        </div>
        <button class="del-bookmark-btn" title="Delete Bookmark">&times;</button>
      `;
      div.querySelector('div').addEventListener('click', () => {
        playInternetStation(item);
        dom.bookmarksDrawer.classList.add('hidden');
      });
    }

    div.querySelector('.del-bookmark-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      list.splice(index, 1);
      if (type === 'sdr') {
        localStorage.setItem('wavehub_sdr_bookmarks', JSON.stringify(state.bookmarks.sdr));
      } else {
        localStorage.setItem('wavehub_net_bookmarks', JSON.stringify(state.bookmarks.net));
      }
      renderBookmarks(type);
    });

    dom.bookmarksList.appendChild(div);
  });
}

// ==========================================================================
// 9. BROADCAST RECORDING FEATURE (WAV / WEBM DOWNLOAD)
// ==========================================================================
function toggleRecording() {
  ensureAudioContextRunning();
  if (!state.isRecording) {
    // Start recording
    state.audio.recordChunks = [];
    try {
      const stream = state.audio.destNode.stream;
      const mediaRecorder = new MediaRecorder(stream);
      state.audio.mediaRecorder = mediaRecorder;

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) state.audio.recordChunks.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(state.audio.recordChunks, { type: 'audio/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        a.download = `wavehub-record-${timestamp}.webm`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 100);
      };

      mediaRecorder.start(250); // Slice every 250ms
      state.isRecording = true;
      dom.recordBtn.classList.add('recording');
      dom.recLabel.textContent = 'REC ●';
    } catch (err) {
      console.error('Failed to start recording:', err);
      alert('Recording is not supported in this browser context.');
    }
  } else {
    // Stop recording
    if (state.audio.mediaRecorder && state.audio.mediaRecorder.state !== 'inactive') {
      state.audio.mediaRecorder.stop();
    }
    state.isRecording = false;
    dom.recordBtn.classList.remove('recording');
    dom.recLabel.textContent = 'REC';
  }
}

// ==========================================================================
// 10. EVENT LISTENERS
// ==========================================================================
function initEventListeners() {
  // Global user interaction listener to unlock AudioContext under browser autoplay policies
  ['click', 'touchstart', 'keydown'].forEach((evt) => {
    window.addEventListener(evt, () => {
      ensureAudioContextRunning();
    }, { passive: true });
  });

  // Mode tabs
  dom.tabWebsdr.addEventListener('click', () => {
    ensureAudioContextRunning();
    switchAppMode('websdr');
  });
  dom.tabNetradio.addEventListener('click', () => {
    ensureAudioContextRunning();
    switchAppMode('netradio');
  });

  // Power Button
  dom.powerBtn.addEventListener('click', () => {
    ensureAudioContextRunning();
    state.power = !state.power;
    if (state.power) {
      dom.powerBtn.classList.remove('off');
      dom.powerBtn.classList.add('on');
      if (state.mode === 'websdr') connectSdr();
      else if (state.net.activeStation) dom.htmlAudioPlayer.play();
    } else {
      dom.powerBtn.classList.remove('on');
      dom.powerBtn.classList.add('off');
      if (state.sdr.ws) state.sdr.ws.close();
      dom.htmlAudioPlayer.pause();
    }
  });

  // Recording
  dom.recordBtn.addEventListener('click', toggleRecording);

  // Bookmarks
  dom.bookmarksBtn.addEventListener('click', () => {
    dom.bookmarksDrawer.classList.remove('hidden');
    renderBookmarks('sdr');
  });
  dom.closeBookmarksDrawer.addEventListener('click', () => {
    dom.bookmarksDrawer.classList.add('hidden');
  });
  dom.saveSdrBookmark.addEventListener('click', saveSdrBookmark);
  dom.npBookmarkBtn.addEventListener('click', saveNetRadioBookmark);

  dom.drawerTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      dom.drawerTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderBookmarks(tab.dataset.btype);
    });
  });

  // Volume & Mute
  dom.masterVolume.addEventListener('input', (e) => {
    state.volume = parseFloat(e.target.value);
    if (state.audio.gainNode) state.audio.gainNode.gain.value = state.isMuted ? 0 : state.volume;
    dom.htmlAudioPlayer.volume = state.isMuted ? 0 : state.volume;
  });

  dom.muteBtn.addEventListener('click', () => {
    state.isMuted = !state.isMuted;
    if (state.audio.gainNode) state.audio.gainNode.gain.value = state.isMuted ? 0 : state.volume;
    dom.htmlAudioPlayer.volume = state.isMuted ? 0 : state.volume;
    dom.muteBtn.style.color = state.isMuted ? 'var(--red-rec)' : 'var(--text-muted)';
  });

  // Step Frequency Buttons
  dom.stepBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const stepKhz = parseFloat(btn.dataset.step) / 1000.0;
      tuneFrequency(state.sdr.freq + stepKhz);
    });
  });

  // Frequency Slider
  dom.freqSlider.addEventListener('input', (e) => {
    tuneFrequency(parseFloat(e.target.value));
  });

  // Direct Frequency Form
  dom.directTuneForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const val = parseFloat(dom.directFreqInput.value);
    if (!isNaN(val)) tuneFrequency(val);
  });

  // Demodulation Mode Buttons
  dom.modeBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      dom.modeBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.sdr.mod = btn.dataset.mod;
      dom.telemetryDemod.textContent = state.sdr.mod.toUpperCase();
      tuneFrequency(state.sdr.freq, state.sdr.mod);
    });
  });

  // Band Presets
  dom.bandChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      dom.bandChips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      const freq = parseFloat(chip.dataset.freq);
      const mod = chip.dataset.mod;
      tuneFrequency(freq, mod);

      // Update mode button active state
      dom.modeBtns.forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.mod === mod);
      });
      dom.telemetryDemod.textContent = mod.toUpperCase();
    });
  });

  // Visualizer Mode Toggles
  dom.vizModeFft.addEventListener('click', () => {
    state.audio.vizMode = 'fft';
    dom.vizModeFft.classList.add('active');
    dom.vizModeWave.classList.remove('active');
  });

  dom.vizModeWave.addEventListener('click', () => {
    state.audio.vizMode = 'wave';
    dom.vizModeWave.classList.add('active');
    dom.vizModeFft.classList.remove('active');
  });

  // Receiver Node Picker Modal
  dom.openRxPicker.addEventListener('click', () => {
    dom.receiverModal.classList.remove('hidden');
    renderReceiversModal(allReceivers);
  });

  dom.closeReceiverModal.addEventListener('click', () => {
    dom.receiverModal.classList.add('hidden');
  });

  dom.rxFilterInput.addEventListener('input', (e) => {
    const activeRegionTab = document.querySelector('.region-tab.active');
    const region = activeRegionTab ? activeRegionTab.dataset.region : 'All';
    renderReceiversModal(allReceivers, region, e.target.value);
  });

  document.querySelectorAll('.region-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.region-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderReceiversModal(allReceivers, tab.dataset.region, dom.rxFilterInput.value);
    });
  });

  // Net Radio Search & Genres
  dom.refreshStationsBtn.addEventListener('click', searchStations);
  dom.stationSearchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') searchStations();
  });
  dom.stationSearchInput.addEventListener('input', () => {
    dom.clearSearchBtn.style.display = dom.stationSearchInput.value ? 'block' : 'none';
  });
  dom.clearSearchBtn.addEventListener('click', () => {
    dom.stationSearchInput.value = '';
    dom.clearSearchBtn.style.display = 'none';
    searchStations();
  });

  dom.genrePills.forEach((pill) => {
    pill.addEventListener('click', () => {
      dom.genrePills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      state.net.genre = pill.dataset.genre;
      searchStations();
    });
  });

  // Net Radio Now Playing Bar Play/Pause
  dom.npPlayPauseBtn.addEventListener('click', () => {
    const audio = dom.htmlAudioPlayer;
    if (audio.paused) {
      audio.play();
      state.net.isPlaying = true;
      updateNetRadioPlayIcons(true);
    } else {
      audio.pause();
      state.net.isPlaying = false;
      updateNetRadioPlayIcons(false);
    }
  });
}

function switchAppMode(mode) {
  state.mode = mode;
  if (mode === 'websdr') {
    dom.tabWebsdr.classList.add('active');
    dom.tabNetradio.classList.remove('active');
    dom.websdrView.classList.add('active');
    dom.netradioView.classList.remove('active');
    dom.htmlAudioPlayer.pause();
    state.net.isPlaying = false;
    updateNetRadioPlayIcons(false);
    connectSdr();
  } else {
    dom.tabNetradio.classList.add('active');
    dom.tabWebsdr.classList.remove('active');
    dom.netradioView.classList.add('active');
    dom.websdrView.classList.remove('active');
    // Stop SDR audio while listening to Net Radio
    sendSdrCommand({ action: 'stop' });
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
