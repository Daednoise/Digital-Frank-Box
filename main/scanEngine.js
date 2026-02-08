const http = require("http");
const https = require("https");
const { URL } = require("url");
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const DEFAULT_HOST = "na5b.com:8901";
const DEFAULT_USERNAME = "DX Scanner";
const DEFAULT_HOP_MS = 500;
const DUCK_LEAD_MS = 60;
const DUCK_TRAIL_MS = 120;
const DUCK_DB = 0;
const NOISE_TYPES = new Set(["pink", "white", "green", "brown"]);
const DEFAULT_DX_RANGES = [
  [0, 2048],
  [3200, 5248],
  [5324, 7372],
  [8825, 10873],
  [11599, 13647],
  [13655, 15703],
  [20888, 21912],
  [26961, 29009],
];

const RECORDINGS_DIR = path.join(__dirname, "recordings");

function ensureRecordingsDir() {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

function sanitizeLabel(input) {
  if (!input) return "";
  return String(input)
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function createRecordingName(label) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safe = sanitizeLabel(label);
  return safe ? `recording-${stamp}-${safe}.wav` : `recording-${stamp}.wav`;
}

class WavWriter {
  constructor(filePath, sampleRate, channels = 1, bitsPerSample = 16) {
    this.filePath = filePath;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.bitsPerSample = bitsPerSample;
    this.dataLength = 0;
    this.fd = fs.openSync(filePath, "w");
    this.writeHeader(0);
  }

  writeHeader(dataLength) {
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + dataLength, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(this.channels, 22);
    header.writeUInt32LE(this.sampleRate, 24);
    const byteRate = (this.sampleRate * this.channels * this.bitsPerSample) / 8;
    header.writeUInt32LE(byteRate, 28);
    const blockAlign = (this.channels * this.bitsPerSample) / 8;
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(this.bitsPerSample, 34);
    header.write("data", 36);
    header.writeUInt32LE(dataLength, 40);
    fs.writeSync(this.fd, header, 0, header.length, 0);
  }

  writeSamples(int16Array) {
    const buffer = Buffer.from(int16Array.buffer, int16Array.byteOffset, int16Array.byteLength);
    fs.writeSync(this.fd, buffer, 0, buffer.length, 44 + this.dataLength);
    this.dataLength += buffer.length;
  }

  finalize() {
    this.writeHeader(this.dataLength);
    fs.closeSync(this.fd);
  }
}

function floatToInt16(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    let s = Number.isFinite(samples[i]) ? samples[i] : 0;
    s = Math.max(-1, Math.min(1, s));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function normalizeOptions(input = {}) {
  const options = {
    host: DEFAULT_HOST,
    dxUrls: [],
    dxMin: null,
    dxMax: null,
    hopMs: DEFAULT_HOP_MS,
    listen: true,
    noiseType: "pink",
    noiseVolume: 100,
    loops: Infinity,
    minFreq: null,
    maxFreq: null,
    username: DEFAULT_USERNAME,
    maxDurationMs: null,
  };

  if (typeof input.host === "string" && input.host.trim()) {
    options.host = input.host.trim();
  }

  if (Array.isArray(input.dxUrls)) {
    options.dxUrls = input.dxUrls.filter(Boolean);
  } else if (typeof input.dxUrls === "string" && input.dxUrls.trim()) {
    options.dxUrls = [input.dxUrls.trim()];
  }

  if (input.dxMin !== null && input.dxMin !== undefined && input.dxMin !== "") {
    const dxMin = Number(input.dxMin);
    if (Number.isFinite(dxMin)) options.dxMin = dxMin;
  }
  if (input.dxMax !== null && input.dxMax !== undefined && input.dxMax !== "") {
    const dxMax = Number(input.dxMax);
    if (Number.isFinite(dxMax)) options.dxMax = dxMax;
  }
  if (input.hopMs !== null && input.hopMs !== undefined && input.hopMs !== "") {
    const hopMs = Number(input.hopMs);
    if (Number.isFinite(hopMs)) options.hopMs = hopMs;
  }
  if (typeof input.listen === "boolean") options.listen = input.listen;

  if (typeof input.noiseType === "string") {
    const normalized = input.noiseType.toLowerCase();
    if (normalized === "blue") {
      options.noiseType = "green";
    } else if (NOISE_TYPES.has(normalized)) {
      options.noiseType = normalized;
    }
  }

  if (input.noiseVolume !== null && input.noiseVolume !== undefined && input.noiseVolume !== "") {
    const noiseVolume = Number(input.noiseVolume);
    if (Number.isFinite(noiseVolume)) {
      options.noiseVolume = Math.max(0, Math.min(100, noiseVolume));
    }
  }

  if (input.minFreq !== null && input.minFreq !== undefined && input.minFreq !== "") {
    const minFreq = Number(input.minFreq);
    if (Number.isFinite(minFreq)) options.minFreq = minFreq;
  }
  if (input.maxFreq !== null && input.maxFreq !== undefined && input.maxFreq !== "") {
    const maxFreq = Number(input.maxFreq);
    if (Number.isFinite(maxFreq)) options.maxFreq = maxFreq;
  }

  if (typeof input.username === "string" && input.username.trim()) {
    options.username = input.username.trim();
  }

  if (input.loops !== null && input.loops !== undefined && input.loops !== "") {
    const loops = parseInt(input.loops, 10);
    if (Number.isFinite(loops)) options.loops = loops;
  }

  if (input.maxDurationMs === null) {
    options.maxDurationMs = null;
  } else if (input.maxDurationMs !== undefined && input.maxDurationMs !== "") {
    const maxDurationMs = Number(input.maxDurationMs);
    if (Number.isFinite(maxDurationMs)) {
      options.maxDurationMs = Math.max(0, maxDurationMs);
    }
  }

  if (Number.isFinite(options.minFreq) && Number.isFinite(options.maxFreq) && options.minFreq > options.maxFreq) {
    [options.minFreq, options.maxFreq] = [options.maxFreq, options.minFreq];
  }

  if (!Number.isFinite(options.hopMs) || options.hopMs <= 0) {
    options.hopMs = DEFAULT_HOP_MS;
  }

  if (options.loops <= 0 || !Number.isFinite(options.loops)) {
    options.loops = Infinity;
  }

  if (!NOISE_TYPES.has(options.noiseType)) options.noiseType = "pink";

  return options;
}

function resolveDxSources(options, host) {
  const result = [];
  if (options.dxUrls.length) {
    result.push(...options.dxUrls);
  } else if (Number.isFinite(options.dxMin) && Number.isFinite(options.dxMax)) {
    result.push(`http://${host}/~~fetchdx?min=${options.dxMin}&max=${options.dxMax}`);
  } else {
    for (const [min, max] of DEFAULT_DX_RANGES) {
      result.push(`http://${host}/~~fetchdx?min=${min}&max=${max}`);
    }
  }
  return result;
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(
      url,
      {
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept-Encoding": "identity",
        },
      },
      res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(fetchText(res.headers.location));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} when fetching ${url}`));
        return;
      }
      let body = "";
      const encoding = String(res.headers["content-encoding"] || "").toLowerCase();
      let stream = res;
      if (encoding.includes("gzip")) {
        stream = res.pipe(zlib.createGunzip());
      } else if (encoding.includes("deflate")) {
        stream = res.pipe(zlib.createInflate());
      } else if (encoding.includes("br") && typeof zlib.createBrotliDecompress === "function") {
        stream = res.pipe(zlib.createBrotliDecompress());
      }
      stream.setEncoding("utf8");
      stream.on("data", chunk => {
        body += chunk;
      });
      stream.on("end", () => resolve(body));
    }
    );
    req.on("error", reject);
  });
}

function parseDxList(text, { minFreq = null, maxFreq = null } = {}) {
  const entries = [];
  const seen = new Set();
  const regex = /dx\(\s*([\d.]+)\s*,\s*(['"])(.*?)\2\s*,\s*(['"])(.*?)\4\s*\)\s*;?/gi;
  let match;
  while ((match = regex.exec(text))) {
    const freq = parseFloat(match[1]);
    if (!Number.isFinite(freq)) continue;
    if (Number.isFinite(minFreq) && freq < minFreq) continue;
    if (Number.isFinite(maxFreq) && freq > maxFreq) continue;
    const mode = match[3].trim().toUpperCase() || "AM";
    const description = match[5].replace(/<br>/gi, " ").replace(/\s+/g, " ").trim();
    const key = freq.toFixed(3);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ freq, mode, description });
  }
  return entries;
}

function abortError() {
  const err = new Error("Scan aborted");
  err.name = "AbortError";
  return err;
}

function isAbortError(err) {
  return err && (err.name === "AbortError" || err.code === "ABORT_ERR");
}

function withAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort);
    promise.then(
      value => {
        cleanup();
        resolve(value);
      },
      err => {
        cleanup();
        reject(err);
      }
    );
  });
}

function sleep(ms, signal) {
  if (!ms || ms <= 0) return Promise.resolve();
  const promise = new Promise(resolve => {
    const id = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(id);
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      signal.addEventListener("abort", onAbort);
    }
  });
  return withAbort(promise, signal);
}

function getRemainingMs(getDeadlineMs) {
  if (typeof getDeadlineMs !== "function") return null;
  const deadline = getDeadlineMs();
  if (!Number.isFinite(deadline)) return null;
  return deadline - Date.now();
}

async function boundedSleep(ms, signal, getDeadlineMs) {
  if (!ms || ms <= 0) return;
  const remaining = getRemainingMs(getDeadlineMs);
  if (remaining !== null && remaining <= 0) {
    throw abortError();
  }
  const wait = remaining !== null ? Math.min(ms, remaining) : ms;
  if (wait <= 0) {
    throw abortError();
  }
  await sleep(wait, signal);
  const remainingAfter = getRemainingMs(getDeadlineMs);
  if (remainingAfter !== null && remainingAfter <= 0) {
    throw abortError();
  }
}

async function preparePage(browser, host, { username, listen, noiseType, noiseVolume }, signal) {
  const viewport = { width: 100, height: 100 };
  const context = await withAbort(
    browser.newContext({
      acceptDownloads: false,
      viewport,
    }),
    signal
  );
  const page = await withAbort(context.newPage(), signal);
  await withAbort(page.goto(`http://${host}/`, { waitUntil: "load", timeout: 120000 }), signal);
  if (listen) {
    await minimizePageWindow(page);
  }
  await withAbort(page.waitForFunction(() => typeof window.setfreqb === "function", null, { timeout: 60000 }), signal);
  await withAbort(
    page.evaluate(
      async ({ username }) => {
        if (document.usernameform?.username) document.usernameform.username.value = username;
        window.usejavasound = 0;
        window.usehtml5sound = 1;
        window.chrome_audio_start?.();
        window.iOS_audio_start?.();
        window.soundapplet?.audioresume?.();
      },
      { username }
    ),
    signal
  );
  await sleep(1500, signal);
  await withAbort(page.waitForFunction(() => window.soundapplet && window.soundapplet.p && document.ct, null, { timeout: 30000 }), signal);
  await installSdrGainChain(page);
  if (noiseType) {
    await startNoiseGenerator(page, noiseType, noiseVolume);
  }
  if (!listen) {
    await withAbort(page.evaluate(() => window.soundapplet?.audioresume?.()), signal);
  }
  return page;
}

async function minimizePageWindow(page) {
  try {
    const session = await page.context().newCDPSession(page);
    const { windowId } = await session.send("Browser.getWindowForTarget");
    await session.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "minimized" },
    });
  } catch {
    // ignore if minimization isn't supported
  }
}

