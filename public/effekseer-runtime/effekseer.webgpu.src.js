const effekseer = (() => {
  let Module = {};
  let Core = {};
  let loadingEffect = null;
  let runtimeInitialized = false;
  let runtimeInitializing = false;
  let preinitializedDevice = null;
  let externalWebGPUDevice = null;
  let imageCrossOrigin = "";
  let contextId = 0;
  let onRuntimeReadyQueue = [];

  const LOG_ENABLED = false;
  const debugLog = (...args) => { if (LOG_ENABLED) console.log(...args); };
  const debugWarn = (...args) => { console.warn(...args); };
  const debugInfo = (...args) => { if (LOG_ENABLED) console.info(...args); };
  const debugError = (...args) => { console.error(...args); };
  const resourceTrace = (...args) => {
    if (globalThis.__EFFEKSEER_RESOURCE_TRACE__ === true) {
      console.log(...args);
    }
  };

  const toArrayBuffer = (data) => {
    if (data instanceof ArrayBuffer) {
      return data;
    }
    if (ArrayBuffer.isView(data)) {
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    }
    return null;
  };

  const normalizePackagePath = (value) => {
    if (typeof value !== "string" || value.length === 0) {
      return "";
    }

    const parts = value.replace(/\\/g, "/").split("/");
    const normalizedParts = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part || part === ".") {
        continue;
      }
      if (part === "..") {
        if (normalizedParts.length > 0) {
          normalizedParts.pop();
        }
        continue;
      }
      normalizedParts.push(part);
    }

    let normalized = normalizedParts.join("/");
    while (normalized.startsWith("/")) {
      normalized = normalized.slice(1);
    }
    return normalized.replace(/[A-Z]/g, (c) => c.toLowerCase());
  };

  const EFWGPK_MAGIC = "EFWGPKG1";
  const EFWGPK_HEADER_SIZE = 64;
  const EFWGPK_ENTRY_DEFLATE = 1 << 0;
  const EFWGPK_META_MAIN = "__efwgpk__/main_effect_path.txt";
  const EFWGPK_RESOURCE_SCHEME = "efwgpk://";
  let efwgpkPackageId = 0;

  const stripUrlDecorations = (value) => {
    return String(value || "").replace(/\\/g, "/").split("?")[0].split("#")[0];
  };

  const isEfkWgpuContainerPath = (value) => {
    return false;
  };

  const isEfkWgPath = (value) => {
    if (typeof value !== "string" || value.length === 0) {
      return false;
    }
    const normalized = value.replace(/\\/g, "/").split("?")[0].split("#")[0].toLowerCase();
    return normalized.endsWith(".efkwg");
  };

  const isEfwgpkPath = (value) => {
    if (typeof value !== "string" || value.length === 0) {
      return false;
    }
    const normalized = stripUrlDecorations(value).toLowerCase();
    return normalized.endsWith(".efkwgpk");
  };

  const readMagic8 = (buffer) => {
    const ab = toArrayBuffer(buffer);
    if (!ab || ab.byteLength < 8) {
      return "";
    }
    const view = new Uint8Array(ab, 0, 8);
    return String.fromCharCode(...view);
  };

  const buildEfwgpkEntryMap = (buffer) => {
    const map = new Map();
    const totalSize = buffer ? buffer.byteLength : 0;
    if (!buffer || totalSize < EFWGPK_HEADER_SIZE) {
      return map;
    }

    const view = new DataView(buffer);
    if (readMagic8(buffer) !== EFWGPK_MAGIC) {
      return map;
    }

    const headerSize = view.getUint32(8, true);
    const entryCount = view.getUint32(20, true);
    const entryStride = view.getUint32(24, true);
    const entriesOffset = view.getUint32(28, true);
    const stringPoolOffset = view.getUint32(32, true);
    const stringPoolSize = view.getUint32(36, true);
    const payloadOffset = view.getUint32(40, true);
    const payloadSize = view.getUint32(44, true);

    if (headerSize !== EFWGPK_HEADER_SIZE || entryStride < 32) {
      return map;
    }

    const entryTableSizeBig = BigInt(entryCount) * BigInt(entryStride);
    if (entryTableSizeBig > BigInt(totalSize)) {
      return map;
    }
    const entryTableSize = Number(entryTableSizeBig);
    if (!isValidBufferSpan(entriesOffset, entryTableSize, totalSize)) {
      return map;
    }
    if (!isValidBufferSpan(stringPoolOffset, stringPoolSize, totalSize)) {
      return map;
    }
    if (!isValidBufferSpan(payloadOffset, payloadSize, totalSize)) {
      return map;
    }

    const stringPoolEnd = stringPoolOffset + stringPoolSize;
    const payloadEnd = payloadOffset + payloadSize;
    const decoder = new TextDecoder("utf-8");
    for (let i = 0; i < entryCount; i++) {
      const base = entriesOffset + i * entryStride;
      const pathOffset = view.getUint32(base + 8, true);
      const pathLength = view.getUint32(base + 12, true);
      const flags = view.getUint32(base + 16, true);
      const entryPayloadOffset = view.getUint32(base + 20, true);
      const packedSize = view.getUint32(base + 24, true);
      const rawSize = view.getUint32(base + 28, true);

      if (!isValidBufferSpan(pathOffset, pathLength, totalSize)) {
        continue;
      }
      if (pathOffset < stringPoolOffset || (pathOffset + pathLength) > stringPoolEnd) {
        continue;
      }
      if (!isValidBufferSpan(entryPayloadOffset, packedSize, totalSize)) {
        continue;
      }
      if (entryPayloadOffset < payloadOffset || (entryPayloadOffset + packedSize) > payloadEnd) {
        continue;
      }

      let path = "";
      try {
        path = decoder.decode(new Uint8Array(buffer, pathOffset, pathLength));
      } catch {
        continue;
      }

      const normalizedPath = normalizePackagePath(path);
      if (!normalizedPath) {
        continue;
      }

      const entry = {
        index: i,
        path,
        normalizedPath,
        flags,
        payloadOffset: entryPayloadOffset,
        packedSize,
        rawSize
      };
      const bucket = map.get(normalizedPath);
      if (bucket) {
        bucket.push(entry);
      } else {
        map.set(normalizedPath, [entry]);
      }
    }

    return map;
  };

  const inflateEfwgpkPayload = async (packedBytes, rawSize) => {
    const fflateApi = globalThis.fflate;
    if (fflateApi && typeof fflateApi.unzlibSync === "function") {
      const inflatedBytes = fflateApi.unzlibSync(new Uint8Array(packedBytes));
      const inflated = toArrayBuffer(inflatedBytes);
      if (rawSize > 0 && inflated.byteLength !== rawSize) {
        debugWarn("efwgpk inflated size mismatch", { expected: rawSize, actual: inflated.byteLength });
      }
      return inflated;
    }

    if (typeof DecompressionStream !== "function") {
      throw new Error("No zlib inflate backend available for efkwgpk payload");
    }

    const stream = new DecompressionStream("deflate");
    const writer = stream.writable.getWriter();
    await writer.write(packedBytes);
    await writer.close();
    const inflated = await new Response(stream.readable).arrayBuffer();
    if (rawSize > 0 && inflated.byteLength !== rawSize) {
      debugWarn("efwgpk inflated size mismatch", { expected: rawSize, actual: inflated.byteLength });
    }
    return inflated;
  };

  const getEfwgpkEntryBytes = async (buffer, entryMap, path) => {
    const normalizedPath = normalizePackagePath(path);
    if (!normalizedPath || !buffer || !entryMap || entryMap.size === 0) {
      return null;
    }

    const bucket = entryMap.get(normalizedPath);
    if (!bucket || bucket.length === 0) {
      return null;
    }

    for (let i = 0; i < bucket.length; i++) {
      const entry = bucket[i];
      if (!isValidBufferSpan(entry.payloadOffset, entry.packedSize, buffer.byteLength)) {
        continue;
      }
      if (entry.flags === 0 && entry.packedSize === entry.rawSize) {
        return buffer.slice(entry.payloadOffset, entry.payloadOffset + entry.packedSize);
      }
      if (entry.flags === EFWGPK_ENTRY_DEFLATE) {
        const packedBytes = new Uint8Array(buffer, entry.payloadOffset, entry.packedSize);
        return await inflateEfwgpkPayload(packedBytes, entry.rawSize);
      }
    }

    return null;
  };

  const getEfwgpkEntryPayloadKey = (entry) => {
    if (!entry || !Number.isFinite(entry.payloadOffset) || !Number.isFinite(entry.packedSize) || !Number.isFinite(entry.rawSize) || !Number.isFinite(entry.flags)) {
      return "";
    }
    return `${entry.flags}:${entry.payloadOffset}:${entry.packedSize}:${entry.rawSize}`;
  };

  const getEfwgpkCanonicalEntry = (buffer, entryMap, path) => {
    const normalizedPath = normalizePackagePath(path);
    if (!normalizedPath || !buffer || !entryMap || entryMap.size === 0) {
      return null;
    }

    const bucket = entryMap.get(normalizedPath);
    if (!bucket || bucket.length === 0) {
      return null;
    }

    for (let i = 0; i < bucket.length; i++) {
      const entry = bucket[i];
      if (!isValidBufferSpan(entry.payloadOffset, entry.packedSize, buffer.byteLength)) {
        continue;
      }
      if (entry.flags === 0 && entry.packedSize === entry.rawSize) {
        return entry;
      }
      if (entry.flags === EFWGPK_ENTRY_DEFLATE) {
        return entry;
      }
    }

    return null;
  };

  const getEfwgpkMainEffectPath = async (buffer, entryMap) => {
    const metaBytes = await getEfwgpkEntryBytes(buffer, entryMap, EFWGPK_META_MAIN);
    if (metaBytes) {
      try {
        const decoded = new TextDecoder("utf-8").decode(new Uint8Array(metaBytes)).replace(/\0+$/, "");
        const normalized = normalizePackagePath(decoded);
        if (normalized) {
          return normalized;
        }
      } catch {
        // ignore malformed metadata
      }
    }

    for (const [normalizedPath, bucket] of entryMap.entries()) {
      if (!normalizedPath.endsWith(".efkwg")) {
        continue;
      }
      if (bucket && bucket.length > 0) {
        return normalizedPath;
      }
    }

    return "";
  };

  const isValidBufferSpan = (offset, size, totalSize) => {
    if (!Number.isFinite(offset) || !Number.isFinite(size) || !Number.isFinite(totalSize)) {
      return false;
    }
    if (offset < 0 || size < 0 || totalSize < 0) {
      return false;
    }
    if (offset > totalSize) {
      return false;
    }
    return size <= (totalSize - offset);
  };

  const requestPreinitializedDevice = async () => {
    if (externalWebGPUDevice) {
      return externalWebGPUDevice;
    }
    if (!navigator.gpu) {
      throw new Error("WebGPU is not available in this browser.");
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error("Failed to acquire a WebGPU adapter.");
    }
    const requiredFeatures = [];
    if (adapter.features && adapter.features.has("float32-filterable")) {
      requiredFeatures.push("float32-filterable");
    }
    const hasTimestampOps =
      (typeof GPUCommandEncoder !== "undefined") &&
      GPUCommandEncoder.prototype &&
      (typeof GPUCommandEncoder.prototype.writeTimestamp === "function") &&
      (typeof GPUCommandEncoder.prototype.resolveQuerySet === "function");
    if (hasTimestampOps && adapter.features && adapter.features.has("timestamp-query")) {
      requiredFeatures.push("timestamp-query");
    }
    return await adapter.requestDevice(requiredFeatures.length > 0 ? { requiredFeatures } : undefined);
  };

  const loadBinary = (url, onload, onerror) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    xhr.responseType = "arraybuffer";
    xhr.onload = () => {
      const status = xhr.status | 0;
      if ((status >= 200 && status < 300) || status === 0) {
        onload(xhr.response);
      } else if (onerror) {
        onerror("not found", url);
      }
    };
    xhr.onerror = () => {
      if (onerror) {
        onerror("not found", url);
      }
    };
    xhr.send(null);
  };

  const loadBinarySync = (url) => {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, false);
      xhr.responseType = "arraybuffer";
      xhr.send(null);
      const status = xhr.status | 0;
      if ((status >= 200 && status < 300) || status === 0) {
        return xhr.response;
      }
      debugError("[EffekseerWebGPU] loadBinarySync failed", {
        url,
        status,
        statusText: xhr.statusText || "",
        responseURL: xhr.responseURL || "",
      });
    } catch {
      debugError("[EffekseerWebGPU] loadBinarySync threw", { url });
    }
    return null;
  };

  const deferCallback = (callback) => {
    if (typeof callback !== "function") {
      return;
    }
    if (typeof queueMicrotask === "function") {
      queueMicrotask(callback);
    } else {
      Promise.resolve().then(callback);
    }
  };

  const normalizeEffectSourcePath = (value) => String(value || "").replace(/\\/g, "/");

  const buildEffectCacheKey = (path, scale) => {
    const normalizedPath = normalizeEffectSourcePath(path);
    const numericScale = Number(scale);
    const normalizedScale = Number.isFinite(numericScale) ? numericScale : 1.0;
    return `${normalizedPath}::${normalizedScale}`;
  };

  const clearCachedEffectReference = (effect) => {
    if (!effect || !effect.context || !effect._cacheKey || !effect.context._effectCache) {
      return;
    }
    if (effect.context._effectCache.get(effect._cacheKey) === effect) {
      effect.context._effectCache.delete(effect._cacheKey);
    }
  };

  const clearOwnedResourceAliases = (aliases) => {
    if (!aliases || !Module.resourcesMap) {
      return;
    }
    for (let i = 0; i < aliases.length; i++) {
      const alias = aliases[i];
      if (typeof alias !== "string" || alias.length === 0) {
        continue;
      }
      delete Module.resourcesMap[alias];
    }
  };

  const createManagedEffectSnapshot = (state) => {
    if (!state) {
      return null;
    }
    return {
      id: state.id,
      path: state.path,
      scale: state.scale,
      enabled: state.enabled,
      status: state.status,
      effect: state.status === "loaded" ? state.effect : null,
      errorMessage: state.errorMessage,
      errorPath: state.errorPath,
      loadPromise: state.loadPromise,
      activeHandles: new Set(state.activeHandles),
      ownedResourceAliases: state.ownedResourceAliases.slice(),
    };
  };

  const registerEffectCallbacks = (effect, onload, onerror) => {
    if (!effect) {
      return;
    }

    if (typeof onload === "function") {
      if (effect.isLoaded) {
        deferCallback(() => onload());
      } else if (!effect._loadFailed) {
        effect._onloadListeners.push(onload);
      }
    }

    if (typeof onerror === "function") {
      if (effect._loadFailed) {
        const errorMessage = effect._loadErrorMessage || "failed to load effect";
        const errorPath = effect._loadErrorPath || "";
        deferCallback(() => onerror(errorMessage, errorPath));
      } else if (!effect.isLoaded) {
        effect._onerrorListeners.push(onerror);
      }
    }
  };

  const dispatchEffectLoaded = (effect) => {
    if (!effect) {
      return;
    }

    const listeners = effect._onloadListeners.slice();
    effect._onloadListeners.length = 0;
    effect._onerrorListeners.length = 0;
    for (let i = 0; i < listeners.length; i++) {
      const listener = listeners[i];
      deferCallback(() => listener());
    }
  };

  const dispatchEffectError = (effect, message, path = "") => {
    if (!effect || effect._loadFailed) {
      return;
    }

    effect._loadFailed = true;
    effect._loadErrorMessage = String(message || "failed to load effect");
    effect._loadErrorPath = String(path || "");
    clearCachedEffectReference(effect);

    const listeners = effect._onerrorListeners.slice();
    effect._onloadListeners.length = 0;
    effect._onerrorListeners.length = 0;
    for (let i = 0; i < listeners.length; i++) {
      const listener = listeners[i];
      deferCallback(() => listener(effect._loadErrorMessage, effect._loadErrorPath));
    }
  };

  let loadResource = (path, onload, onerror) => {
    loadBinary(path, onload, onerror);
  };

  // Reusable WASM scratch for matrix uploads.
  // Avoids per-call malloc/free in hot paths (setMatrix / setProjectionMatrix / setCameraMatrix).
  const floatArrayScratch = {
    ptr: 0,
    capacity: 0,
  };

  const ensureFloatArrayScratch = (requiredCount) => {
    if (requiredCount <= floatArrayScratch.capacity && floatArrayScratch.ptr !== 0) {
      return floatArrayScratch.ptr;
    }

    if (floatArrayScratch.ptr !== 0) {
      Module._free(floatArrayScratch.ptr);
      floatArrayScratch.ptr = 0;
      floatArrayScratch.capacity = 0;
    }

    floatArrayScratch.ptr = Module._malloc(requiredCount * 4);
    floatArrayScratch.capacity = requiredCount;
    return floatArrayScratch.ptr;
  };

  const withFloatArray = (arrayLike, callback) => {
    const arr = (arrayLike instanceof Float32Array) ? arrayLike : new Float32Array(arrayLike);
    if (arr.length <= 0) {
      callback(0);
      return;
    }

    const ptr = ensureFloatArrayScratch(arr.length);
    Module.HEAPF32.set(arr, ptr >> 2);
    callback(ptr);
  };

  const WGPUTextureFormatValues = Object.freeze({
    "rgba8unorm": 0x16,
    "rgba8unorm-srgb": 0x17,
    "bgra8unorm": 0x1B,
    "bgra8unorm-srgb": 0x1C,
    "rgba16float": 0x28,
    "depth24plus": 0x2E,
    "depth24plus-stencil8": 0x2F,
    "depth32float": 0x30
  });
  const WGPUTextureFormatNames = Object.freeze(
    Object.fromEntries(Object.entries(WGPUTextureFormatValues).map(([k, v]) => [v, k]))
  );

  const toTextureFormatValue = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value | 0;
    }
    if (typeof value !== "string") {
      return null;
    }
    const key = value.trim().toLowerCase();
    if (!key) {
      return null;
    }
    return Object.prototype.hasOwnProperty.call(WGPUTextureFormatValues, key)
      ? WGPUTextureFormatValues[key]
      : null;
  };

  const toTextureFormatName = (value) => {
    if (typeof value === "string") {
      const key = value.trim().toLowerCase();
      if (!key) {
        return null;
      }
      return Object.prototype.hasOwnProperty.call(WGPUTextureFormatValues, key) ? key : null;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return WGPUTextureFormatNames[value | 0] || null;
    }
    return null;
  };

  const toSampleCountValue = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) {
      return 1;
    }
    return Math.max(1, Math.floor(n));
  };

  const setRendererLinearWorkingColorSpace = (colorSpaceApiLike = null) => {
    const colorSpaceApi = colorSpaceApiLike;
    if (!colorSpaceApi || !colorSpaceApi.ColorManagement) {
      return false;
    }
    if (!("workingColorSpace" in colorSpaceApi.ColorManagement)) {
      return false;
    }
    // Keep renderer color management in linear working space for stable blending/math.
    if (typeof colorSpaceApi.LinearSRGBColorSpace !== "undefined") {
      colorSpaceApi.ColorManagement.workingColorSpace = colorSpaceApi.LinearSRGBColorSpace;
      return true;
    }
    return false;
  };

  const initCoreBindings = () => {
    Core = {
      InitInternal: Module.cwrap("EffekseerInitInternal", "number", ["number", "number", "string", "number", "number"]),
      InitExternal: Module.cwrap("EffekseerInitExternal", "number", ["number", "number", "number", "number"]),
      Init: Module.cwrap("EffekseerInit", "number", ["number", "number", "string", "number", "number", "number"]),
      Terminate: Module.cwrap("EffekseerTerminate", "void", ["number"]),
      Update: Module.cwrap("EffekseerUpdate", "void", ["number", "number"]),
      BeginUpdate: Module.cwrap("EffekseerBeginUpdate", "void", ["number"]),
      EndUpdate: Module.cwrap("EffekseerEndUpdate", "void", ["number"]),
      UpdateHandle: Module.cwrap("EffekseerUpdateHandle", "void", ["number", "number", "number"]),
      Draw: Module.cwrap("EffekseerDraw", "void", ["number"]),
      DrawExternal: Module.cwrap("EffekseerDrawExternal", "void", ["number"]),
      BeginDraw: Module.cwrap("EffekseerBeginDraw", "void", ["number"]),
      EndDraw: Module.cwrap("EffekseerEndDraw", "void", ["number"]),
      DrawHandle: Module.cwrap("EffekseerDrawHandle", "void", ["number", "number"]),
      SetProjectionMatrix: Module.cwrap("EffekseerSetProjectionMatrix", "void", ["number", "number"]),
      SetProjectionPerspective: Module.cwrap("EffekseerSetProjectionPerspective", "void", ["number", "number", "number", "number", "number"]),
      SetProjectionOrthographic: Module.cwrap("EffekseerSetProjectionOrthographic", "void", ["number", "number", "number", "number", "number"]),
      SetCameraMatrix: Module.cwrap("EffekseerSetCameraMatrix", "void", ["number", "number"]),
      SetCameraLookAt: Module.cwrap("EffekseerSetCameraLookAt", "void", ["number", "number", "number", "number", "number", "number", "number", "number", "number", "number"]),
      LoadEffect: Module.cwrap("EffekseerLoadEffect", "number", ["number", "number", "number", "number"]),
      ReleaseEffect: Module.cwrap("EffekseerReleaseEffect", "void", ["number", "number"]),
      ReloadResources: Module.cwrap("EffekseerReloadResources", "void", ["number", "number", "number", "number"]),
      StopAllEffects: Module.cwrap("EffekseerStopAllEffects", "void", ["number"]),
      PlayEffect: Module.cwrap("EffekseerPlayEffect", "number", ["number", "number", "number", "number", "number"]),
      StopEffect: Module.cwrap("EffekseerStopEffect", "void", ["number", "number"]),
      StopRoot: Module.cwrap("EffekseerStopRoot", "void", ["number", "number"]),
      Exists: Module.cwrap("EffekseerExists", "number", ["number", "number"]),
      SetFrame: Module.cwrap("EffekseerSetFrame", "void", ["number", "number", "number"]),
      SetLocation: Module.cwrap("EffekseerSetLocation", "void", ["number", "number", "number", "number", "number"]),
      SetRotation: Module.cwrap("EffekseerSetRotation", "void", ["number", "number", "number", "number", "number"]),
      SetScale: Module.cwrap("EffekseerSetScale", "void", ["number", "number", "number", "number", "number"]),
      SetMatrix: Module.cwrap("EffekseerSetMatrix", "void", ["number", "number", "number"]),
      SetAllColor: Module.cwrap("EffekseerSetAllColor", "void", ["number", "number", "number", "number", "number", "number"]),
      SetTargetLocation: Module.cwrap("EffekseerSetTargetLocation", "void", ["number", "number", "number", "number", "number"]),
      GetDynamicInput: Module.cwrap("EffekseerGetDynamicInput", "number", ["number", "number", "number"]),
      SetDynamicInput: Module.cwrap("EffekseerSetDynamicInput", "void", ["number", "number", "number", "number"]),
      SendTrigger: Module.cwrap("EffekseerSendTrigger", "void", ["number", "number", "number"]),
      SetPaused: Module.cwrap("EffekseerSetPaused", "void", ["number", "number", "number"]),
      SetShown: Module.cwrap("EffekseerSetShown", "void", ["number", "number", "number"]),
      SetSpeed: Module.cwrap("EffekseerSetSpeed", "void", ["number", "number", "number"]),
      SetRandomSeed: Module.cwrap("EffekseerSetRandomSeed", "void", ["number", "number", "number"]),
      SetCompositeMode: Module.cwrap("EffekseerSetCompositeMode", "void", ["number", "number"]),
      GetRestInstancesCount: Module.cwrap("EffekseerGetRestInstancesCount", "number", ["number"]),
      GetUpdateTime: Module.cwrap("EffekseerGetUpdateTime", "number", ["number"]),
      GetDrawTime: Module.cwrap("EffekseerGetDrawTime", "number", ["number"]),
      GetDrawFlushComputeTime: Module.cwrap("EffekseerGetDrawFlushComputeTime", "number", ["number"]),
      GetDrawBeginFrameTime: Module.cwrap("EffekseerGetDrawBeginFrameTime", "number", ["number"]),
      GetDrawManagerTime: Module.cwrap("EffekseerGetDrawManagerTime", "number", ["number"]),
      GetDrawEndFrameTime: Module.cwrap("EffekseerGetDrawEndFrameTime", "number", ["number"]),
      GetDrawTotalTime: Module.cwrap("EffekseerGetDrawTotalTime", "number", ["number"]),
      GetGpuTimestampSupported: Module.cwrap("EffekseerGetGpuTimestampSupported", "number", ["number"]),
      GetGpuTimestampValid: Module.cwrap("EffekseerGetGpuTimestampValid", "number", ["number"]),
      GetGpuTimestampEffekseerPassTime: Module.cwrap("EffekseerGetGpuTimestampEffekseerPassTime", "number", ["number"]),
      GetGpuTimestampFrameTime: Module.cwrap("EffekseerGetGpuTimestampFrameTime", "number", ["number"]),
      GetGpuTimestampReadPending: Module.cwrap("EffekseerGetGpuTimestampReadPending", "number", ["number"]),
      GetGpuTimestampLastMapStatus: Module.cwrap("EffekseerGetGpuTimestampLastMapStatus", "number", ["number"]),
      GetGpuTimestampMapState: Module.cwrap("EffekseerGetGpuTimestampMapState", "number", ["number"]),
      GetGpuTimestampMapMode: Module.cwrap("EffekseerGetGpuTimestampMapMode", "number", ["number"]),
      GetGpuTimestampStallRecoveries: Module.cwrap("EffekseerGetGpuTimestampStallRecoveries", "number", ["number"]),
      GetRendererProfileBindGroupTime: Module.cwrap("EffekseerGetRendererProfileBindGroupTime", "number", ["number"]),
      GetRendererProfileBindGroupCacheFlushCount: Module.cwrap("EffekseerGetRendererProfileBindGroupCacheFlushCount", "number", ["number"]),
      GetRendererProfileBindGroupCacheHits: Module.cwrap("EffekseerGetRendererProfileBindGroupCacheHits", "number", ["number"]),
      GetRendererProfileBindGroupCacheMisses: Module.cwrap("EffekseerGetRendererProfileBindGroupCacheMisses", "number", ["number"]),
      GetRendererProfileBindGroupCreates: Module.cwrap("EffekseerGetRendererProfileBindGroupCreates", "number", ["number"]),
      GetRendererProfilePipelineTime: Module.cwrap("EffekseerGetRendererProfilePipelineTime", "number", ["number"]),
      GetRendererProfileSetStateTime: Module.cwrap("EffekseerGetRendererProfileSetStateTime", "number", ["number"]),
      GetRendererProfileIssueDrawTime: Module.cwrap("EffekseerGetRendererProfileIssueDrawTime", "number", ["number"]),
      GetRendererProfileDrawTotalTime: Module.cwrap("EffekseerGetRendererProfileDrawTotalTime", "number", ["number"]),
      GetRendererProfileDrawSpritesCalls: Module.cwrap("EffekseerGetRendererProfileDrawSpritesCalls", "number", ["number"]),
      GetRendererProfileDrawPolygonCalls: Module.cwrap("EffekseerGetRendererProfileDrawPolygonCalls", "number", ["number"]),
      GetInternalStandardRendererTextureSetupTime: Module.cwrap("EffekseerGetInternalStandardRendererTextureSetupTime", "number", ["number"]),
      GetInternalStandardRendererShaderSelectTime: Module.cwrap("EffekseerGetInternalStandardRendererShaderSelectTime", "number", ["number"]),
      GetInternalStandardRendererVertexPackTime: Module.cwrap("EffekseerGetInternalStandardRendererVertexPackTime", "number", ["number"]),
      GetInternalStandardRendererPixelPackTime: Module.cwrap("EffekseerGetInternalStandardRendererPixelPackTime", "number", ["number"]),
      GetInternalStandardRendererConstantUploadTime: Module.cwrap("EffekseerGetInternalStandardRendererConstantUploadTime", "number", ["number"]),
      GetInternalStandardRendererRenderStateTime: Module.cwrap("EffekseerGetInternalStandardRendererRenderStateTime", "number", ["number"]),
      GetInternalStandardRendererVertexBindTime: Module.cwrap("EffekseerGetInternalStandardRendererVertexBindTime", "number", ["number"]),
      GetInternalStandardRendererIndexBindTime: Module.cwrap("EffekseerGetInternalStandardRendererIndexBindTime", "number", ["number"]),
      GetInternalStandardRendererLayoutTime: Module.cwrap("EffekseerGetInternalStandardRendererLayoutTime", "number", ["number"]),
      GetInternalStandardRendererDrawTime: Module.cwrap("EffekseerGetInternalStandardRendererDrawTime", "number", ["number"]),
      GetManagerProfileFrustumTime: Module.cwrap("EffekseerGetManagerProfileFrustumTime", "number", ["number"]),
      GetManagerProfileSortTime: Module.cwrap("EffekseerGetManagerProfileSortTime", "number", ["number"]),
      GetManagerProfileCanDrawTime: Module.cwrap("EffekseerGetManagerProfileCanDrawTime", "number", ["number"]),
      GetManagerProfileContainerDrawTime: Module.cwrap("EffekseerGetManagerProfileContainerDrawTime", "number", ["number"]),
      GetManagerProfileGpuParticleTime: Module.cwrap("EffekseerGetManagerProfileGpuParticleTime", "number", ["number"]),
      GetManagerProfileDrawSetCount: Module.cwrap("EffekseerGetManagerProfileDrawSetCount", "number", ["number"]),
      GetManagerProfileVisibleDrawSetCount: Module.cwrap("EffekseerGetManagerProfileVisibleDrawSetCount", "number", ["number"]),
      GetManagerProfileContainersTotal: Module.cwrap("EffekseerGetManagerProfileContainersTotal", "number", ["number"]),
      GetManagerProfileContainersDrawn: Module.cwrap("EffekseerGetManagerProfileContainersDrawn", "number", ["number"]),
      GetManagerProfileContainersDepthCulled: Module.cwrap("EffekseerGetManagerProfileContainersDepthCulled", "number", ["number"]),
      GetDrawCallCount: Module.cwrap("EffekseerGetDrawCallCount", "number", ["number"]),
      GetDrawVertexCount: Module.cwrap("EffekseerGetDrawVertexCount", "number", ["number"]),
      GetTotalParticleCount: Module.cwrap("EffekseerGetTotalParticleCount", "number", ["number"]),
      DrawExternalBack: Module.cwrap("EffekseerDrawExternalBack", "void", ["number"]),
      DrawExternalFront: Module.cwrap("EffekseerDrawExternalFront", "void", ["number"]),
      IsVertexArrayObjectSupported: Module.cwrap("EffekseerIsVertexArrayObjectSupported", "number", ["number"]),
      SetRestorationOfStatesFlag: Module.cwrap("EffekseerSetRestorationOfStatesFlag", "void", ["number", "number"]),
      CaptureBackground: Module.cwrap("EffekseerCaptureBackground", "void", ["number", "number", "number", "number", "number"]),
      ResetBackground: Module.cwrap("EffekseerResetBackground", "void", ["number"]),
      SetLogEnabled: Module.cwrap("EffekseerSetLogEnabled", "void", ["number"]),
      SetDepthTexture: Module.cwrap("EffekseerSetDepthTexture", "void", ["number", "number"]),
      SetBackgroundTexture: Module.cwrap("EffekseerSetBackgroundTexture", "void", ["number", "number"]),
    };

    Module.resourcesMap = {};

    Module._loadBinary = (path, isRequired) => {
      const effect = loadingEffect;
      if (!effect) {
        return null;
      }

      let res = effect.resources.find((r) => r.path === path);
      if (res) {
        if (effect.packageOnly) {
          res.isRequired = true;
        }
        return res.isLoaded ? res.buffer : null;
      }

      res = {
        path,
        isLoaded: false,
        buffer: null,
        // In efkwgpk mode all declared resources must resolve from package aliases.
        isRequired: effect.packageOnly ? true : !!isRequired
      };
      effect.resources.push(res);

      const normalizePath = (value) => String(value || "").replace(/\\/g, "/");
      const buildCandidates = (value) => {
        const normalized = normalizePath(value);
        const out = [];
        const seen = new Set();
        const add = (v) => {
          if (!v || seen.has(v)) {
            return;
          }
          seen.add(v);
          out.push(v);
        };
        const addFolderHints = (v) => {
          if (!v || v.includes("/")) {
            return;
          }
          const lower = v.toLowerCase();
          if (lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".dds")) {
            add(`Texture/${v}`);
          }
          if (lower.endsWith(".efkmodel") || lower.endsWith(".mqo")) {
            add(`Model/${v}`);
          }
        };

        // When Effekseer reports resource paths like:
        //   "<main_effect>.efkefc/Texture/foo.png"
        // prioritize the path without the first segment so file-mode-relative
        // resources resolve from baseDir (e.g. "Texture/foo.png").
        const firstSlash = normalized.indexOf("/");
        if (firstSlash > 0) {
          const head = normalized.slice(0, firstSlash).toLowerCase();
          if (head.endsWith(".efk") || head.endsWith(".efkefc") || head.endsWith(".efkproj")) {
            add(normalized.slice(firstSlash + 1));
          }
        }

        add(normalized);
        addFolderHints(normalized);
        let slashPos = normalized.indexOf("/");
        while (slashPos >= 0) {
          const suffix = normalized.slice(slashPos + 1);
          add(suffix);
          addFolderHints(suffix);
          slashPos = normalized.indexOf("/", slashPos + 1);
        }
        return out;
      };

      const resolvePath = (candidatePath) => {
        const candidate = normalizePath(candidatePath);
        const isAbsolute =
          candidate.startsWith("/") ||
          /^[a-zA-Z]+:\/\//.test(candidate);
        let resolved = isAbsolute ? candidate : ((effect.baseDir || "") + candidate);
        if (effect.redirect) {
          resolved = effect.redirect(resolved);
        }
        return resolved;
      };

      const candidates = buildCandidates(path);
      const markPackageResourceMiss = () => {
        if (!effect.packageOnly) {
          return false;
        }

        const missingCandidates = candidates.map((candidate) => resolvePath(candidate));
        effect.packageMissingResources = missingCandidates.slice();
        res.buffer = null;
        res.isLoaded = true;
        debugWarn(`[EffekseerWebGPU] PackageResource MISS raw='${path}' baseDir='${effect.baseDir || ""}' candidates=${missingCandidates.join(" | ")}`);
        Promise.resolve().then(() => effect._update());
        return true;
      };

      if (effect.syncResourceLoad) {
        for (let i = 0; i < candidates.length; i++) {
          const candidate = candidates[i];
          const resolvedPath = resolvePath(candidate);
          const inlineBuffer =
            Module.resourcesMap[resolvedPath] ||
            Module.resourcesMap[candidate] ||
            Module.resourcesMap[path];
          if (inlineBuffer != null) {
            res.buffer = inlineBuffer;
            res.isLoaded = true;
            resourceTrace(
              `[EffekseerWebGPU] PackageResource HIT raw='${path}' candidate='${candidate}' resolved='${resolvedPath}' bytes=${inlineBuffer.byteLength || 0}`
            );
            return inlineBuffer;
          }

          if (effect.packageOnly) {
            continue;
          }

          const fetched = loadBinarySync(resolvedPath);
          if (fetched != null) {
            res.buffer = fetched;
            res.isLoaded = true;
            Module.resourcesMap[resolvedPath] = fetched;
            Module.resourcesMap[candidate] = fetched;
            debugLog(`[EffekseerWebGPU] SyncResource HIT raw='${path}' candidate='${candidate}' resolved='${resolvedPath}' bytes=${fetched.byteLength || 0}`);
            return fetched;
          }
        }

        if (markPackageResourceMiss()) {
          return null;
        }

        res.buffer = null;
        res.isLoaded = true;
        debugWarn(`[EffekseerWebGPU] SyncResource MISS raw='${path}' baseDir='${effect.baseDir || ""}' candidates=${candidates.join(" | ")}`);
        return null;
      }

      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        const resolvedPath = resolvePath(candidate);
        const inlineBuffer =
          Module.resourcesMap[resolvedPath] ||
          Module.resourcesMap[candidate] ||
          Module.resourcesMap[path];
        if (inlineBuffer != null) {
          res.buffer = inlineBuffer;
          res.isLoaded = true;
          resourceTrace(
            `[EffekseerWebGPU] PackageResource HIT(raw-async) raw='${path}' candidate='${candidate}' resolved='${resolvedPath}' bytes=${inlineBuffer.byteLength || 0}`
          );
          Promise.resolve().then(() => effect._update());
          return null;
        }
      }

      if (markPackageResourceMiss()) {
        return null;
      }

      let candidateIndex = 0;
      const tryLoadNext = () => {
        if (candidateIndex >= candidates.length) {
          res.buffer = null;
          res.isLoaded = true;
          debugWarn(`[EffekseerWebGPU] AsyncResource MISS raw='${path}' baseDir='${effect.baseDir || ""}' candidates=${candidates.join(" | ")}`);
          effect._update();
          return;
        }

        const candidate = candidates[candidateIndex++];
        const resolvedPath = resolvePath(candidate);
        loadResource(
          resolvedPath,
          (buffer) => {
            if (buffer != null) {
              res.buffer = buffer;
              res.isLoaded = true;
              debugLog(`[EffekseerWebGPU] AsyncResource HIT raw='${path}' candidate='${candidate}' resolved='${resolvedPath}' bytes=${buffer.byteLength || 0}`);
              effect._update();
              return;
            }
            tryLoadNext();
          },
          () => {
            tryLoadNext();
          }
        );
      };
      tryLoadNext();

      return null;
    };

    runtimeInitialized = true;
    runtimeInitializing = false;
    const callbacks = onRuntimeReadyQueue;
    onRuntimeReadyQueue = [];
    callbacks.forEach((cb) => cb(true));
  };

  const initializeRuntimeInternal = async (wasmPath) => {
    if (runtimeInitialized) {
      return;
    }
    if (runtimeInitializing) {
      await new Promise((resolve, reject) => {
        onRuntimeReadyQueue.push((ok) => ok ? resolve() : reject(new Error("Runtime initialization failed.")));
      });
      return;
    }

    runtimeInitializing = true;

    if (typeof effekseer_webgpu_native === "undefined") {
      runtimeInitializing = false;
      throw new Error("effekseer_webgpu_native is not loaded.");
    }

    const params = {};
    if (typeof wasmPath === "string" && wasmPath.length > 0) {
      params.locateFile = (path) => {
        if (path.endsWith(".wasm")) {
          return wasmPath;
        }
        return path;
      };
    }

    if (preinitializedDevice) {
      params.preinitializedWebGPUDevice = preinitializedDevice;
    }

    const moduleOrPromise = effekseer_webgpu_native(params);
    Module = (moduleOrPromise instanceof Promise) ? await moduleOrPromise : moduleOrPromise;
    if (!preinitializedDevice && Module?.preinitializedWebGPUDevice) {
      preinitializedDevice = Module.preinitializedWebGPUDevice;
    }
    if (preinitializedDevice) {
      Module.preinitializedWebGPUDevice = preinitializedDevice;
    }
    initCoreBindings();
  };

  class EffekseerEffect {
    constructor(context) {
      this.context = context;
      this.nativeptr = 0;
      this.baseDir = "";
      this.syncResourceLoad = false;
      this.isLoaded = false;
      this.scale = 1.0;
      this.resources = [];
      this.mainBuffer = null;
      this.onload = null;
      this.onerror = null;
      this._onloadListeners = [];
      this._onerrorListeners = [];
      this._loadFailed = false;
      this._loadErrorMessage = "";
      this._loadErrorPath = "";
      this._cacheKey = "";
      this.redirect = null;
      this.packageOnly = false;
      this.packageLoadFailed = false;
      this.packageErrorDispatched = false;
      this.packageMissingResources = [];
      this._ownedResourceAliases = [];
      this._managedRefIds = new Set();
    }

    _load(buffer) {
      const ab = toArrayBuffer(buffer);
      if (!ab) {
        dispatchEffectError(this, "invalid data", "");
        return;
      }

      loadingEffect = this;
      this.mainBuffer = ab;
      const memptr = Module._malloc(ab.byteLength);
      Module.HEAPU8.set(new Uint8Array(ab), memptr);
      this.nativeptr = Core.LoadEffect(this.context.nativeptr, memptr, ab.byteLength, this.scale);
      Module._free(memptr);
      loadingEffect = null;

      this._update();
    }

    _reload() {
      if (!this.mainBuffer || !this.nativeptr) {
        if (this.nativeptr && !this.mainBuffer) {
          debugWarn("[EffekseerWebGPU] ReloadResources skipped: mainBuffer is missing.");
        }
        return;
      }

      loadingEffect = this;
      const memptr = Module._malloc(this.mainBuffer.byteLength);
      Module.HEAPU8.set(new Uint8Array(this.mainBuffer), memptr);
      Core.ReloadResources(this.context.nativeptr, this.nativeptr, memptr, this.mainBuffer.byteLength);
      Module._free(memptr);
      loadingEffect = null;
    }

    _update() {
      let hasPendingResources = false;
      const missingRequiredResources = [];
      for (let i = 0; i < this.resources.length; i++) {
        const resource = this.resources[i];
        if (!resource.isLoaded) {
          hasPendingResources = true;
          break;
        }
        if (resource.isRequired && resource.buffer == null) {
          missingRequiredResources.push(resource.path);
        }
      }

      if (hasPendingResources) {
        return;
      }

      if (missingRequiredResources.length > 0) {
        const firstMissingPath = String(missingRequiredResources[0] || "");
        dispatchEffectError(
          this,
          `missing required resources: ${missingRequiredResources.join(", ")}`,
          firstMissingPath
        );
        return;
      }

      const loaded = this.nativeptr !== 0;
      if (!loaded) {
        dispatchEffectError(this, "failed to load effect", this.baseDir || "");
        return;
      }

      if (loaded && this.resources.length > 0) {
        this._reload();
      }

      if (!this.isLoaded && loaded) {
        this.isLoaded = true;
        dispatchEffectLoaded(this);
      }
    }
  }

  const createPackageEffect = (context, packageBuffer, sourcePath, scale, onload, onerror, redirect, existingEffect = null) => {
    const effect = existingEffect || new EffekseerEffect(context);
    effect.scale = scale;
    effect._ownedResourceAliases = [];
    registerEffectCallbacks(effect, onload, onerror);

    const entryMap = buildEfwgpkEntryMap(packageBuffer);
    if (entryMap.size === 0) {
      dispatchEffectError(effect, "invalid data. expected efkwgpk package", sourcePath || "");
      return effect;
    }

    const packageDir = (() => {
      if (typeof sourcePath !== "string" || sourcePath.length === 0) {
        return "";
      }
      const normalized = stripUrlDecorations(sourcePath);
      const dirIndex = normalized.lastIndexOf("/");
      return dirIndex >= 0 ? normalized.slice(0, dirIndex + 1) : "";
    })();
    const packageDirLower = packageDir.toLowerCase();
    const packagePrefix = `${EFWGPK_RESOURCE_SCHEME}${++efwgpkPackageId}/`;
    const resourceAliasMap = new Map();

    effect.baseDir = packageDir;
    effect.syncResourceLoad = true;
    effect.packageOnly = true;
    effect.redirect = (resolvedPath) => {
      const normalizedResolved = stripUrlDecorations(resolvedPath);
      const candidates = [];

      if (packageDirLower && normalizedResolved.toLowerCase().startsWith(packageDirLower)) {
        candidates.push(normalizedResolved.slice(packageDir.length));
      }
      candidates.push(normalizedResolved);

      for (let i = 0; i < candidates.length; i++) {
        const normalizedCandidate = normalizePackagePath(candidates[i]);
        if (!normalizedCandidate) {
          continue;
        }
        const alias = resourceAliasMap.get(normalizedCandidate);
        if (alias) {
          return alias;
        }
      }

      return resolvedPath;
    };

    (async () => {
      try {
        const mainEffectPath = await getEfwgpkMainEffectPath(packageBuffer, entryMap);
        if (!mainEffectPath) {
          throw new Error("main effect path not found in efkwgpk package");
        }
        debugInfo("[EffekseerWebGPU] efkwgpk main effect", {
          sourcePath,
          mainEffectPath,
          entryCount: entryMap.size
        });

        const mainBuffer = await getEfwgpkEntryBytes(packageBuffer, entryMap, mainEffectPath);
        const mainMagic4 = String.fromCharCode(...new Uint8Array(mainBuffer || new ArrayBuffer(0), 0, Math.min(4, mainBuffer ? mainBuffer.byteLength : 0)));
        if (!mainBuffer || (mainMagic4 !== "EFWG" && mainMagic4 !== "SKFE")) {
          throw new Error("main effect inside efkwgpk is not a valid .efkwg");
        }

        let preloadedResourceCount = 0;
        const payloadAliasMap = new Map();
        const payloadBytesCache = new Map();
        for (const [normalizedPath] of entryMap.entries()) {
          if (normalizedPath === mainEffectPath || normalizedPath === normalizePackagePath(EFWGPK_META_MAIN)) {
            continue;
          }
          const canonicalEntry = getEfwgpkCanonicalEntry(packageBuffer, entryMap, normalizedPath);
          if (!canonicalEntry) {
            continue;
          }
          const payloadKey = getEfwgpkEntryPayloadKey(canonicalEntry);
          if (!payloadKey) {
            continue;
          }

          let alias = payloadAliasMap.get(payloadKey);
          if (!alias) {
            let entryBytes = payloadBytesCache.get(payloadKey);
            if (entryBytes === undefined) {
              entryBytes = await getEfwgpkEntryBytes(packageBuffer, entryMap, normalizedPath);
              payloadBytesCache.set(payloadKey, entryBytes || null);
            }
            if (!entryBytes) {
              continue;
            }
            alias = `${packagePrefix}__payload/${payloadAliasMap.size}`;
            Module.resourcesMap[alias] = entryBytes;
            payloadAliasMap.set(payloadKey, alias);
            preloadedResourceCount++;
          }

          resourceAliasMap.set(normalizedPath, alias);
          resourceTrace(
            `[EffekseerWebGPU] PackageAlias '${normalizedPath}' -> '${alias}'`
          );
        }
        debugInfo("[EffekseerWebGPU] efkwgpk resources preloaded", {
          sourcePath,
          mainEffectPath,
          preloadedResourceCount,
          aliasedResourceCount: resourceAliasMap.size
        });

        effect._ownedResourceAliases = Array.from(payloadAliasMap.values());

        effect._load(mainBuffer);
        if (!effect.nativeptr) {
          dispatchEffectError(effect, "failed to load effect from efkwgpk package", sourcePath || mainEffectPath);
        }
      } catch (error) {
        debugError("[EffekseerWebGPU] efkwgpk load failed", {
          sourcePath,
          message: error && error.message ? error.message : String(error || "unknown error")
        });
        dispatchEffectError(effect, error && error.message ? error.message : "failed to load effect from efkwgpk package", sourcePath || "");
      }
    })();

    return effect;
  };

  class EffekseerHandle {
    constructor(context, nativeHandle) {
      this.context = context;
      this.native = nativeHandle;
    }

    stop() { Core.StopEffect(this.context.nativeptr, this.native); }
    stopRoot() { Core.StopRoot(this.context.nativeptr, this.native); }
    get exists() { return !!Core.Exists(this.context.nativeptr, this.native); }
    setFrame(frame) { Core.SetFrame(this.context.nativeptr, this.native, frame); }
    setLocation(x, y, z) { Core.SetLocation(this.context.nativeptr, this.native, x, y, z); }
    setRotation(x, y, z) { Core.SetRotation(this.context.nativeptr, this.native, x, y, z); }
    setScale(x, y, z) { Core.SetScale(this.context.nativeptr, this.native, x, y, z); }
    setAllColor(r, g, b, a) { Core.SetAllColor(this.context.nativeptr, this.native, r, g, b, a); }
    setTargetLocation(x, y, z) { Core.SetTargetLocation(this.context.nativeptr, this.native, x, y, z); }
    getDynamicInput(index) { return Core.GetDynamicInput(this.context.nativeptr, this.native, index); }
    setDynamicInput(index, value) { Core.SetDynamicInput(this.context.nativeptr, this.native, index, value); }
    sendTrigger(index) { Core.SendTrigger(this.context.nativeptr, this.native, index); }
    setPaused(paused) { Core.SetPaused(this.context.nativeptr, this.native, paused ? 1 : 0); }
    setShown(shown) { Core.SetShown(this.context.nativeptr, this.native, shown ? 1 : 0); }
    setSpeed(speed) { Core.SetSpeed(this.context.nativeptr, this.native, speed); }
    setRandomSeed(seed) { Core.SetRandomSeed(this.context.nativeptr, this.native, seed); }

    setMatrix(matrixArray) {
      withFloatArray(matrixArray, (ptr) => Core.SetMatrix(this.context.nativeptr, this.native, ptr));
    }
  }

  class EffekseerContext {
    constructor() {
      this.nativeptr = 0;
      this._effectCache = new Map();
      this._registeredEffects = new Map();
      this._registeredEffectStates = new Map();
      this.efkWgpuBaseDir = "";
      this.efkWgpuPackageBuffer = null;
      this.efkWgpuEntryMap = new Map();
      this.fixedUpdateStepFrames = 1.0;
      this.fixedUpdateMaxSubsteps = 4;
      this.fixedUpdateAccumulator = 0.0;
      this.externalRenderPassEnabled = false;
      this._warnedDrawWithExternalPass = false;
      this._warnedDrawExternalWithoutPass = false;
      this._warnedDrawExternalWithInternalPass = false;
      this._warnedSurfaceConfigureHint = false;
      this._warnedDeprecatedExternalInit = false;
    }

    _normalizeManagedEffectDescriptor(id, value) {
      const effectId = String(id || "").trim();
      if (!effectId) {
        throw new Error("registerEffects() requires non-empty effect ids.");
      }

      let descriptor = null;
      if (typeof value === "string") {
        descriptor = { path: value };
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        descriptor = value;
      } else {
        throw new Error(`registerEffects() entry "${effectId}" must be a string path or config object.`);
      }

      const path = String(descriptor.path || "").trim();
      if (!path) {
        throw new Error(`registerEffects() entry "${effectId}" requires a non-empty path.`);
      }

      const numericScale = Number(descriptor.scale);
      return {
        id: effectId,
        path,
        scale: Number.isFinite(numericScale) ? numericScale : 1.0,
        enabled: descriptor.enabled !== false,
      };
    }

    _createManagedEffectState(descriptor) {
      return {
        id: descriptor.id,
        path: descriptor.path,
        scale: descriptor.scale,
        enabled: descriptor.enabled,
        status: "unloaded",
        effect: null,
        errorMessage: "",
        errorPath: "",
        loadPromise: null,
        activeHandles: new Set(),
        ownedResourceAliases: [],
        _generation: 0,
        _loadingEffect: null,
      };
    }

    _resolveManagedEffectIds(ids, enabledOnly = false) {
      if (ids == null) {
        const resolvedIds = [];
        for (const [id, state] of this._registeredEffectStates.entries()) {
          if (!enabledOnly || state.enabled) {
            resolvedIds.push(id);
          }
        }
        return resolvedIds;
      }

      const inputIds = Array.isArray(ids) ? ids : [ids];
      const uniqueIds = [];
      const seen = new Set();
      for (let i = 0; i < inputIds.length; i++) {
        const id = String(inputIds[i] || "").trim();
        if (!id || seen.has(id)) {
          continue;
        }
        seen.add(id);
        uniqueIds.push(id);
      }
      return uniqueIds;
    }

    _registerManagedEffectReference(effect, id) {
      if (!effect) {
        return;
      }
      if (!(effect._managedRefIds instanceof Set)) {
        effect._managedRefIds = new Set();
      }
      effect._managedRefIds.add(id);
    }

    _releaseManagedEffectReference(effect, id) {
      if (!effect || !(effect._managedRefIds instanceof Set)) {
        return;
      }
      effect._managedRefIds.delete(id);
    }

    _releaseManagedEffectIfUnused(effect) {
      if (!effect) {
        return;
      }
      const managedRefIds = effect._managedRefIds instanceof Set ? effect._managedRefIds : null;
      if (managedRefIds && managedRefIds.size > 0) {
        return;
      }

      clearCachedEffectReference(effect);
      clearOwnedResourceAliases(effect._ownedResourceAliases);
      effect._ownedResourceAliases = [];

      if (this.nativeptr && effect.nativeptr) {
        Core.ReleaseEffect(this.nativeptr, effect.nativeptr);
        effect.nativeptr = 0;
      }
    }

    _stopManagedHandles(state) {
      if (!state) {
        return;
      }
      for (const handle of state.activeHandles) {
        try {
          handle?.stopRoot?.();
        } catch {
          // Swallow stale-handle errors during managed teardown.
        }
      }
      state.activeHandles.clear();
    }

    _cleanupManagedHandles() {
      for (const state of this._registeredEffectStates.values()) {
        if (!state || state.activeHandles.size === 0) {
          continue;
        }
        for (const handle of Array.from(state.activeHandles)) {
          if (!handle || handle.exists === false) {
            state.activeHandles.delete(handle);
          }
        }
      }
    }

    _resetManagedEffectStateToUnloaded(state) {
      if (!state) {
        return;
      }
      state.effect = null;
      state.status = "unloaded";
      state.errorMessage = "";
      state.errorPath = "";
      state.loadPromise = null;
      state.ownedResourceAliases = [];
      state._loadingEffect = null;
    }

    _loadRegisteredEffectState(state) {
      if (!state || !this.nativeptr) {
        return Promise.resolve(null);
      }

      const descriptor = this._registeredEffects.get(state.id);
      if (!descriptor) {
        return Promise.resolve(null);
      }

      const generation = state._generation + 1;
      state._generation = generation;
      state.status = "loading";
      state.errorMessage = "";
      state.errorPath = "";
      state.effect = null;
      state.ownedResourceAliases = [];
      state._loadingEffect = null;

      const loadPromise = new Promise((resolve) => {
        let settled = false;
        let requestedEffect = null;

        const finishSuccess = (loadedEffect) => {
          if (settled) {
            return;
          }
          settled = true;

          const currentState = this._registeredEffectStates.get(state.id);
          if (currentState !== state || state._generation !== generation) {
            this._releaseManagedEffectIfUnused(loadedEffect);
            resolve(null);
            return;
          }

          state._loadingEffect = null;
          state.loadPromise = null;

          if (!loadedEffect || !loadedEffect.isLoaded) {
            state.status = "failed";
            state.errorMessage = "failed to load effect";
            state.errorPath = descriptor.path;
            resolve(null);
            return;
          }

          state.effect = loadedEffect;
          state.status = "loaded";
          state.errorMessage = "";
          state.errorPath = "";
          state.ownedResourceAliases = Array.isArray(loadedEffect._ownedResourceAliases)
            ? loadedEffect._ownedResourceAliases.slice()
            : [];
          resolve(loadedEffect);
        };

        const finishError = (message, path = "") => {
          if (settled) {
            return;
          }
          settled = true;

          if (requestedEffect) {
            this._releaseManagedEffectReference(requestedEffect, state.id);
          }

          const currentState = this._registeredEffectStates.get(state.id);
          if (currentState !== state || state._generation !== generation) {
            if (requestedEffect) {
              this._releaseManagedEffectIfUnused(requestedEffect);
            }
            resolve(null);
            return;
          }

          state._loadingEffect = null;
          state.loadPromise = null;
          state.effect = null;
          state.status = "failed";
          state.errorMessage = String(message || "failed to load effect");
          state.errorPath = String(path || descriptor.path || "");
          state.ownedResourceAliases = [];
          if (requestedEffect) {
            this._releaseManagedEffectIfUnused(requestedEffect);
          }
          resolve(null);
        };

        try {
          requestedEffect = this.loadEffect(
            descriptor.path,
            descriptor.scale,
            () => finishSuccess(requestedEffect),
            (message, path) => finishError(message, path)
          );
        } catch (error) {
          finishError(error && error.message ? error.message : "failed to load effect", descriptor.path);
          return;
        }

        state._loadingEffect = requestedEffect;
        if (!requestedEffect) {
          finishError("failed to create effect", descriptor.path);
          return;
        }

        this._registerManagedEffectReference(requestedEffect, state.id);

        if (requestedEffect.isLoaded) {
          finishSuccess(requestedEffect);
          return;
        }

        if (requestedEffect._loadFailed) {
          finishError(requestedEffect._loadErrorMessage, requestedEffect._loadErrorPath);
        }
      });

      state.loadPromise = loadPromise;
      return loadPromise;
    }

    _prepareInitSettings(settings = {}, externalRenderPassEnabled = false) {
      const instanceMaxCount = settings.instanceMaxCount || 4000;
      const squareMaxCount = settings.squareMaxCount || 10000;
      const linearColorSpace = settings.linearColorSpace !== false ? 1 : 0;
      const compositeWithBackground = settings.compositeWithBackground ? 1 : 0;
      this.externalRenderPassEnabled = externalRenderPassEnabled;
      this._warnedDrawWithExternalPass = false;
      this._warnedDrawExternalWithoutPass = false;
      this._warnedDrawExternalWithInternalPass = false;
      this._warnedSurfaceConfigureHint = false;

      // Always use stable fixed-step simulation.
      this.fixedUpdateAccumulator = 0.0;

      return {
        instanceMaxCount,
        squareMaxCount,
        linearColorSpace,
        compositeWithBackground,
      };
    }

    _finishContextInit(settings = {}) {
      if (this.nativeptr && settings.effects) {
        this.registerEffects(settings.effects);
        void this.preloadEffects();
      }
      return !!this.nativeptr;
    }

    init(target, settings = {}) {
      if (settings.externalRenderPass === true) {
        if (!this._warnedDeprecatedExternalInit) {
          debugWarn(
            "[EffekseerWebGPU] context.init(target, { externalRenderPass: true }) is deprecated. " +
            "Use context.initExternal(settings) instead. The target argument is ignored in external mode."
          );
          this._warnedDeprecatedExternalInit = true;
        }
        return this.initExternal(settings);
      }

      let selector = "#canvas";
      if (typeof target === "string") {
        selector = target.startsWith("#") ? target : `#${target}`;
      } else if (typeof HTMLCanvasElement !== "undefined" && target instanceof HTMLCanvasElement) {
        if (!target.id) {
          contextId += 1;
          target.id = `effekseer_webgpu_canvas_${contextId}`;
        }
        selector = `#${target.id}`;
      }

      const config = this._prepareInitSettings(settings, false);
      this.nativeptr = Core.InitInternal(
        config.instanceMaxCount,
        config.squareMaxCount,
        selector,
        config.linearColorSpace,
        config.compositeWithBackground
      );
      return this._finishContextInit(settings);
    }

    initExternal(settings = {}) {
      const config = this._prepareInitSettings(settings, true);
      this.nativeptr = Core.InitExternal(
        config.instanceMaxCount,
        config.squareMaxCount,
        config.linearColorSpace,
        config.compositeWithBackground
      );
      return this._finishContextInit(settings);
    }

    update(deltaFrames = 1.0) {
      const delta = Number(deltaFrames);
      if (!Number.isFinite(delta) || delta <= 0.0) {
        this._cleanupManagedHandles();
        return;
      }

      this.fixedUpdateAccumulator += delta;
      let substeps = 0;
      while (this.fixedUpdateAccumulator >= this.fixedUpdateStepFrames && substeps < this.fixedUpdateMaxSubsteps) {
        Core.Update(this.nativeptr, this.fixedUpdateStepFrames);
        this.fixedUpdateAccumulator -= this.fixedUpdateStepFrames;
        substeps++;
      }

      if (substeps >= this.fixedUpdateMaxSubsteps && this.fixedUpdateAccumulator >= this.fixedUpdateStepFrames) {
        // Drop backlog to avoid long simulation bursts after frame hitches.
        this.fixedUpdateAccumulator = 0.0;
      }
      this._cleanupManagedHandles();
    }
    beginUpdate() { Core.BeginUpdate(this.nativeptr); }
    endUpdate() { Core.EndUpdate(this.nativeptr); }
    updateHandle(handle, deltaFrames = 1.0) { Core.UpdateHandle(this.nativeptr, handle.native, deltaFrames); }
    draw() {
      if (this.externalRenderPassEnabled) {
        if (!this._warnedDrawWithExternalPass) {
          debugWarn(
            "[EffekseerWebGPU] context.draw() called while the context is in external pass mode. " +
            "Use context.drawExternal(renderPassEncoder), " +
            "or re-init the context with context.init(target, settings) to use context.draw()."
          );
          this._warnedDrawWithExternalPass = true;
        }
        return;
      }

      try {
        Core.Draw(this.nativeptr);
      } catch (e) {
        const msg = (e && e.message) ? String(e.message) : "";
        if (!this._warnedSurfaceConfigureHint &&
          (msg.includes("reading 'canvas'") || msg.includes("_wgpuSurfaceConfigure"))) {
          debugWarn(
            "[EffekseerWebGPU] draw() failed while configuring surface. " +
            "If you are using external pass mode, call drawExternal(...) with a valid render pass encoder " +
            "and initialize with context.initExternal(settings). " +
            "If you are not using external pass mode, initialize with context.init(target, settings)."
          );
          this._warnedSurfaceConfigureHint = true;
        }
        throw e;
      }
    }
    drawExternal(renderPassEncoder, renderPassState = null, mode = "all") {
      if (!this.externalRenderPassEnabled && !this._warnedDrawExternalWithInternalPass) {
        debugWarn(
          "[EffekseerWebGPU] context.drawExternal(...) called while the context is in internal mode. " +
          "Use context.draw() for internal mode, or re-init with context.initExternal(settings) for external pass mode."
        );
        this._warnedDrawExternalWithInternalPass = true;
      }

      if (!renderPassEncoder) {
        if (!this._warnedDrawExternalWithoutPass) {
          debugWarn(
            "[EffekseerWebGPU] context.drawExternal(...) called without renderPassEncoder. " +
            "Pass a valid GPU render pass encoder."
          );
          this._warnedDrawExternalWithoutPass = true;
        }
        return;
      }

      const colorFormatRaw = toTextureFormatValue(renderPassState && renderPassState.colorFormat);
      // Explicitly pass Undefined (0) when the external pass has no depth attachment.
      const depthFormatRaw = (() => {
        const v = toTextureFormatValue(renderPassState && renderPassState.depthFormat);
        return (v === null) ? 0 : v;
      })();
      const sampleCountRaw = toSampleCountValue(renderPassState && renderPassState.sampleCount);
      const hasOwn = (obj, key) => !!obj && Object.prototype.hasOwnProperty.call(obj, key);
      const hasDepthViewInState = hasOwn(renderPassState, "depthTextureView") || hasOwn(renderPassState, "importDepthTextureView");
      const hasBackgroundViewInState = hasOwn(renderPassState, "backgroundTextureView") || hasOwn(renderPassState, "importBackgroundTextureView");
      const depthTextureViewFromState = hasDepthViewInState
        ? (hasOwn(renderPassState, "depthTextureView") ? renderPassState.depthTextureView : renderPassState.importDepthTextureView)
        : null;
      const backgroundTextureViewFromState = hasBackgroundViewInState
        ? (hasOwn(renderPassState, "backgroundTextureView") ? renderPassState.backgroundTextureView : renderPassState.importBackgroundTextureView)
        : null;
      const prevDepthTextureView = hasDepthViewInState ? Module.__effekseerDepthTextureView : null;
      const prevBackgroundTextureView = hasBackgroundViewInState ? Module.__effekseerBackgroundTextureView : null;

      Module.__effekseerExternalRenderPass = renderPassEncoder;
      Module.__effekseerExternalPassColorFormat = colorFormatRaw;
      Module.__effekseerExternalPassDepthFormat = depthFormatRaw;
      Module.__effekseerExternalPassSampleCount = sampleCountRaw;
      if (hasDepthViewInState) {
        Module.__effekseerDepthTextureView = depthTextureViewFromState || null;
      }
      if (hasBackgroundViewInState) {
        Module.__effekseerBackgroundTextureView = backgroundTextureViewFromState || null;
      }
      const drawMode = (() => {
        if (mode === "back") {
          return "back";
        }
        if (mode === "front") {
          return "front";
        }
        return "all";
      })();
      try {
        if (drawMode === "back") {
          Core.DrawExternalBack(this.nativeptr);
        } else if (drawMode === "front") {
          Core.DrawExternalFront(this.nativeptr);
        } else {
          Core.DrawExternal(this.nativeptr);
        }
      } finally {
        if (hasDepthViewInState) {
          Module.__effekseerDepthTextureView = prevDepthTextureView || null;
        }
        if (hasBackgroundViewInState) {
          Module.__effekseerBackgroundTextureView = prevBackgroundTextureView || null;
        }
        Module.__effekseerExternalRenderPass = null;
        Module.__effekseerExternalPassColorFormat = null;
        Module.__effekseerExternalPassDepthFormat = null;
        Module.__effekseerExternalPassSampleCount = null;
      }
    }
    beginDraw() { Core.BeginDraw(this.nativeptr); }
    endDraw() { Core.EndDraw(this.nativeptr); }
    drawHandle(handle) { Core.DrawHandle(this.nativeptr, handle.native); }

    setProjectionMatrix(matrixArray) {
      withFloatArray(matrixArray, (ptr) => Core.SetProjectionMatrix(this.nativeptr, ptr));
    }

    setProjectionPerspective(fov, aspect, near, far) {
      Core.SetProjectionPerspective(this.nativeptr, fov, aspect, near, far);
    }

    setProjectionOrthographic(width, height, near, far) {
      Core.SetProjectionOrthographic(this.nativeptr, width, height, near, far);
    }

    setCameraMatrix(matrixArray) {
      withFloatArray(matrixArray, (ptr) => Core.SetCameraMatrix(this.nativeptr, ptr));
    }

    setCameraLookAt(positionX, positionY, positionZ, targetX, targetY, targetZ, upvecX, upvecY, upvecZ) {
      Core.SetCameraLookAt(this.nativeptr, positionX, positionY, positionZ, targetX, targetY, targetZ, upvecX, upvecY, upvecZ);
    }

    setCameraLookAtFromVector(position, target, upvec = { x: 0, y: 1, z: 0 }) {
      this.setCameraLookAt(position.x, position.y, position.z, target.x, target.y, target.z, upvec.x, upvec.y, upvec.z);
    }

    setCompositeMode(enabled) {
      Core.SetCompositeMode(this.nativeptr, enabled ? 1 : 0);
    }

    loadEfkWgpuPackage(data, sourcePath = "") {
      this.efkWgpuBaseDir = "";
      this.efkWgpuPackageBuffer = null;
      this.efkWgpuEntryMap.clear();
      return false;
    }

    unloadEfkWgpuPackage() {
      this.efkWgpuBaseDir = "";
      this.efkWgpuPackageBuffer = null;
      this.efkWgpuEntryMap.clear();
    }

    isEfkWgpuPackageLoaded() {
      return false;
    }

    getEfkWgpuPackageGlobalFlags() {
      return 0;
    }

    getEfkWgpuMainEffectPath() {
      return "";
    }

    _buildEfkWgpuEntryMap(buffer) {
      const map = new Map();
      const totalSize = buffer ? buffer.byteLength : 0;
      if (!buffer || totalSize < 64) {
        debugWarn("[EffekseerWebGPU] EFKWGPU index build skipped: buffer too small.");
        return map;
      }

      const view = new DataView(buffer);
      const magic = String.fromCharCode(
        view.getUint8(0),
        view.getUint8(1),
        view.getUint8(2),
        view.getUint8(3),
        view.getUint8(4),
        view.getUint8(5),
        view.getUint8(6),
        view.getUint8(7)
      );
      if (magic !== "EFKWGPU1") {
        debugWarn(`[EffekseerWebGPU] EFKWGPU index build skipped: invalid magic '${magic}'.`);
        return map;
      }

      const headerSize = view.getUint32(8, true);
      const entryCount = view.getUint32(20, true);
      const entryStride = view.getUint32(24, true);
      const entriesOffset = view.getUint32(28, true);
      const stringPoolOffset = view.getUint32(32, true);
      const stringPoolSize = view.getUint32(36, true);
      const payloadOffset = view.getUint32(40, true);
      const payloadSize = view.getUint32(44, true);

      if (headerSize !== 64) {
        debugWarn(`[EffekseerWebGPU] EFKWGPU index build skipped: unsupported header size ${headerSize}.`);
        return map;
      }
      if (entryStride < 32) {
        debugWarn(`[EffekseerWebGPU] EFKWGPU index build skipped: invalid entry stride ${entryStride}.`);
        return map;
      }

      const entryTableSizeBig = BigInt(entryCount) * BigInt(entryStride);
      if (entryTableSizeBig > BigInt(totalSize)) {
        debugWarn("[EffekseerWebGPU] EFKWGPU index build skipped: entry table is out of bounds.");
        return map;
      }
      const entryTableSize = Number(entryTableSizeBig);
      if (!isValidBufferSpan(entriesOffset, entryTableSize, totalSize)) {
        debugWarn("[EffekseerWebGPU] EFKWGPU index build skipped: entries span is invalid.");
        return map;
      }
      if (!isValidBufferSpan(stringPoolOffset, stringPoolSize, totalSize)) {
        debugWarn("[EffekseerWebGPU] EFKWGPU index build skipped: string pool span is invalid.");
        return map;
      }
      if (!isValidBufferSpan(payloadOffset, payloadSize, totalSize)) {
        debugWarn("[EffekseerWebGPU] EFKWGPU index build skipped: payload span is invalid.");
        return map;
      }

      const stringPoolEnd = stringPoolOffset + stringPoolSize;
      const payloadEnd = payloadOffset + payloadSize;
      const decoder = new TextDecoder("utf-8");
      for (let i = 0; i < entryCount; i++) {
        const base = entriesOffset + i * entryStride;
        const pathOffset = view.getUint32(base + 8, true);
        const pathLength = view.getUint32(base + 12, true);
        const flags = view.getUint32(base + 16, true);
        const entryPayloadOffset = view.getUint32(base + 20, true);
        const packedSize = view.getUint32(base + 24, true);
        const rawSize = view.getUint32(base + 28, true);

        if (!isValidBufferSpan(pathOffset, pathLength, totalSize)) {
          continue;
        }
        if (pathOffset < stringPoolOffset || (pathOffset + pathLength) > stringPoolEnd) {
          continue;
        }
        if (!isValidBufferSpan(entryPayloadOffset, packedSize, totalSize)) {
          continue;
        }
        if (entryPayloadOffset < payloadOffset || (entryPayloadOffset + packedSize) > payloadEnd) {
          continue;
        }

        let path = "";
        try {
          const bytes = new Uint8Array(buffer, pathOffset, pathLength);
          path = decoder.decode(bytes);
        } catch {
          continue;
        }

        const normalizedPath = normalizePackagePath(path);
        if (!normalizedPath) {
          continue;
        }

        const entry = {
          index: i,
          path,
          normalizedPath,
          flags,
          payloadOffset: entryPayloadOffset,
          packedSize,
          rawSize
        };
        const bucket = map.get(normalizedPath);
        if (bucket) {
          bucket.push(entry);
        } else {
          map.set(normalizedPath, [entry]);
        }
      }

      debugLog(`[EffekseerWebGPU] EFKWGPU index built: entries=${entryCount} mapped=${map.size}`);
      return map;
    }

    _getEfkWgpuEntryBytes(path) {
      const normalizedPath = normalizePackagePath(path);
      if (!normalizedPath || !this.efkWgpuPackageBuffer || this.efkWgpuEntryMap.size === 0) {
        return null;
      }

      const bucket = this.efkWgpuEntryMap.get(normalizedPath);
      if (!bucket || bucket.length === 0) {
        return null;
      }

      for (let i = 0; i < bucket.length; i++) {
        const entry = bucket[i];
        if (entry.flags !== 0) {
          continue;
        }
        if (entry.packedSize !== entry.rawSize) {
          continue;
        }
        const begin = entry.payloadOffset;
        const end = begin + entry.packedSize;
        if (!isValidBufferSpan(begin, entry.packedSize, this.efkWgpuPackageBuffer.byteLength)) {
          continue;
        }
        return this.efkWgpuPackageBuffer.slice(begin, end);
      }

      const first = bucket[0];
      debugWarn(`[EffekseerWebGPU] EFKWGPU entry decode unsupported for '${normalizedPath}' flags=${first.flags} packed=${first.packedSize} raw=${first.rawSize}`);
      return null;
    }

    loadMainEffectFromPackage(scale = 1.0, onload, onerror) {
      const effect = new EffekseerEffect(this);
      if (typeof scale === "function") {
        effect.scale = 1.0;
        registerEffectCallbacks(effect, scale, onload);
      } else {
        effect.scale = scale;
        registerEffectCallbacks(effect, onload, onerror);
      }
      dispatchEffectError(effect, "failed to load effect", "");
      return effect;
    }

    loadEffectFromPackage(path, scale = 1.0, onload, onerror) {
      const effect = new EffekseerEffect(this);

      if (typeof scale === "function") {
        effect.scale = 1.0;
        registerEffectCallbacks(effect, scale, onload);
      } else {
        effect.scale = scale;
        registerEffectCallbacks(effect, onload, onerror);
      }

      if (typeof path !== "string" || path.length === 0) {
        dispatchEffectError(effect, "invalid path", String(path || ""));
        return effect;
      }

      dispatchEffectError(effect, "failed to load effect", path);
      return effect;
    }

    loadEffect(data, scale = 1.0, onload, onerror, redirect) {
      const effectScale = (typeof scale === "function") ? 1.0 : scale;
      const effectOnload = (typeof scale === "function") ? scale : onload;
      const effectOnerror = (typeof scale === "function") ? onload : onerror;
      const effectRedirect = redirect;
      let cacheKey = null;
      if (typeof data === "string" && effectRedirect == null) {
        cacheKey = buildEffectCacheKey(data, effectScale);
        const cachedEffect = this._effectCache.get(cacheKey);
        if (cachedEffect) {
          registerEffectCallbacks(cachedEffect, effectOnload, effectOnerror);
          return cachedEffect;
        }
      }

      const effect = new EffekseerEffect(this);
      effect.scale = effectScale;
      effect.redirect = effectRedirect;
      effect._cacheKey = cacheKey || "";
      registerEffectCallbacks(effect, effectOnload, effectOnerror);

      if (cacheKey) {
        this._effectCache.set(cacheKey, effect);
      }

      const fail = (message, path = "") => {
        dispatchEffectError(effect, message, path);
        return effect;
      };

      if (typeof data === "string") {
        if (isEfkWgPath(data)) {
          loadBinary(data, (effectBytes) => {
            const effectBuffer = toArrayBuffer(effectBytes);
            if (!effectBuffer) {
              fail("failed to fetch efkwg effect", data);
              return;
            }
            const normalized = data.replace(/\\/g, "/").split("?")[0].split("#")[0];
            const dirIndex = normalized.lastIndexOf("/");
            effect.baseDir = dirIndex >= 0 ? normalized.slice(0, dirIndex + 1) : "";
            effect.syncResourceLoad = false;
            effect._load(effectBuffer);
            if (!effect.nativeptr) {
              fail("failed to load efkwg effect", data);
            }
          }, () => {
            fail("failed to fetch efkwg effect", data);
          });
          return effect;
        }

        if (isEfwgpkPath(data)) {
          loadBinary(data, (packageBytes) => {
            const packageBuffer = toArrayBuffer(packageBytes);
            if (!packageBuffer) {
              fail("failed to fetch efkwgpk package", data);
              return;
            }
            createPackageEffect(this, packageBuffer, data, effectScale, null, null, effectRedirect, effect);
          }, () => {
            fail("failed to fetch efkwgpk package", data);
          });
          return effect;
        }

        return fail("unsupported effect format. expected .efkwg or .efkwgpk", data);
      }

      const packageBuffer = toArrayBuffer(data);
      if (!packageBuffer) {
        return fail("invalid data. expected efkwg or efkwgpk bytes", "");
      }

      if (readMagic8(packageBuffer) === EFWGPK_MAGIC) {
        return createPackageEffect(this, packageBuffer, "", effectScale, null, null, effectRedirect, effect);
      }

      const magic4 = String.fromCharCode(...new Uint8Array(packageBuffer, 0, Math.min(4, packageBuffer.byteLength)));
      if (magic4 === "EFWG" || magic4 === "SKFE") {
        effect._load(packageBuffer);
        if (!effect.nativeptr) {
          return fail("failed to load efkwg effect", "");
        }
        return effect;
      }

      return fail("invalid data. expected efkwg or efkwgpk bytes", "");
    }

    loadEffectPackage(data, Unzip, scale = 1.0, onload, onerror) {
      let effectScale = scale;
      let effectOnload = onload;
      let effectOnerror = onerror;
      if (typeof scale === "function") {
        effectScale = 1.0;
        effectOnload = scale;
        effectOnerror = onload;
      }
      void Unzip;
      return this.loadEffect(data, effectScale, effectOnload, effectOnerror);
    }

    registerEffects(effects) {
      if (!effects || typeof effects !== "object" || Array.isArray(effects)) {
        throw new Error("registerEffects() expects an object map of effect ids to paths/configs.");
      }

      const nextDescriptors = [];
      for (const [id, value] of Object.entries(effects)) {
        if (this._registeredEffects.has(id)) {
          throw new Error(`registerEffects() duplicate id "${id}".`);
        }
        nextDescriptors.push(this._normalizeManagedEffectDescriptor(id, value));
      }

      for (let i = 0; i < nextDescriptors.length; i++) {
        const descriptor = nextDescriptors[i];
        if (this._registeredEffects.has(descriptor.id)) {
          throw new Error(`registerEffects() duplicate id "${descriptor.id}".`);
        }
      }

      for (let i = 0; i < nextDescriptors.length; i++) {
        const descriptor = nextDescriptors[i];
        this._registeredEffects.set(descriptor.id, descriptor);
        this._registeredEffectStates.set(descriptor.id, this._createManagedEffectState(descriptor));
      }

      if (!this.nativeptr) {
        return;
      }

      for (let i = 0; i < nextDescriptors.length; i++) {
        const descriptor = nextDescriptors[i];
        if (descriptor.enabled) {
          void this.preloadEffects([descriptor.id]);
        }
      }
    }

    preloadEffects(ids) {
      const targetIds = this._resolveManagedEffectIds(ids, ids == null);
      return Promise.all(targetIds.map(async (id) => {
        const state = this._registeredEffectStates.get(id);
        if (!state) {
          return [id, null];
        }
        if (state.status === "loaded" && state.effect?.isLoaded) {
          return [id, state.effect];
        }
        if (state.status === "loading" && state.loadPromise) {
          return [id, await state.loadPromise];
        }
        return [id, await this._loadRegisteredEffectState(state)];
      })).then((entries) => new Map(entries));
    }

    reloadEffects(ids) {
      const targetIds = this._resolveManagedEffectIds(ids, ids == null);
      this.unloadEffects(targetIds);
      return this.preloadEffects(targetIds);
    }

    unloadEffects(ids) {
      const targetIds = this._resolveManagedEffectIds(ids);
      for (let i = 0; i < targetIds.length; i++) {
        const id = targetIds[i];
        const state = this._registeredEffectStates.get(id);
        if (!state) {
          continue;
        }

        state._generation += 1;
        this._stopManagedHandles(state);

        const loadingEffect = state._loadingEffect;
        if (loadingEffect) {
          this._releaseManagedEffectReference(loadingEffect, id);
          this._releaseManagedEffectIfUnused(loadingEffect);
        }

        const loadedEffect = state.effect;
        if (loadedEffect) {
          this._releaseManagedEffectReference(loadedEffect, id);
          this._releaseManagedEffectIfUnused(loadedEffect);
        }

        this._resetManagedEffectStateToUnloaded(state);
      }
    }

    unregisterEffects(ids) {
      const targetIds = this._resolveManagedEffectIds(ids);
      this.unloadEffects(targetIds);
      for (let i = 0; i < targetIds.length; i++) {
        const id = targetIds[i];
        this._registeredEffects.delete(id);
        this._registeredEffectStates.delete(id);
      }
    }

    getEffect(id) {
      const state = this._registeredEffectStates.get(String(id || ""));
      return (state?.status === "loaded" && state.effect?.isLoaded) ? state.effect : null;
    }

    getEffectState(id) {
      return createManagedEffectSnapshot(this._registeredEffectStates.get(String(id || "")));
    }

    getEffectStates() {
      return Array.from(this._registeredEffectStates.values(), (state) => createManagedEffectSnapshot(state));
    }

    whenEffectsReady(ids) {
      return this.preloadEffects(ids);
    }

    playEffect(id, x = 0, y = 0, z = 0) {
      const state = this._registeredEffectStates.get(String(id || ""));
      if (!state || state.status !== "loaded" || !state.effect?.isLoaded) {
        return null;
      }

      const nextHandle = this.play(state.effect, x, y, z);
      if (nextHandle) {
        state.activeHandles.add(nextHandle);
      }
      return nextHandle;
    }

    releaseEffect(effect) {
      if (!effect || !effect.nativeptr) {
        return;
      }
      clearCachedEffectReference(effect);
      Core.ReleaseEffect(this.nativeptr, effect.nativeptr);
      effect.nativeptr = 0;
    }

    play(effect, x = 0, y = 0, z = 0) {
      if (!effect || !effect.isLoaded) {
        return null;
      }
      const handle = Core.PlayEffect(this.nativeptr, effect.nativeptr, x, y, z);
      return handle >= 0 ? new EffekseerHandle(this, handle) : null;
    }

    stopAll() { Core.StopAllEffects(this.nativeptr); }
    setResourceLoader(loader) { loadResource = loader; }
    getRestInstancesCount() { return Core.GetRestInstancesCount(this.nativeptr); }
    getUpdateTime() { return Core.GetUpdateTime(this.nativeptr); }
    getDrawTime() { return Core.GetDrawTime(this.nativeptr); }
    getDrawFlushComputeTime() { return Core.GetDrawFlushComputeTime(this.nativeptr); }
    getDrawBeginFrameTime() { return Core.GetDrawBeginFrameTime(this.nativeptr); }
    getDrawManagerTime() { return Core.GetDrawManagerTime(this.nativeptr); }
    getDrawEndFrameTime() { return Core.GetDrawEndFrameTime(this.nativeptr); }
    getDrawTotalTime() { return Core.GetDrawTotalTime(this.nativeptr); }
    getGpuTimestampSupported() { return !!Core.GetGpuTimestampSupported(this.nativeptr); }
    getGpuTimestampValid() { return !!Core.GetGpuTimestampValid(this.nativeptr); }
    getGpuTimestampEffekseerPassTime() { return Core.GetGpuTimestampEffekseerPassTime(this.nativeptr); }
    getGpuTimestampFrameTime() { return Core.GetGpuTimestampFrameTime(this.nativeptr); }
    getGpuTimestampReadPending() { return !!Core.GetGpuTimestampReadPending(this.nativeptr); }
    getGpuTimestampLastMapStatus() { return Core.GetGpuTimestampLastMapStatus(this.nativeptr); }
    getGpuTimestampMapState() { return Core.GetGpuTimestampMapState(this.nativeptr); }
    getGpuTimestampMapMode() { return Core.GetGpuTimestampMapMode(this.nativeptr); }
    getGpuTimestampStallRecoveries() { return Core.GetGpuTimestampStallRecoveries(this.nativeptr); }
    getRendererProfileBindGroupTime() { return Core.GetRendererProfileBindGroupTime(this.nativeptr); }
    getRendererProfileBindGroupCacheFlushCount() { return Core.GetRendererProfileBindGroupCacheFlushCount(this.nativeptr); }
    getRendererProfileBindGroupCacheHits() { return Core.GetRendererProfileBindGroupCacheHits(this.nativeptr); }
    getRendererProfileBindGroupCacheMisses() { return Core.GetRendererProfileBindGroupCacheMisses(this.nativeptr); }
    getRendererProfileBindGroupCreates() { return Core.GetRendererProfileBindGroupCreates(this.nativeptr); }
    getRendererProfilePipelineTime() { return Core.GetRendererProfilePipelineTime(this.nativeptr); }
    getRendererProfileSetStateTime() { return Core.GetRendererProfileSetStateTime(this.nativeptr); }
    getRendererProfileIssueDrawTime() { return Core.GetRendererProfileIssueDrawTime(this.nativeptr); }
    getRendererProfileDrawTotalTime() { return Core.GetRendererProfileDrawTotalTime(this.nativeptr); }
    getRendererProfileDrawSpritesCalls() { return Core.GetRendererProfileDrawSpritesCalls(this.nativeptr); }
    getRendererProfileDrawPolygonCalls() { return Core.GetRendererProfileDrawPolygonCalls(this.nativeptr); }
    getInternalStandardRendererTextureSetupTime() { return Core.GetInternalStandardRendererTextureSetupTime(this.nativeptr); }
    getInternalStandardRendererShaderSelectTime() { return Core.GetInternalStandardRendererShaderSelectTime(this.nativeptr); }
    getInternalStandardRendererVertexPackTime() { return Core.GetInternalStandardRendererVertexPackTime(this.nativeptr); }
    getInternalStandardRendererPixelPackTime() { return Core.GetInternalStandardRendererPixelPackTime(this.nativeptr); }
    getInternalStandardRendererConstantUploadTime() { return Core.GetInternalStandardRendererConstantUploadTime(this.nativeptr); }
    getInternalStandardRendererRenderStateTime() { return Core.GetInternalStandardRendererRenderStateTime(this.nativeptr); }
    getInternalStandardRendererVertexBindTime() { return Core.GetInternalStandardRendererVertexBindTime(this.nativeptr); }
    getInternalStandardRendererIndexBindTime() { return Core.GetInternalStandardRendererIndexBindTime(this.nativeptr); }
    getInternalStandardRendererLayoutTime() { return Core.GetInternalStandardRendererLayoutTime(this.nativeptr); }
    getInternalStandardRendererDrawTime() { return Core.GetInternalStandardRendererDrawTime(this.nativeptr); }
    getManagerProfileFrustumTime() { return Core.GetManagerProfileFrustumTime(this.nativeptr); }
    getManagerProfileSortTime() { return Core.GetManagerProfileSortTime(this.nativeptr); }
    getManagerProfileCanDrawTime() { return Core.GetManagerProfileCanDrawTime(this.nativeptr); }
    getManagerProfileContainerDrawTime() { return Core.GetManagerProfileContainerDrawTime(this.nativeptr); }
    getManagerProfileGpuParticleTime() { return Core.GetManagerProfileGpuParticleTime(this.nativeptr); }
    getManagerProfileDrawSetCount() { return Core.GetManagerProfileDrawSetCount(this.nativeptr); }
    getManagerProfileVisibleDrawSetCount() { return Core.GetManagerProfileVisibleDrawSetCount(this.nativeptr); }
    getManagerProfileContainersTotal() { return Core.GetManagerProfileContainersTotal(this.nativeptr); }
    getManagerProfileContainersDrawn() { return Core.GetManagerProfileContainersDrawn(this.nativeptr); }
    getManagerProfileContainersDepthCulled() { return Core.GetManagerProfileContainersDepthCulled(this.nativeptr); }
    getDrawCallCount() { return Core.GetDrawCallCount(this.nativeptr); }
    getDrawVertexCount() { return Core.GetDrawVertexCount(this.nativeptr); }
    getTotalParticleCount() { return Core.GetTotalParticleCount(this.nativeptr); }
    isVertexArrayObjectSupported() { return !!Core.IsVertexArrayObjectSupported(this.nativeptr); }
    setRestorationOfStatesFlag(flag) { Core.SetRestorationOfStatesFlag(this.nativeptr, flag ? 1 : 0); }
    captureBackground(x, y, width, height) { Core.CaptureBackground(this.nativeptr, x, y, width, height); }
    resetBackground() { Core.ResetBackground(this.nativeptr); }
  }

  class Effekseer {
    async initRuntime(path, onload, onerror) {
      try {
        await initializeRuntimeInternal(path);
        if (onload) {
          onload();
        }
      } catch (e) {
        runtimeInitializing = false;
        runtimeInitialized = false;
        onRuntimeReadyQueue = [];
        if (onerror) {
          onerror(e);
        } else {
          console.error(e);
        }
      }
    }

    createContext() {
      if (!runtimeInitialized) {
        return null;
      }
      return new EffekseerContext();
    }

    releaseContext(context) {
      if (!context || !context.nativeptr) {
        return;
      }
      context.unloadEffects?.();
      Core.Terminate(context.nativeptr);
      context.nativeptr = 0;
      context._effectCache?.clear?.();
      context._registeredEffects?.clear?.();
      context._registeredEffectStates?.clear?.();
    }

    setLogEnabled(flag) {
      if (!runtimeInitialized) {
        return;
      }
      Core.SetLogEnabled(flag ? 1 : 0);
    }

    setImageCrossOrigin(crossOrigin) {
      imageCrossOrigin = crossOrigin;
      void imageCrossOrigin;
    }

    setWebGPUDevice(device) {
      if (runtimeInitialized || runtimeInitializing) {
        throw new Error("setWebGPUDevice() must be called before initRuntime().");
      }
      if (device == null) {
        externalWebGPUDevice = null;
        preinitializedDevice = null;
        return;
      }
      if (
        typeof device !== "object" ||
        typeof device.createCommandEncoder !== "function" ||
        !device.queue
      ) {
        throw new Error("setWebGPUDevice() expects a valid GPUDevice.");
      }
      externalWebGPUDevice = device;
      preinitializedDevice = device;
    }

    setRendererWorkingColorSpace(colorSpaceApi) {
      return setRendererLinearWorkingColorSpace(colorSpaceApi);
    }

    getWebGPUDevice() {
      return preinitializedDevice || (Module ? Module.preinitializedWebGPUDevice : null) || null;
    }

    init(target, settings) {
      if (this.defaultContext?.nativeptr) {
        this.releaseContext(this.defaultContext);
      }
      this.defaultContext = new EffekseerContext();
      return this.defaultContext.init(target, settings);
    }

    update(deltaFrames) { this.defaultContext.update(deltaFrames); }
    beginUpdate() { this.defaultContext.beginUpdate(); }
    endUpdate() { this.defaultContext.endUpdate(); }
    updateHandle(handle, deltaFrames) { this.defaultContext.updateHandle(handle, deltaFrames); }
    draw() { this.defaultContext.draw(); }
    drawExternal(renderPassEncoder, renderPassState, mode = "all") { this.defaultContext.drawExternal(renderPassEncoder, renderPassState, mode); }
    beginDraw() { this.defaultContext.beginDraw(); }
    endDraw() { this.defaultContext.endDraw(); }
    drawHandle(handle) { this.defaultContext.drawHandle(handle); }
    setProjectionMatrix(matrixArray) { this.defaultContext.setProjectionMatrix(matrixArray); }
    setProjectionPerspective(fov, aspect, near, far) { this.defaultContext.setProjectionPerspective(fov, aspect, near, far); }
    setProjectionOrthographic(width, height, near, far) { this.defaultContext.setProjectionOrthographic(width, height, near, far); }
    setCameraMatrix(matrixArray) { this.defaultContext.setCameraMatrix(matrixArray); }
    setCameraLookAt(positionX, positionY, positionZ, targetX, targetY, targetZ, upvecX, upvecY, upvecZ) {
      this.defaultContext.setCameraLookAt(positionX, positionY, positionZ, targetX, targetY, targetZ, upvecX, upvecY, upvecZ);
    }
    setCameraLookAtFromVector(position, target, upvec) { this.defaultContext.setCameraLookAtFromVector(position, target, upvec); }
    setCompositeMode(enabled) { this.defaultContext.setCompositeMode(enabled); }
    loadEffect(pathOrBuffer, scale, onload, onerror, redirect) { return this.defaultContext.loadEffect(pathOrBuffer, scale, onload, onerror, redirect); }
    loadEffectPackage(pathOrBuffer, Unzip, scale, onload, onerror) { return this.defaultContext.loadEffectPackage(pathOrBuffer, Unzip, scale, onload, onerror); }
    registerEffects(effects) { this.defaultContext.registerEffects(effects); }
    preloadEffects(ids) { return this.defaultContext.preloadEffects(ids); }
    reloadEffects(ids) { return this.defaultContext.reloadEffects(ids); }
    unloadEffects(ids) { this.defaultContext.unloadEffects(ids); }
    unregisterEffects(ids) { this.defaultContext.unregisterEffects(ids); }
    getEffect(id) { return this.defaultContext.getEffect(id); }
    getEffectState(id) { return this.defaultContext.getEffectState(id); }
    getEffectStates() { return this.defaultContext.getEffectStates(); }
    whenEffectsReady(ids) { return this.defaultContext.whenEffectsReady(ids); }
    playEffect(id, x, y, z) { return this.defaultContext.playEffect(id, x, y, z); }
    releaseEffect(effect) { this.defaultContext.releaseEffect(effect); }
    play(effect, x, y, z) { return this.defaultContext.play(effect, x, y, z); }
    stopAll() { this.defaultContext.stopAll(); }
    setResourceLoader(loader) { this.defaultContext.setResourceLoader(loader); }
    getRestInstancesCount() { return this.defaultContext.getRestInstancesCount(); }
    getUpdateTime() { return this.defaultContext.getUpdateTime(); }
    getDrawTime() { return this.defaultContext.getDrawTime(); }
    isVertexArrayObjectSupported() { return this.defaultContext.isVertexArrayObjectSupported(); }
  }

  delete EffekseerContext.prototype.loadEfkWgpuPackage;
  delete EffekseerContext.prototype.unloadEfkWgpuPackage;
  delete EffekseerContext.prototype.isEfkWgpuPackageLoaded;
  delete EffekseerContext.prototype.getEfkWgpuPackageGlobalFlags;
  delete EffekseerContext.prototype.getEfkWgpuMainEffectPath;
  delete EffekseerContext.prototype.loadMainEffectFromPackage;
  delete EffekseerContext.prototype.loadEffectFromPackage;
  delete EffekseerContext.prototype._buildEfkWgpuEntryMap;
  delete EffekseerContext.prototype._getEfkWgpuEntryBytes;

  return new Effekseer();
})();

if (typeof exports !== "undefined") {
  exports = effekseer;
}
