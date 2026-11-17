/* Service worker: authorizes download actions and keeps their recovery handles. */
(() => {
  const OFFSCREEN_PATH = "src/download-offscreen.html";
  const pendingKey = tabId => `bili-audio-pending-${tabId}`;
  const trackingKey = jobId => `bili-audio-saving-${jobId}`;
  const active = new Map();
  let creatingOffscreen;

  function getPlayerTab(sender) {
    const tabId = sender.tab?.id;
    if (sender.id !== chrome.runtime.id || !Number.isInteger(tabId) || tabId < 0) return null;
    try {
      const url = new URL(sender.url);
      if (url.protocol === "chrome-extension:" && url.hostname === chrome.runtime.id &&
          url.pathname === "/index.html" && sender.frameId === 0) return tabId;
    } catch {
      // Messages from outside the player may be missing a URL.
    }
    return null;
  }

  function selectUrls(values, isAllowedHost) {
    const accepted = new Set();
    for (const value of values) {
      if (typeof value !== "string") continue;
      try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password || !isAllowedHost(url.hostname)) continue;
        url.hash = "";
        accepted.add(url.href);
      } catch {
        // An invalid fallback must not prevent trying the other URLs.
      }
    }
    return [...accepted];
  }

  function filenamePart(value) {
    const sanitized = value.replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/[“”‘’「」『』〈〉《》【】（），、。！？；：·…—–!?,.;'\[\](){}]/g, "")
      .replace(/\s+/g, " ").replace(/_{2,}/g, "_").replace(/^[_\s]+|[_\s]+$/g, "");
    return Array.from(sanitized).slice(0, 60).join("").trimEnd();
  }

  function readJob(message) {
    const songName = typeof message.songName === "string" ? message.songName.trim() : "";
    const artist = typeof message.artist === "string" ? message.artist.trim() : "";
    if (!songName) throw new Error("请填写歌曲名。");
    if (songName.length > 200 || artist.length > 200) throw new Error("歌曲名和歌手最多可填写 200 个字符。");

    const audioUrls = selectUrls(Array.isArray(message.audioUrls) ? message.audioUrls : [], host =>
      host === "bilivideo.com" || host.endsWith(".bilivideo.com") ||
      host === "bilivideo.cn" || host.endsWith(".bilivideo.cn"),
    );
    if (!audioUrls.length) throw new Error("找不到当前分 P 的 B 站音频地址。");
    const covers = [...(Array.isArray(message.coverUrls) ? message.coverUrls : []), message.coverUrl];
    const coverUrls = selectUrls(covers, host => /^i[0-2]\.hdslb\.com$/.test(host));
    const base = [filenamePart(songName), filenamePart(artist)].filter(Boolean).join("_") || "bilibili_audio";
    const reserved = /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/i.test(base);
    const filename = `${reserved ? "_" : ""}${base}.m4a`;
    return {
      id: crypto.randomUUID(),
      songName,
      artist,
      filename,
      audioUrls,
      coverUrls,
      embedMeta: message.embedMeta !== false,
      includeCover: message.includeCover === true,
    };
  }

  async function ensureOffscreen() {
    if (!creatingOffscreen) {
      creatingOffscreen = (async () => {
        const contexts = await chrome.runtime.getContexts({
          contextTypes: ["OFFSCREEN_DOCUMENT"],
          documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
        });
        if (!contexts.length) {
          await chrome.offscreen.createDocument({
            url: OFFSCREEN_PATH,
            reasons: ["BLOBS"],
            justification: "本地写入 B 站音频的歌曲信息和封面，并保存音频文件",
          });
        }
      })().finally(() => { creatingOffscreen = undefined; });
    }
    await creatingOffscreen;
  }

  function checkCanceled(action) {
    if (action.canceled) throw new Error("已取消下载。");
  }

  async function audioMessage(message, action) {
    await ensureOffscreen();
    checkCanceled(action);
    const response = await chrome.runtime.sendMessage({ target: "audio-offscreen", ...message });
    checkCanceled(action);
    if (!response?.ok) throw new Error(response?.error || "无法处理音频下载。");
    return response;
  }

  async function releaseJob(jobId) {
    if (!jobId) return;
    await chrome.runtime.sendMessage({ target: "audio-offscreen", type: "RELEASE", jobId }).catch(() => {});
  }

  async function getPending(tabId) {
    const key = pendingKey(tabId);
    const pending = (await chrome.storage.session.get(key))[key];
    if (!pending) return null;
    if (Date.now() < pending.expiresAt) return pending;
    await chrome.storage.session.remove(key);
    await releaseJob(pending.jobId);
    return null;
  }

  function expired() {
    return { ok: false, code: "expired", error: "音频缓存已过期，请重新开始下载。" };
  }

  async function clearFinishedDownloads() {
    const state = await chrome.storage.session.get(null);
    for (const [key, job] of Object.entries(state)) {
      if (!key.startsWith("bili-audio-saving-")) continue;
      const results = await Promise.all(job.ids.map(id => chrome.downloads.search({ id })));
      if (results.some(([item]) => item?.state === "in_progress")) continue;
      await releaseJob(job.jobId);
      await chrome.storage.session.remove(key);
    }
  }

  async function submitDownload(url, filename) {
    const id = await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: "uniquify" });
    if (!Number.isInteger(id)) throw new Error("浏览器未接受下载任务。");
    return id;
  }

  async function saveFile(tabId, pending, prepared, action) {
    checkCanceled(action);
    const key = pendingKey(tabId);
    const recovery = {
      ...pending,
      status: "needs-recovery",
      expiresAt: prepared.expiresAt,
      canSaveOriginal: prepared.needsChoice === true,
      error: prepared.error || "浏览器尚未接受下载，请重试。",
    };
    await chrome.storage.session.set({ [key]: recovery });
    if (action.canceled) {
      await chrome.storage.session.remove(key);
      checkCanceled(action);
    }
    if (prepared.needsChoice) return { ok: true, ...recovery };

    // Once handed to Chromium, closing the player should not cancel the file.
    action.committing = true;
    let audioId;
    try {
      audioId = await submitDownload(prepared.audioUrl, pending.filename);
    } catch (error) {
      action.committing = false;
      if (action.canceled) {
        await chrome.storage.session.remove(key);
        await releaseJob(pending.jobId);
        checkCanceled(action);
      }
      const blocked = { ...recovery, error: `提交下载失败：${error.message || error}。` };
      await chrome.storage.session.set({ [key]: blocked });
      return { ok: true, ...blocked };
    }

    const ids = [audioId];
    let coverStatus = pending.includeCover ? "failed" : "not-requested";
    let coverError = prepared.coverError;
    if (prepared.coverUrl) {
      const filename = pending.filename.replace(/\.m4a$/i, `_cover.${prepared.coverExt}`);
      try {
        ids.push(await submitDownload(prepared.coverUrl, filename));
        coverStatus = "submitted";
      } catch (error) {
        coverError = error.message || String(error);
      }
    }
    await chrome.storage.session.set({ [trackingKey(pending.jobId)]: { jobId: pending.jobId, ids } });
    await chrome.storage.session.remove(key);
    await clearFinishedDownloads().catch(() => {});

    const [download] = await chrome.downloads.search({ id: audioId }).catch(() => []);
    if (download?.state === "interrupted") {
      return { ok: false, error: "音频下载已中断，请在浏览器的下载记录中查看。" };
    }
    return {
      ok: true,
      status: download?.state === "complete" ? "complete" : "submitted",
      jobId: pending.jobId,
      filename: pending.filename,
      embedded: prepared.embedded,
      canSaveOriginal: false,
      coverStatus,
      ...(coverError ? { coverError } : {}),
    };
  }

  async function start(tabId, message, action) {
    const job = readJob(message);
    action.jobId = job.id;
    const previous = await getPending(tabId);
    if (previous) {
      await chrome.storage.session.remove(pendingKey(tabId));
      await releaseJob(previous.jobId);
    }
    checkCanceled(action);
    try {
      const prepared = await audioMessage({ type: "PREPARE", job }, action);
      return await saveFile(tabId, { jobId: job.id, filename: job.filename, includeCover: job.includeCover }, prepared, action);
    } catch (error) {
      if (!action.committing) await releaseJob(job.id);
      throw error;
    }
  }

  async function recover(tabId, message, action) {
    const pending = await getPending(tabId);
    checkCanceled(action);
    if (!pending || pending.jobId !== message.jobId) return expired();
    action.jobId = pending.jobId;
    if (message.original === true && !pending.canSaveOriginal) {
      return { ok: false, error: "已处理的文件可以重试保存。" };
    }
    const prepared = await audioMessage({ type: "RECOVER", jobId: pending.jobId, original: message.original === true }, action);
    if (prepared.expired) {
      await chrome.storage.session.remove(pendingKey(tabId));
      return expired();
    }
    return saveFile(tabId, pending, prepared, action);
  }

  async function runForTab(tabId, operation) {
    if (active.has(tabId)) throw new Error("此页面已有正在处理的下载。");
    const action = {};
    active.set(tabId, action);
    try {
      return await operation(action);
    } finally {
      active.delete(tabId);
    }
  }

  async function releasePending(tabId, jobId) {
    const action = active.get(tabId);
    if (action && (!jobId || action.jobId === jobId)) {
      action.canceled = true;
      if (action.committing) return { ok: true, status: "committed" };
      await releaseJob(action.jobId);
    }
    const pending = await getPending(tabId);
    if (pending && (!jobId || pending.jobId === jobId)) {
      await chrome.storage.session.remove(pendingKey(tabId));
      await releaseJob(pending.jobId);
    }
    return { ok: true, status: "released" };
  }

  async function dispatch(tabId, message) {
    switch (message.type) {
      case "START_AUDIO_DOWNLOAD":
        return runForTab(tabId, action => start(tabId, message, action));
      case "RECOVER_AUDIO_DOWNLOAD":
        return runForTab(tabId, action => recover(tabId, message, action));
      case "RELEASE_AUDIO_DOWNLOAD":
        return releasePending(tabId, message.jobId);
      default:
        return { ok: false, error: "未知下载请求。" };
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.target !== "download-jobs") return;
    const tabId = getPlayerTab(sender);
    if (tabId === null) {
      respond({ ok: false, error: "请从 B 站文字播放器发起下载。" });
      return;
    }
    dispatch(tabId, message).then(
      respond,
      error => respond({ ok: false, error: error.message }),
    );
    return true;
  });

  chrome.downloads.onChanged.addListener(delta => {
    if (delta.state) void clearFinishedDownloads().catch(() => {});
  });
  chrome.tabs.onRemoved.addListener(tabId => {
    void releasePending(tabId).catch(() => {});
  });
})();