async function startNoiseGenerator(page, noiseType, noiseVolume) {
  const noiseGain = Number.isFinite(noiseVolume) ? Math.max(0, Math.min(1, noiseVolume / 100)) : 1;
  await page.evaluate(
    async ({ noiseType, noiseGain }) => {
      if (!noiseType) return;
      window.__noiseType = noiseType;
      if (Number.isFinite(noiseGain)) {
        window.__noiseGain = noiseGain;
      }
      if (window.__noiseStarted) return;
      window.__noiseStarted = true;
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = document.ct || new AudioCtx({ latencyHint: "interactive" });
      const bufferSize = 4096;
      const node = ctx.createScriptProcessor(bufferSize, 1, 1);
      let b0 = 0,
        b1 = 0,
        b2 = 0,
        b3 = 0,
        b4 = 0,
        b5 = 0,
        b6 = 0;
      let brown = 0;
      let greenLP = 0;
      let greenBP = 0;
      const gains = {
        pink: 0.02,
        white: 0.02,
        brown: 0.02,
        green: 0.02,
      };
      node.onaudioprocess = e => {
        const input = e.inputBuffer.getChannelData(0);
        const output = e.outputBuffer.getChannelData(0);
        const currentType = window.__noiseType || noiseType;
        const gainScale = Number.isFinite(window.__noiseGain) ? window.__noiseGain : 1;
        for (let i = 0; i < bufferSize; i++) {
          const white = Math.random() * 2 - 1;
          let sample = white;
          switch (currentType) {
            case "pink": {
              b0 = 0.99886 * b0 + white * 0.0555179;
              b1 = 0.99332 * b1 + white * 0.0750759;
              b2 = 0.969 * b2 + white * 0.153852;
              b3 = 0.8665 * b3 + white * 0.3104856;
              b4 = 0.55 * b4 + white * 0.5329522;
              b5 = -0.7616 * b5 - white * 0.016898;
              const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
              b6 = white * 0.115926;
              sample = pink;
              break;
            }
            case "brown": {
              brown = (brown + white) * 0.996;
              sample = Math.max(Math.min(brown, 1), -1);
              break;
            }
            case "green": {
              greenLP += 0.02 * (white - greenLP);
              const high = white - greenLP;
              greenBP += 0.02 * (high - greenBP);
              sample = greenBP;
              break;
            }
            case "white":
            default:
              sample = white;
              break;
          }
          const gain = (gains[currentType] ?? 0.02) * gainScale;
          output[i] = sample * gain + input[i];
        }
      };
      const target = window.__sdrAnalyzer || ctx.destination;
      node.connect(target);
      try {
        await ctx.resume();
      } catch {
        // ignore if autoplay policy blocks resume
      }
      window.__noiseContext = ctx;
      window.__noiseNode = node;
    },
    { noiseType, noiseGain }
  );
}

