const GLOBAL_ERRORS = new Set(['auth', 'blocked', 'rate-limit', 'network', 'timeout']);
const PROGRESS_SAVE_INTERVAL = 2_000;
const MAX_EMPTY_PAGES = 5;
const MEDIA_START_TIMEOUT = 10_000;
const PLAYBACK_MODES = new Set(['order', 'shuffle', 'repeat-part']);

function emptyState() {
  return {
    items: [], order: [], cursor: -1, source: null, parts: [], partIndex: 0,
    position: 0, duration: 0, volume: 1, mode: 'order',
    status: 'idle', error: null, track: null,
  };
}

function shuffleOrder(indices) {
  const order = [...indices];
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

function issueMessage(error, fallback) {
  return error?.message || fallback;
}

// The HTMLAudioElement owns playback. This controller owns the source snapshot
// and resolves video parts and expiring audio URLs as they are needed.
export function createPlayer({ audio, loadParts, loadTracks, loadMore, storage, onState, onIssue }) {
  let state = emptyState();
  let controller;
  let activeMedia;
  let loadingTarget;
  let retryNavigation;
  let lastProgressSave = 0;
  let pendingSave;
  let saving;
  const partCache = new Map();

  const item = () => state.items[state.order[state.cursor]] ?? null;
  const part = () => state.parts[state.partIndex] ?? null;
  const hasMore = () => Boolean(loadMore && Number.isInteger(state.source?.nextPage));

  function publish() {
    onState?.({
      items: state.items, index: state.order[state.cursor] ?? -1, source: state.source,
      item: item(), parts: state.parts, partIndex: state.partIndex, part: part(),
      position: state.position, duration: state.duration, volume: state.volume,
      mode: state.mode, status: state.status,
      error: state.error, track: state.track,
      canPrevious: Boolean(item() && (state.partIndex > 0 || state.cursor > 0)),
      canNext: Boolean(item() && (
        state.partIndex + 1 < (state.parts.length || item().partCount || 1) ||
        state.cursor + 1 < state.order.length || hasMore()
      )),
    });
  }

  function save() {
    if (!storage?.save) return;
    lastProgressSave = Date.now();
    pendingSave = {
      items: state.items, order: state.order, cursor: state.cursor, source: state.source,
      parts: state.parts, partIndex: state.partIndex, position: state.position,
      volume: state.volume, shuffle: state.mode === 'shuffle',
      repeat: state.mode === 'repeat-part' ? 'part' : 'off',
    };
    if (!saving) {
      saving = Promise.resolve().then(async () => {
        while (pendingSave) {
          const snapshot = pendingSave;
          pendingSave = null;
          try {
            await storage.save(snapshot);
          } catch {
            // Playback can continue even if extension storage is unavailable.
          }
        }
        saving = null;
      });
    }
    return saving;
  }

  function updateDuration() {
    const nativeDuration = activeMedia && audio.duration;
    state.duration = Number.isFinite(nativeDuration) && nativeDuration > 0
      ? nativeDuration
      : Number(part()?.duration || (state.parts.length < 2 ? item()?.duration : 0)) || 0;
  }

  function sampleProgress() {
    if (activeMedia?.started && Number.isFinite(audio.currentTime)) {
      state.position = audio.currentTime;
    }
  }

  function stopMedia() {
    activeMedia = null;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }

  function begin() {
    controller?.abort();
    controller = new AbortController();
    loadingTarget = null;
    retryNavigation = null;
    stopMedia();
    return controller.signal;
  }

  function select(target, parts = []) {
    state.cursor = target.cursor;
    state.parts = parts;
    state.partIndex = target.partIndex < 0 ? Math.max(0, parts.length - 1) : target.partIndex;
    state.position = target.position ?? 0;
    state.track = null;
    state.error = null;
    state.status = 'loading';
    updateDuration();
    publish();
  }

  function showError(error, fallback) {
    state.status = 'error';
    state.error = issueMessage(error, fallback);
    onIssue?.(item(), state.error);
    publish();
    save();
  }

  async function appendPage(signal) {
    let emptyPages = 0;
    while (hasMore()) {
      const page = state.source.nextPage;
      const result = await loadMore(state.source, page, { signal });
      signal.throwIfAborted();
      const known = new Set(state.items.map(entry => entry.bvid));
      const added = [];
      for (const entry of result.items) {
        if (!entry?.bvid && entry?.unavailable) {
          added.push(entry);
        } else if (entry?.bvid && !known.has(entry.bvid)) {
          added.push(entry);
          known.add(entry.bvid);
        }
      }
      state.source = { ...state.source, nextPage: result.hasMore ? page + 1 : null };
      if (added.length) {
        const indices = added.map((_, index) => state.items.length + index);
        state.order = state.order.concat(state.mode === 'shuffle' ? shuffleOrder(indices) : indices);
        state.items = state.items.concat(added);
        save();
        return;
      }
      save();
      emptyPages += 1;
      if (emptyPages >= MAX_EMPTY_PAGES && hasMore()) {
        throw new Error('连续数页没有新视频。点击下一首可以继续读取。');
      }
    }
  }

  function adjacentPart(direction) {
    const partIndex = state.partIndex + direction;
    if (partIndex >= 0 && partIndex < state.parts.length) {
      return { cursor: state.cursor, partIndex, position: 0 };
    }
    return { cursor: state.cursor + direction, partIndex: direction > 0 ? 0 : -1, position: 0 };
  }

  async function partsFor(entry, signal) {
    if (entry.unavailable) {
      throw new Error(typeof entry.unavailable === 'string' ? entry.unavailable : '该视频已失效或不可播放');
    }
    const cached = partCache.get(entry.bvid);
    if (cached) return cached;
    const parts = await loadParts(entry.bvid, { signal });
    signal.throwIfAborted();
    if (!parts?.length) throw new Error('没有可播放的分 P');
    const ordered = [...parts].sort((left, right) => left.page - right.page);
    partCache.set(entry.bvid, ordered);
    return ordered;
  }

  function candidates(tracks) {
    const seen = new Set();
    const result = [];
    for (const { urls, ...track } of tracks) {
      const { mimeType, codecs } = track;
      const type = mimeType && (codecs ? `${mimeType}; codecs="${codecs}"` : mimeType);
      if (type && audio.canPlayType && !audio.canPlayType(type)) continue;
      for (const url of urls ?? []) {
        if (url && !seen.has(url)) {
          seen.add(url);
          result.push({ url, track });
        }
      }
    }
    return result;
  }

  async function loadCandidates(session, signal) {
    const tracks = await loadTracks(session.bvid, session.cid, { signal });
    signal.throwIfAborted();
    session.candidates = candidates(tracks ?? []);
    session.nextCandidate = 0;
    if (!session.candidates.length) throw new Error('没有可用的浏览器音轨');
  }

  function playWithDeadline(signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => settle(new Error('等待音频线路响应超时')), MEDIA_START_TIMEOUT);
      const abort = () => settle(signal.reason);
      const mediaError = () => {
        if (audio.error) settle(new Error('音频线路不可用'));
      };
      function settle(error) {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        audio.removeEventListener('error', mediaError);
        if (error) reject(error);
        else resolve();
      }
      signal.addEventListener('abort', abort, { once: true });
      audio.addEventListener('error', mediaError);
      try {
        Promise.resolve(audio.play()).then(() => settle(), settle);
      } catch (error) {
        settle(error);
      }
    });
  }

  async function tryMedia(session, signal) {
    while (true) {
      for (; session.nextCandidate < session.candidates.length;) {
        signal.throwIfAborted();
        const candidate = session.candidates[session.nextCandidate];
        session.nextCandidate += 1;
        stopMedia();
        audio.src = candidate.url;
        try {
          audio.currentTime = state.position;
        } catch {
          // Some engines only accept seeks after metadata arrives.
          audio.addEventListener('loadedmetadata', () => {
            if (!signal.aborted && audio.src === candidate.url) audio.currentTime = state.position;
          }, { once: true, signal });
        }
        try {
          await playWithDeadline(signal);
          signal.throwIfAborted();
        } catch (error) {
          signal.throwIfAborted();
          if (error?.name !== 'NotAllowedError') {
            stopMedia();
            continue;
          }
          activeMedia = { session, started: false };
          state.track = candidate.track;
          state.status = 'paused';
          state.error = '浏览器阻止了自动播放，请点击播放。';
          updateDuration();
          publish();
          save();
          return;
        }
        activeMedia = { session, started: true };
        state.track = candidate.track;
        state.status = 'playing';
        state.error = null;
        updateDuration();
        publish();
        save();
        return;
      }
      if (session.refreshed) throw new Error('音频线路播放失败，已尝试备用线路并刷新链接');
      session.refreshed = true;
      await loadCandidates(session, signal);
    }
  }

  async function walk(target, direction, signal, skipped = false) {
    while (target) {
      signal.throwIfAborted();
      loadingTarget = target;
      if (target.cursor >= state.order.length && hasMore()) {
        try {
          await appendPage(signal);
        } catch (error) {
          signal.throwIfAborted();
          retryNavigation = { target, direction };
          showError(error, '无法读取接下来的列表，请重试');
          return;
        }
      }
      if (target.cursor < 0 || target.cursor >= state.order.length) break;

      const entry = state.items[state.order[target.cursor]];
      const cached = partCache.get(entry.bvid);
      select(target, cached ?? (target.cursor === state.cursor ? state.parts : []));
      try {
        const parts = await partsFor(entry, signal);
        signal.throwIfAborted();
        if (target.nextPart && target.partIndex >= parts.length) {
          select({ ...target, partIndex: parts.length - 1 }, parts);
          target = adjacentPart(direction);
          continue;
        }
        const byCid = target.cid == null ? -1 : parts.findIndex(candidate => String(candidate.cid) === String(target.cid));
        const partIndex = byCid >= 0 ? byCid : target.partIndex < 0
          ? parts.length - 1
          : Math.min(target.partIndex, parts.length - 1);
        select({ ...target, partIndex }, parts);
      } catch (error) {
        signal.throwIfAborted();
        if (GLOBAL_ERRORS.has(error.code)) {
          retryNavigation = { target, direction };
          showError(error, '无法载入视频，请重试');
          return;
        }
        skipped = true;
        onIssue?.(entry, issueMessage(error, '无法读取视频分 P'));
        target = { cursor: target.cursor + direction, partIndex: direction > 0 ? 0 : -1, position: 0 };
        continue;
      }

      const { cid } = part();
      const session = { bvid: entry.bvid, cid, refreshed: false };
      try {
        await loadCandidates(session, signal);
        await tryMedia(session, signal);
        return;
      } catch (error) {
        signal.throwIfAborted();
        if (GLOBAL_ERRORS.has(error.code)) {
          showError(error, '无法载入音轨，请重试');
          return;
        }
        skipped = true;
        onIssue?.(entry, issueMessage(error, '音轨无法播放'));
        target = adjacentPart(direction);
      }
    }
    state.status = skipped ? 'error' : 'ended';
    state.error = skipped ? '未找到可继续播放的音频' : null;
    publish();
    save();
  }

  async function run(operation, signal) {
    try {
      await operation();
    } catch (error) {
      if (!signal.aborted) showError(error, '播放失败，请重试');
    } finally {
      if (!signal.aborted) loadingTarget = null;
    }
  }

  function playTarget(target, direction = 1) {
    const signal = begin();
    state.status = 'loading';
    state.error = null;
    publish();
    return run(() => walk(target, direction, signal), signal);
  }

  function move(direction, automatic = false) {
    if (!item()) return;
    sampleProgress();
    if (direction > 0 && !automatic && !state.parts.length && !item().unavailable &&
        (item().partCount == null || item().partCount > state.partIndex + 1)) {
      return playTarget({ cursor: state.cursor, partIndex: state.partIndex + 1, position: 0, nextPart: true });
    }
    const target = automatic && state.mode === 'repeat-part'
      ? { cursor: state.cursor, partIndex: state.partIndex, position: 0 }
      : adjacentPart(direction);
    const known = target.cursor >= 0 && target.cursor < state.order.length;
    if (automatic || known || (direction > 0 && hasMore())) {
      return playTarget(target, direction);
    }
  }

  function recoverMedia() {
    if (!activeMedia || !audio.error || state.status !== 'playing') return;
    sampleProgress();
    const { session } = activeMedia;
    const signal = begin();
    state.track = null;
    state.status = 'loading';
    publish();
    return run(async () => {
      try {
        await tryMedia(session, signal);
      } catch (error) {
        signal.throwIfAborted();
        if (GLOBAL_ERRORS.has(error.code)) {
          showError(error, '无法重新载入音轨，请重试');
          return;
        }
        onIssue?.(item(), issueMessage(error, '音轨播放失败'));
        await walk(adjacentPart(1), 1, signal, true);
      }
    }, signal);
  }

  function restore(saved) {
    if (!saved || !Array.isArray(saved.items) || !saved.items.length) return;
    const indices = saved.items.map((_, index) => index);
    const validOrder = Array.isArray(saved.order) && new Set(saved.order).size === indices.length &&
      saved.order.length === indices.length && saved.order.every(index =>
        Number.isInteger(index) && index >= 0 && index < indices.length);
    state.items = saved.items;
    state.order = validOrder ? saved.order : indices;
    state.cursor = Number.isInteger(saved.cursor) ? Math.max(0, Math.min(saved.cursor, state.order.length - 1)) : 0;
    state.source = saved.source ?? null;
    state.parts = Array.isArray(saved.parts) ? saved.parts : [];
    state.partIndex = Number.isInteger(saved.partIndex) ? Math.max(0, saved.partIndex) : 0;
    state.position = Number.isFinite(saved.position) ? Math.max(0, saved.position) : 0;
    state.status = 'paused';
    updateDuration();
  }

  async function initialize() {
    const activeController = controller;
    let saved;
    try {
      saved = await storage?.load();
    } catch {
      // An invalid or unavailable snapshot should not keep the player from opening.
    }
    if (activeController !== controller) return;
    if (saved) {
      state.mode = saved.repeat === 'part' ? 'repeat-part' : saved.shuffle ? 'shuffle' : 'order';
      state.volume = Number.isFinite(saved.volume) ? Math.max(0, Math.min(1, saved.volume)) : 1;
      restore(saved);
    }
    audio.volume = state.volume;
    publish();
  }

  async function reset() {
    sampleProgress();
    const flushed = save();
    begin();
    state = emptyState();
    partCache.clear();
    publish();
    await flushed;
  }

  function start(items, index, source) {
    if (!items[index]?.bvid) return;
    const indices = items.map((_, position) => position);
    state.items = [...items];
    state.source = source ? { ...source } : null;
    const shuffle = state.mode === 'shuffle';
    state.order = shuffle ? [index, ...shuffleOrder(indices.filter(position => position !== index))] : indices;
    state.cursor = shuffle ? 0 : index;
    state.parts = [];
    state.partIndex = 0;
    state.position = 0;
    state.duration = 0;
    state.track = null;
    return playTarget({ cursor: state.cursor, partIndex: 0, position: 0 });
  }

  async function toggle() {
    if (state.status === 'loading') {
      const pending = loadingTarget;
      if (pending?.cursor === state.cursor) {
        state.partIndex = Math.max(0, pending.partIndex);
        state.position = pending.position ?? 0;
      }
      begin();
      state.status = 'paused';
      publish();
      save();
      return;
    }
    if (state.status === 'playing') {
      sampleProgress();
      state.status = 'paused';
      audio.pause();
      publish();
      save();
      return;
    }
    if (retryNavigation) {
      const { target, direction } = retryNavigation;
      return playTarget(target, direction);
    }
    if (!item()) return;
    if (activeMedia && !audio.error && !audio.ended) {
      const beforePlay = activeMedia;
      const signal = controller.signal;
      state.status = 'loading';
      publish();
      try {
        await playWithDeadline(signal);
        if (activeMedia !== beforePlay) return;
        activeMedia.started = true;
        state.status = 'playing';
        state.error = null;
        publish();
        save();
        return;
      } catch (error) {
        if (activeMedia !== beforePlay) return;
        if (error?.name === 'NotAllowedError') {
          state.status = 'paused';
          state.error = '浏览器阻止了播放，请再次点击播放。';
          publish();
          return;
        }
      }
    }
    const position = state.status === 'ended' || (state.duration > 0 && state.position >= state.duration)
      ? 0
      : state.position;
    return playTarget({ cursor: state.cursor, partIndex: state.partIndex, cid: part()?.cid, position });
  }

  function seek(seconds) {
    if (!item() || !Number.isFinite(seconds) || state.status === 'loading') return;
    const position = Math.max(0, state.duration ? Math.min(state.duration, seconds) : seconds);
    if (activeMedia) audio.currentTime = position;
    state.position = position;
    publish();
    save();
  }

  function setVolume(value) {
    if (!Number.isFinite(value)) return;
    state.volume = Math.max(0, Math.min(1, value));
    audio.volume = state.volume;
    publish();
    save();
  }

  function setMode(mode) {
    if (!PLAYBACK_MODES.has(mode) || mode === state.mode) return;
    sampleProgress();
    state.mode = mode;
    const end = state.cursor + 1;
    const tail = state.order.slice(end);
    state.order = state.order.slice(0, end).concat(
      mode === 'shuffle' ? shuffleOrder(tail) : tail.sort((left, right) => left - right),
    );
    publish();
    save();
  }

  audio.addEventListener('ended', () => {
    if (activeMedia && audio.ended) void move(1, true);
  });
  audio.addEventListener('error', () => { void recoverMedia(); });
  audio.addEventListener('durationchange', () => {
    if (!activeMedia) return;
    updateDuration();
    publish();
  });
  audio.addEventListener('pause', () => {
    if (!activeMedia || !audio.paused || audio.ended || audio.error || state.status !== 'playing') return;
    sampleProgress();
    state.status = 'paused';
    publish();
    save();
  });
  audio.addEventListener('timeupdate', () => {
    if (!activeMedia?.started) return;
    sampleProgress();
    publish();
    if (Date.now() - lastProgressSave >= PROGRESS_SAVE_INTERVAL) save();
  });
  globalThis.addEventListener?.('pagehide', () => {
    if (!item()) return;
    sampleProgress();
    save();
  });

  return {
    initialize, reset, start, toggle, next: () => move(1), previous: () => move(-1),
    seek, setVolume, setMode,
  };
}