async function updateNoiseSettings(page, { noiseType, noiseVolume }) {
  const noiseGain = Number.isFinite(noiseVolume) ? Math.max(0, Math.min(1, noiseVolume / 100)) : null;
  await page.evaluate(
    ({ noiseType, noiseGain }) => {
      if (noiseType) {
        window.__noiseType = noiseType;
      }
      if (Number.isFinite(noiseGain)) {
        window.__noiseGain = noiseGain;
      }
    },
    { noiseType, noiseGain }
  );
}

async function startWaveformStream(page, { fps = 20, size = 256 } = {}, onWaveform) {
  if (page.__waveformBound) return;
  await page.exposeBinding("__waveformEmit", (_source, payload) => {
    if (typeof onWaveform === "function") {
      onWaveform(payload);
    }
  });
  page.__waveformBound = true;
  await page.evaluate(
    ({ fps, size }) => {
      if (window.__waveformTimer) return;
      const analyser = window.__sdrAnalyzer;
      if (!analyser) return;
      const desiredSize = Math.max(64, Math.min(1024, Math.floor(size)));
      const fftSize = Math.max(256, 1 << Math.ceil(Math.log2(desiredSize)));
      analyser.fftSize = fftSize;
      let buffer = new Float32Array(analyser.fftSize);
      const interval = Math.max(10, Math.floor(1000 / Math.max(1, fps)));
      window.__waveformTimer = setInterval(() => {
        if (!window.__sdrAnalyzer) return;
        const active = window.__sdrAnalyzer;
        if (active.fftSize !== buffer.length) {
          buffer = new Float32Array(active.fftSize);
        }
        active.getFloatTimeDomainData(buffer);
        const step = Math.max(1, Math.floor(buffer.length / desiredSize));
        const samples = new Array(desiredSize);
        for (let i = 0; i < desiredSize; i++) {
          samples[i] = buffer[i * step];
        }
        window.__waveformEmit({ samples, ts: Date.now() });
      }, interval);
    },
    { fps, size }
  );
}

async function ensureRecordingBridge(page, onChunk) {
  if (page.__recordingBound) return;
  await page.exposeBinding("__recordingEmit", (_source, payload) => {
    if (typeof onChunk === "function") {
      onChunk(payload);
    }
  });
  page.__recordingBound = true;
}

async function tune(page, freqKHz, mode, username) {
  await page.evaluate(
    ({ freqKHz, mode, username }) => {
      if (document.usernameform?.username) document.usernameform.username.value = username;
      if (mode) window.set_mode?.(mode.toUpperCase());
      window.setfreqb?.(freqKHz);
      window.send_soundsettings_to_server?.();
    },
    { freqKHz, mode, username }
  );
}

async function installSdrGainChain(page) {
  await page.evaluate(
    ({ duckDb }) => {
      if (!window.soundapplet?.p || !document.ct) return;
      const ctx = document.ct;
      const source = window.soundapplet.p;
      let gainNode = window.__sdrGainNode;
      let compressor = window.__sdrCompressor;
      if (!gainNode || !compressor) {
        compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = -28;
        compressor.knee.value = 18;
        compressor.ratio.value = 12;
        compressor.attack.value = 0.003;
        compressor.release.value = 0.25;

        gainNode = ctx.createGain();
        gainNode.gain.value = 1.0;

        try {
          source.disconnect();
        } catch {
          // ignore if not connected yet
        }

        source.connect(compressor);
        compressor.connect(gainNode);
        window.__sdrGainNode = gainNode;
        window.__sdrCompressor = compressor;
        window.__sdrBaseGain = 1.0;
        window.__sdrDuckGain = Math.pow(10, duckDb / 20);
      }

      let analyser = window.__sdrAnalyzer;
      if (!analyser) {
        analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        window.__sdrAnalyzer = analyser;
      }

      let recorder = window.__sdrRecorder;
      if (!recorder) {
        const bufferSize = 4096;
        recorder = ctx.createScriptProcessor(bufferSize, 1, 1);
        recorder.onaudioprocess = e => {
          const input = e.inputBuffer.getChannelData(0);
          const output = e.outputBuffer.getChannelData(0);
          output.set(input);
          if (window.__recordingActive && window.__recordingEmit) {
            window.__recordingEmit({
              samples: Array.from(input),
              sampleRate: ctx.sampleRate,
            });
          }
        };
        window.__sdrRecorder = recorder;
      }

      try {
        gainNode.disconnect();
      } catch {
        // ignore if not connected yet
      }
      try {
        analyser.disconnect();
      } catch {
        // ignore if not connected yet
      }
      try {
        recorder.disconnect();
      } catch {
        // ignore if not connected yet
      }
      gainNode.connect(analyser);
      analyser.connect(recorder);
      recorder.connect(ctx.destination);
    },
    { duckDb: DUCK_DB }
  );
}

async function setSdrDucked(page, ducked) {
  await page.evaluate(duckedFlag => {
    const ctx = document.ct;
    const gainNode = window.__sdrGainNode;
    if (!ctx || !gainNode) return;
    const baseGain = Number.isFinite(window.__sdrBaseGain) ? window.__sdrBaseGain : 1.0;
    const duckGain = Number.isFinite(window.__sdrDuckGain) ? window.__sdrDuckGain : 0.01;
    const target = duckedFlag ? duckGain : baseGain;
    const now = ctx.currentTime;
    gainNode.gain.cancelScheduledValues(now);
    gainNode.gain.setTargetAtTime(target, now, 0.01);
  }, ducked);
}

function shuffleStations(list) {
  const arr = list.map((station, idx) => ({ station, idx }));
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.map(entry => entry.station);
}

async function sweepPresetFrequencies(page, stations, { hopMs, loops, username, onTune, signal, getHopMs, getDeadlineMs }) {
  let loopCounter = 0;
  while (loopCounter < loops) {
    const shuffled = shuffleStations(stations);
    for (const station of shuffled) {
      const remaining = getRemainingMs(getDeadlineMs);
      if (remaining !== null && remaining <= 0) throw abortError();
      if (signal?.aborted) throw abortError();
      const startedAt = Date.now();
      if (typeof onTune === "function") {
        onTune({
          freq: station.freq,
          mode: station.mode,
          description: station.description,
          startedAt,
        });
      }
      await setSdrDucked(page, true);
      try {
        if (DUCK_LEAD_MS > 0) await boundedSleep(DUCK_LEAD_MS, signal, getDeadlineMs);
        await withAbort(tune(page, station.freq, station.mode, username), signal);
        if (DUCK_TRAIL_MS > 0) await boundedSleep(DUCK_TRAIL_MS, signal, getDeadlineMs);
      } finally {
        await setSdrDucked(page, false);
      }
      const elapsed = Date.now() - startedAt;
      const hopTarget = typeof getHopMs === "function" ? getHopMs() : hopMs;
      const wait = Math.max(0, hopTarget - elapsed);
      if (wait > 0) await boundedSleep(wait, signal, getDeadlineMs);
    }
    if (loops !== Infinity) loopCounter += 1;
  }
}

async function runScan(rawOptions, handlers = {}, signal) {
  const options = normalizeOptions(rawOptions);
  const dxUrls = resolveDxSources(options, options.host);

  const masterStations = [];
  const seenKeys = new Set();
  let lastDxUrl = null;
  let lastDxLen = null;
  let lastDxHasDx = null;
  for (const dxUrl of dxUrls) {
    if (signal?.aborted) throw abortError();
    lastDxUrl = dxUrl;
    const dxText = await fetchText(dxUrl);
    lastDxLen = dxText.length;
    lastDxHasDx = /dx\(/i.test(dxText);
    const stations = parseDxList(dxText, { minFreq: options.minFreq, maxFreq: options.maxFreq });
    for (const station of stations) {
      const key = `${station.freq.toFixed(3)}|${station.mode}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      masterStations.push(station);
    }
  }

  if (!masterStations.length) {
    const detail = lastDxUrl
      ? ` Last source: ${lastDxUrl} (len ${lastDxLen ?? 0}, has dx: ${lastDxHasDx ? "yes" : "no"}).`
      : "";
    throw new Error(`DX list is empty; nothing to scan.${detail}`);
  }

  const browser = await chromium.launch({
    headless: !options.listen,
    args: ["--autoplay-policy=no-user-gesture-required", "--start-minimized"],
  });

  try {
    const page = await preparePage(browser, options.host, options, signal);
    if (typeof handlers.onReady === "function") {
      handlers.onReady({ page, options });
    }
    if (typeof handlers.onWaveform === "function") {
      await startWaveformStream(page, { fps: 60, size: 256 }, handlers.onWaveform);
    }
    await sweepPresetFrequencies(page, masterStations, {
      hopMs: options.hopMs,
      loops: options.loops,
      username: options.username,
      onTune: handlers.onTune,
      signal,
      getHopMs: handlers.getHopMs,
      getDeadlineMs: handlers.getDeadlineMs,
    });
  } finally {
    await browser.close();
  }
}

function createScanServer({ port = 8787 } = {}) {
  const state = {
    running: false,
    startedAt: null,
    startedAtMs: null,
    options: null,
    lastTune: null,
    lastError: null,
    stopReason: null,
    scanId: 0,
    control: null,
    sessionTimer: null,
    recording: {
      active: false,
      filePath: null,
      fileName: null,
      writer: null,
      sampleRate: null,
    },
    lastRecordingFile: null,
  };

  const sseClients = new Set();
  let currentScan = null;
  let durationTimer = null;

  const broadcast = (event, data) => {
    for (const res of sseClients) {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  };

  const publishStatus = () => {
    broadcast("status", {
      running: state.running,
      startedAt: state.startedAt,
      options: state.options,
      lastTune: state.lastTune,
      lastError: state.lastError,
      stopReason: state.stopReason,
      scanId: state.scanId,
      recording: state.recording.active,
      recordingFile: state.recording.fileName,
      lastRecordingFile: state.lastRecordingFile,
    });
  };

  const clearDurationTimer = () => {
    if (durationTimer) {
      clearTimeout(durationTimer);
      durationTimer = null;
    }
  };

  const setSessionTimer = (controller, maxDurationMs) => {
    clearDurationTimer();
    if (maxDurationMs === null || maxDurationMs === undefined) {
      return;
    }
    if (!Number.isFinite(maxDurationMs)) {
      return;
    }
    if (maxDurationMs <= 0) {
      controller.abort();
      return;
    }
    const startedAtMs = Number.isFinite(state.startedAtMs) ? state.startedAtMs : Date.now();
    const endAt = startedAtMs + maxDurationMs;
    const remaining = endAt - Date.now();
    if (remaining <= 0) {
      controller.abort();
      return;
    }
    durationTimer = setTimeout(() => {
      controller.abort();
    }, remaining);
  };

  const stopRecordingInternal = async () => {
    if (!state.recording.active) return;
    state.recording.active = false;
    if (state.recording.fileName) {
      state.lastRecordingFile = state.recording.fileName;
    }
    try {
      await state.control?.page?.evaluate(() => {
        window.__recordingActive = false;
      });
    } catch {
      // ignore if page already closed
    }
    try {
      state.recording.writer?.finalize();
    } catch {
      // ignore finalize errors
    }
    state.recording.filePath = null;
    state.recording.fileName = null;
    state.recording.writer = null;
    state.recording.sampleRate = null;
  };

  const startRecordingInternal = async (label) => {
    if (!state.running) {
      throw new Error("No active scan.");
    }
    if (!state.control?.page) {
      throw new Error("Scan not ready.");
    }
    if (state.recording.active) {
      throw new Error("Recording already active.");
    }
    ensureRecordingsDir();
    const fileName = createRecordingName(label);
    const filePath = path.join(RECORDINGS_DIR, fileName);
    const sampleRate = await state.control.page.evaluate(() => document.ct?.sampleRate || 44100);
    const writer = new WavWriter(filePath, sampleRate, 1, 16);

    await ensureRecordingBridge(state.control.page, payload => {
      if (!state.recording.active) return;
      if (!payload || !Array.isArray(payload.samples)) return;
      const int16 = floatToInt16(payload.samples);
      state.recording.writer?.writeSamples(int16);
    });

    await state.control.page.evaluate(() => {
      window.__recordingActive = true;
    });

    state.recording.active = true;
    state.recording.filePath = filePath;
    state.recording.fileName = fileName;
    state.recording.writer = writer;
    state.recording.sampleRate = sampleRate;
    state.lastRecordingFile = fileName;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === "/api/scan/events" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.write("\n");
      sseClients.add(res);
      publishStatus();

      const keepAlive = setInterval(() => {
        res.write(": ping\n\n");
      }, 15000);

      req.on("close", () => {
        clearInterval(keepAlive);
        sseClients.delete(res);
      });
      return;
    }

    if (url.pathname === "/api/scan/status" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          running: state.running,
          startedAt: state.startedAt,
          options: state.options,
          lastTune: state.lastTune,
          lastError: state.lastError,
          stopReason: state.stopReason,
          scanId: state.scanId,
          recording: state.recording.active,
          recordingFile: state.recording.fileName,
          lastRecordingFile: state.lastRecordingFile,
        })
      );
      return;
    }

    if (url.pathname === "/api/scan/start" && req.method === "POST") {
      if (state.running) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Scan already running." }));
        return;
      }

      const payload = await readJson(req, res);
      if (!payload) return;
      const options = normalizeOptions(payload);
      state.running = true;
      state.startedAt = new Date().toISOString();
      state.startedAtMs = Date.now();
      state.options = options;
      state.lastTune = null;
      state.lastError = null;
      state.stopReason = null;
      state.scanId += 1;
      state.control = null;

      const controller = new AbortController();
      currentScan = { controller, id: state.scanId };
      publishStatus();

      setSessionTimer(controller, options.maxDurationMs);

      runScan(
        options,
        {
        onTune: tuneInfo => {
          state.lastTune = {
            ...tuneInfo,
            scanId: state.scanId,
            timestamp: new Date().toISOString(),
          };
          broadcast("tune", state.lastTune);
        },
        onWaveform: payload => {
          if (payload && Array.isArray(payload.samples)) {
            broadcast("waveform", {
              samples: payload.samples,
              ts: payload.ts || Date.now(),
            });
          }
        },
        onReady: ({ page, options: resolvedOptions }) => {
          state.control = {
            page,
          };
          state.options = resolvedOptions;
          publishStatus();
        },
        getHopMs: () => state.options?.hopMs ?? DEFAULT_HOP_MS,
        getDeadlineMs: () => {
          const maxDurationMs = state.options?.maxDurationMs;
          if (!Number.isFinite(maxDurationMs)) return null;
          const startedAtMs = Number.isFinite(state.startedAtMs) ? state.startedAtMs : Date.now();
          return startedAtMs + maxDurationMs;
        },
      },
        controller.signal
      )
        .then(async () => {
          state.running = false;
          state.stopReason = "completed";
          state.control = null;
          state.startedAtMs = null;
          await stopRecordingInternal();
          clearDurationTimer();
          publishStatus();
        })
        .catch(async err => {
          state.running = false;
          clearDurationTimer();
          state.control = null;
          state.startedAtMs = null;
          await stopRecordingInternal();
          if (isAbortError(err)) {
            state.stopReason = "aborted";
          } else {
            state.lastError = err?.message || String(err);
            state.stopReason = "error";
          }
          publishStatus();
        });

      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, scanId: state.scanId }));
      return;
    }

    if (url.pathname === "/api/scan/record/start" && req.method === "POST") {
      const payload = await readJson(req, res);
      if (payload === null) return;
      try {
        await startRecordingInternal(payload?.label);
      } catch (err) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message || String(err) }));
        return;
      }
      publishStatus();
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, fileName: state.recording.fileName }));
      return;
    }

    if (url.pathname === "/api/scan/record/stop" && req.method === "POST") {
      if (!state.recording.active) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No active recording." }));
        return;
      }
      await stopRecordingInternal();
      publishStatus();
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, fileName: state.lastRecordingFile }));
      return;
    }

    if (url.pathname === "/api/scan/record/download" && req.method === "GET") {
      const file = url.searchParams.get("file");
      if (!file) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing file parameter." }));
        return;
      }
      const safeName = path.basename(file);
      const filePath = path.join(RECORDINGS_DIR, safeName);
      if (!filePath.startsWith(RECORDINGS_DIR)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid file path." }));
        return;
      }
      fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Recording not found." }));
          return;
        }
        res.writeHead(200, {
          "Content-Type": "audio/wav",
          "Content-Length": stat.size,
          "Content-Disposition": `attachment; filename="${safeName}"`,
        });
        fs.createReadStream(filePath).pipe(res);
      });
      return;
    }

    if (url.pathname === "/api/scan/update" && req.method === "POST") {
      if (!state.running) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No active scan." }));
        return;
      }
      if (!state.control?.page) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Scan not ready." }));
        return;
      }
      const payload = await readJson(req, res);
      if (!payload) return;

      let updated = false;
      let nextNoiseType = null;
      let nextNoiseVolume = null;
      let nextHopMs = null;
      let nextMaxDurationMs = undefined;

      if (typeof payload.noiseType === "string") {
        const normalized = payload.noiseType.toLowerCase();
        if (normalized === "blue") {
          nextNoiseType = "green";
        } else if (NOISE_TYPES.has(normalized)) {
          nextNoiseType = normalized;
        }
      }

      if (payload.noiseVolume !== null && payload.noiseVolume !== undefined && payload.noiseVolume !== "") {
        const noiseVolume = Number(payload.noiseVolume);
        if (Number.isFinite(noiseVolume)) {
          nextNoiseVolume = Math.max(0, Math.min(100, noiseVolume));
        }
      }

      if (payload.hopMs !== null && payload.hopMs !== undefined && payload.hopMs !== "") {
        const hopMs = Number(payload.hopMs);
        if (Number.isFinite(hopMs) && hopMs > 0) {
          nextHopMs = hopMs;
        }
      }

      if (payload.maxDurationMs === null) {
        nextMaxDurationMs = null;
      } else if (payload.maxDurationMs !== undefined && payload.maxDurationMs !== "") {
        const maxDurationMs = Number(payload.maxDurationMs);
        if (Number.isFinite(maxDurationMs)) {
          nextMaxDurationMs = Math.max(0, maxDurationMs);
        }
      }

      if (nextNoiseType) {
        state.options = { ...(state.options || {}), noiseType: nextNoiseType };
        updated = true;
      }
      if (Number.isFinite(nextNoiseVolume)) {
        state.options = { ...(state.options || {}), noiseVolume: nextNoiseVolume };
        updated = true;
      }
      if (Number.isFinite(nextHopMs)) {
        state.options = { ...(state.options || {}), hopMs: nextHopMs };
        updated = true;
      }
      if (nextMaxDurationMs !== undefined) {
        state.options = { ...(state.options || {}), maxDurationMs: nextMaxDurationMs };
        updated = true;
      }

      if (!updated) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No valid fields to update." }));
        return;
      }

      try {
        await updateNoiseSettings(state.control.page, {
          noiseType: nextNoiseType || state.options?.noiseType,
          noiseVolume: Number.isFinite(nextNoiseVolume) ? nextNoiseVolume : state.options?.noiseVolume,
        });
        if (nextMaxDurationMs !== undefined) {
          setSessionTimer(currentScan.controller, nextMaxDurationMs);
        }
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message || String(err) }));
        return;
      }

      publishStatus();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === "/api/scan/stop" && req.method === "POST") {
      if (!state.running || !currentScan) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No active scan." }));
        return;
      }
      currentScan.controller.abort();
      await stopRecordingInternal();
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.listen(port, () => {
    console.log(`Scanner server listening on http://localhost:${port}`);
  });

  return server;
}

function readJson(req, res) {
  return new Promise(resolve => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body." }));
        resolve(null);
      }
    });
  });
}

if (require.main === module) {
  const port = Number(process.env.SCAN_SERVER_PORT || 8787);
  createScanServer({ port });
}

module.exports = {
  normalizeOptions,
  runScan,
  createScanServer,
};

function createScanEngine({ recordingsDir, onStatus, onTune, onWaveform } = {}) {
  const resolvedRecordingsDir = recordingsDir
    ? path.resolve(recordingsDir)
    : path.join(process.cwd(), "recordings");

  const state = {
    running: false,
    startedAt: null,
    startedAtMs: null,
    options: null,
    lastTune: null,
    lastError: null,
    stopReason: null,
    scanId: 0,
    control: null,
    recording: {
      active: false,
      filePath: null,
      fileName: null,
      writer: null,
      sampleRate: null,
    },
    lastRecordingFile: null,
  };

  let currentScan = null;
  let durationTimer = null;

  const publishStatus = () => {
    if (typeof onStatus !== "function") return;
    onStatus({
      running: state.running,
      startedAt: state.startedAt,
      options: state.options,
      lastTune: state.lastTune,
      lastError: state.lastError,
      stopReason: state.stopReason,
      scanId: state.scanId,
      recording: state.recording.active,
      recordingFile: state.recording.fileName,
      lastRecordingFile: state.lastRecordingFile,
    });
  };

  const clearDurationTimer = () => {
    if (durationTimer) {
      clearTimeout(durationTimer);
      durationTimer = null;
    }
  };

  const setSessionTimer = (controller, maxDurationMs) => {
    clearDurationTimer();
    if (maxDurationMs === null || maxDurationMs === undefined) {
      return;
    }
    if (!Number.isFinite(maxDurationMs)) {
      return;
    }
    if (maxDurationMs <= 0) {
      controller.abort();
      return;
    }
    const startedAtMs = Number.isFinite(state.startedAtMs) ? state.startedAtMs : Date.now();
    const endAt = startedAtMs + maxDurationMs;
    const remaining = endAt - Date.now();
    if (remaining <= 0) {
      controller.abort();
      return;
    }
    durationTimer = setTimeout(() => {
      controller.abort();
    }, remaining);
  };

  const stopRecordingInternal = async () => {
    if (!state.recording.active) return;
    state.recording.active = false;
    if (state.recording.fileName) {
      state.lastRecordingFile = state.recording.fileName;
    }
    try {
      await state.control?.page?.evaluate(() => {
        window.__recordingActive = false;
      });
    } catch {
      // ignore if page already closed
    }
    try {
      state.recording.writer?.finalize();
    } catch {
      // ignore finalize errors
    }
    state.recording.filePath = null;
    state.recording.fileName = null;
    state.recording.writer = null;
    state.recording.sampleRate = null;
  };

  const startRecordingInternal = async (label) => {
    if (!state.running) {
      throw new Error("No active scan.");
    }
    if (!state.control?.page) {
      throw new Error("Scan not ready.");
    }
    if (state.recording.active) {
      throw new Error("Recording already active.");
    }
    fs.mkdirSync(resolvedRecordingsDir, { recursive: true });
    const fileName = createRecordingName(label);
    const filePath = path.join(resolvedRecordingsDir, fileName);
    const sampleRate = await state.control.page.evaluate(() => document.ct?.sampleRate || 44100);
    const writer = new WavWriter(filePath, sampleRate, 1, 16);

    await ensureRecordingBridge(state.control.page, payload => {
      if (!state.recording.active) return;
      if (!payload || !Array.isArray(payload.samples)) return;
      const int16 = floatToInt16(payload.samples);
      state.recording.writer?.writeSamples(int16);
    });

    await state.control.page.evaluate(() => {
      window.__recordingActive = true;
    });

    state.recording.active = true;
    state.recording.filePath = filePath;
    state.recording.fileName = fileName;
    state.recording.writer = writer;
    state.recording.sampleRate = sampleRate;
    state.lastRecordingFile = fileName;
  };

  const getStatus = () => ({
    running: state.running,
    startedAt: state.startedAt,
    options: state.options,
    lastTune: state.lastTune,
    lastError: state.lastError,
    stopReason: state.stopReason,
    scanId: state.scanId,
    recording: state.recording.active,
    recordingFile: state.recording.fileName,
    lastRecordingFile: state.lastRecordingFile,
  });

  const start = async (payload = {}) => {
    if (state.running) {
      throw new Error("Scan already running.");
    }

    const options = normalizeOptions(payload);
    state.running = true;
    state.startedAt = new Date().toISOString();
    state.startedAtMs = Date.now();
    state.options = options;
    state.lastTune = null;
    state.lastError = null;
    state.stopReason = null;
    state.scanId += 1;
    state.control = null;

    const controller = new AbortController();
    currentScan = { controller, id: state.scanId };
    publishStatus();

    setSessionTimer(controller, options.maxDurationMs);

    runScan(
      options,
      {
        onTune: tuneInfo => {
          state.lastTune = {
            ...tuneInfo,
            scanId: state.scanId,
            timestamp: new Date().toISOString(),
          };
          if (typeof onTune === "function") {
            onTune(state.lastTune);
          }
        },
        onWaveform: payload => {
          if (payload && Array.isArray(payload.samples)) {
            const waveform = {
              samples: payload.samples,
              ts: payload.ts || Date.now(),
            };
            if (typeof onWaveform === "function") {
              onWaveform(waveform);
            }
          }
        },
        onReady: ({ page, options: resolvedOptions }) => {
          state.control = { page };
          state.options = resolvedOptions;
          publishStatus();
        },
        getHopMs: () => state.options?.hopMs ?? DEFAULT_HOP_MS,
        getDeadlineMs: () => {
          const maxDurationMs = state.options?.maxDurationMs;
          if (!Number.isFinite(maxDurationMs)) return null;
          const startedAtMs = Number.isFinite(state.startedAtMs) ? state.startedAtMs : Date.now();
          return startedAtMs + maxDurationMs;
        },
      },
      controller.signal
    )
      .then(async () => {
        state.running = false;
        state.stopReason = "completed";
        state.control = null;
        state.startedAtMs = null;
        await stopRecordingInternal();
        clearDurationTimer();
        publishStatus();
      })
      .catch(async err => {
        state.running = false;
        clearDurationTimer();
        state.control = null;
        state.startedAtMs = null;
        await stopRecordingInternal();
        if (isAbortError(err)) {
          state.stopReason = "aborted";
        } else {
          state.lastError = err?.message || String(err);
          state.stopReason = "error";
        }
        publishStatus();
      });

    return { ok: true, scanId: state.scanId };
  };

  const stop = async () => {
    if (!state.running || !currentScan) {
      throw new Error("No active scan.");
    }
    currentScan.controller.abort();
    await stopRecordingInternal();
    return { ok: true };
  };

  const update = async (payload = {}) => {
    if (!state.running) {
      throw new Error("No active scan.");
    }
    if (!state.control?.page) {
      throw new Error("Scan not ready.");
    }

    let updated = false;
    let nextNoiseType = null;
    let nextNoiseVolume = null;
    let nextHopMs = null;
    let nextMaxDurationMs = undefined;

    if (typeof payload.noiseType === "string") {
      const normalized = payload.noiseType.toLowerCase();
      if (normalized === "blue") {
        nextNoiseType = "green";
      } else if (NOISE_TYPES.has(normalized)) {
        nextNoiseType = normalized;
      }
    }

    if (payload.noiseVolume !== null && payload.noiseVolume !== undefined && payload.noiseVolume !== "") {
      const noiseVolume = Number(payload.noiseVolume);
      if (Number.isFinite(noiseVolume)) {
        nextNoiseVolume = Math.max(0, Math.min(100, noiseVolume));
      }
    }

    if (payload.hopMs !== null && payload.hopMs !== undefined && payload.hopMs !== "") {
      const hopMs = Number(payload.hopMs);
      if (Number.isFinite(hopMs) && hopMs > 0) {
        nextHopMs = hopMs;
      }
    }
    if (payload.maxDurationMs === null) {
      nextMaxDurationMs = null;
    } else if (payload.maxDurationMs !== undefined && payload.maxDurationMs !== "") {
      const maxDurationMs = Number(payload.maxDurationMs);
      if (Number.isFinite(maxDurationMs)) {
        nextMaxDurationMs = Math.max(0, maxDurationMs);
      }
    }

    if (nextNoiseType) {
      state.options = { ...(state.options || {}), noiseType: nextNoiseType };
      updated = true;
    }
    if (Number.isFinite(nextNoiseVolume)) {
      state.options = { ...(state.options || {}), noiseVolume: nextNoiseVolume };
      updated = true;
    }
    if (Number.isFinite(nextHopMs)) {
      state.options = { ...(state.options || {}), hopMs: nextHopMs };
      updated = true;
    }
    if (nextMaxDurationMs !== undefined) {
      state.options = { ...(state.options || {}), maxDurationMs: nextMaxDurationMs };
      updated = true;
    }

    if (!updated) {
      throw new Error("No valid fields to update.");
    }

    await updateNoiseSettings(state.control.page, {
      noiseType: nextNoiseType || state.options?.noiseType,
      noiseVolume: Number.isFinite(nextNoiseVolume) ? nextNoiseVolume : state.options?.noiseVolume,
    });

    if (nextMaxDurationMs !== undefined) {
      setSessionTimer(currentScan.controller, nextMaxDurationMs);
    }

    publishStatus();
    return { ok: true };
  };

  const recordStart = async (label) => {
    await startRecordingInternal(label);
    publishStatus();
    return { ok: true, fileName: state.recording.fileName };
  };

  const recordStop = async () => {
    if (!state.recording.active) {
      throw new Error("No active recording.");
    }
    await stopRecordingInternal();
    publishStatus();
    return { ok: true, fileName: state.lastRecordingFile };
  };

  return {
    getStatus,
    start,
    stop,
    update,
    recordStart,
    recordStop,
  };
}

module.exports = {
  normalizeOptions,
  runScan,
  createScanServer,
  createScanEngine,
};

// SPL fix override: keep the main audio path clean and mirror non-electron behavior.
async function startNoiseGenerator(page, noiseType, noiseVolume) {
  const noiseGain = Number.isFinite(noiseVolume) ? Math.max(0, Math.min(1, noiseVolume / 100)) : 1;
  await page.evaluate(
    async ({ noiseType, noiseGain }) => {
      if (!noiseType) return;
      window.__noiseType = noiseType;
      if (Number.isFinite(noiseGain)) {
        window.__noiseGain = noiseGain;
      }
      if (window.__noiseStarted) return;
      window.__noiseStarted = true;
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = window.__noiseContext || new AudioCtx({ latencyHint: "interactive" });
      window.__noiseContext = ctx;
      const bufferSize = 4096;
      const node = ctx.createScriptProcessor(bufferSize, 1, 1);
      let b0 = 0,
        b1 = 0,
        b2 = 0,
        b3 = 0,
        b4 = 0,
        b5 = 0,
        b6 = 0;
      let brown = 0;
      let greenLP = 0;
      let greenBP = 0;
      const gains = {
        pink: 0.02,
        white: 0.02,
        brown: 0.02,
        green: 0.02,
      };
      node.onaudioprocess = e => {
        const output = e.outputBuffer.getChannelData(0);
        const currentType = window.__noiseType || noiseType;
        const gainScale = Number.isFinite(window.__noiseGain) ? window.__noiseGain : 1;
        for (let i = 0; i < bufferSize; i++) {
          const white = Math.random() * 2 - 1;
          let sample = white;
          switch (currentType) {
            case "pink": {
              b0 = 0.99886 * b0 + white * 0.0555179;
              b1 = 0.99332 * b1 + white * 0.0750759;
              b2 = 0.969 * b2 + white * 0.153852;
              b3 = 0.8665 * b3 + white * 0.3104856;
              b4 = 0.55 * b4 + white * 0.5329522;
              b5 = -0.7616 * b5 - white * 0.016898;
              const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
              b6 = white * 0.115926;
              sample = pink;
              break;
            }
            case "brown": {
              brown = (brown + white) * 0.996;
              sample = Math.max(Math.min(brown, 1), -1);
              break;
            }
            case "green": {
              greenLP += 0.02 * (white - greenLP);
              const high = white - greenLP;
              greenBP += 0.02 * (high - greenBP);
              sample = greenBP;
              break;
            }
            case "white":
            default:
              sample = white;
              break;
          }
          const gain = (gains[currentType] ?? 0.02) * gainScale;
          output[i] = sample * gain;
        }
      };
      node.connect(ctx.destination);
      try {
        await ctx.resume();
      } catch {
        // ignore if autoplay policy blocks resume
      }
      window.__noiseNode = node;
    },
    { noiseType, noiseGain }
  );
}

async function installSdrGainChain(page) {
  await page.evaluate(
    ({ duckDb }) => {
      if (!window.soundapplet?.p || !document.ct) return;
      const ctx = document.ct;
      const source = window.soundapplet.p;

      let gainNode = window.__sdrGainNode;
      let compressor = window.__sdrCompressor;

      if (!gainNode || !compressor) {
        compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = -28;
        compressor.knee.value = 18;
        compressor.ratio.value = 12;
        compressor.attack.value = 0.003;
        compressor.release.value = 0.25;

        gainNode = ctx.createGain();
        gainNode.gain.value = 1.0;

        try {
          source.disconnect();
        } catch {
          // ignore if not connected yet
        }

        source.connect(compressor);
        compressor.connect(gainNode);
        gainNode.connect(ctx.destination);

        window.__sdrGainNode = gainNode;
        window.__sdrCompressor = compressor;
        window.__sdrBaseGain = 1.0;
        window.__sdrDuckGain = Math.pow(10, duckDb / 20);
      }

      let analyser = window.__sdrAnalyzer;
      if (!analyser) {
        analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        window.__sdrAnalyzer = analyser;
      }

      let recorder = window.__sdrRecorder;
      if (!recorder) {
        const bufferSize = 4096;
        recorder = ctx.createScriptProcessor(bufferSize, 1, 1);
        recorder.onaudioprocess = e => {
          const input = e.inputBuffer.getChannelData(0);
          const output = e.outputBuffer.getChannelData(0);
          output.fill(0);
          if (window.__recordingActive && window.__recordingEmit) {
            window.__recordingEmit({
              samples: Array.from(input),
              sampleRate: ctx.sampleRate,
            });
          }
        };
        window.__sdrRecorder = recorder;
      }

      let silentGain = window.__sdrSilentGain;
      if (!silentGain) {
        silentGain = ctx.createGain();
        silentGain.gain.value = 0;
        window.__sdrSilentGain = silentGain;
      }

      if (!window.__sdrMonitorReady) {
        try {
          analyser.disconnect();
        } catch {
          // ignore if not connected yet
        }
        try {
          recorder.disconnect();
        } catch {
          // ignore if not connected yet
        }
        try {
          silentGain.disconnect();
        } catch {
          // ignore if not connected yet
        }
        gainNode.connect(analyser);
        analyser.connect(recorder);
        recorder.connect(silentGain);
        silentGain.connect(ctx.destination);
        window.__sdrMonitorReady = true;
      }
    },
    { duckDb: DUCK_DB }
  );
}
