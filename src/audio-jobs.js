/* The offscreen document owns audio bytes and Blob URLs across dialog closes. */
(() => {
  const jobs = new Map();
  const AUDIO_LIMIT = 256 * 1024 * 1024;
  const COVER_LIMIT = 12 * 1024 * 1024;
  const CACHE_DURATION = 15 * 60 * 1000;
  let busy = false;

  async function readBytes(url, limit, signal) {
    const response = await fetch(url, {
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal,
    });
    if (!response.ok) throw new Error(`获取资源失败（HTTP ${response.status}）`);
    if (!response.body) throw new Error("B 站没有返回文件内容");
    if (Number(response.headers.get("content-length")) > limit) {
      throw new Error("文件超过本地处理大小限制");
    }

    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) throw new Error("文件超过本地处理大小限制");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }

  async function readCandidate(urls, limit, timeoutMs, signal, validate) {
    if (!urls.length) throw new Error("没有可用的资源地址");
    const deadline = AbortSignal.timeout(timeoutMs);
    const requestSignal = AbortSignal.any([signal, deadline]);
    let lastError;
    for (const url of urls) {
      try {
        return await validate(await readBytes(url, limit, requestSignal));
      } catch (error) {
        signal.throwIfAborted();
        if (deadline.aborted) throw new Error("获取文件超时，请重试");
        lastError = error;
      }
    }
    throw lastError;
  }

  function validateAudio(bytes) {
    if (bytes.length < 64 || String.fromCharCode(...bytes.subarray(4, 8)) !== "ftyp") {
      throw new Error("获取到的内容不是 M4A 音频");
    }
    return bytes;
  }

  async function normalizeCover(bytes) {
    try {
      BiliMetadata.imageType(bytes);
      return bytes;
    } catch {
      // Common music players expect JPEG or PNG in the cover atom.
      const bitmap = await createImageBitmap(new Blob([bytes]));
      try {
        const ratio = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
        const width = Math.max(1, Math.round(bitmap.width * ratio));
        const height = Math.max(1, Math.round(bitmap.height * ratio));
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext("2d");
        context.fillStyle = "#fff";
        context.fillRect(0, 0, width, height);
        context.drawImage(bitmap, 0, 0, width, height);
        const image = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
        return new Uint8Array(await image.arrayBuffer());
      } finally {
        bitmap.close();
      }
    }
  }

  async function loadCover(job) {
    if (!job.cover) {
      if (!job.coverUrls.length) throw new Error("找不到该视频的封面");
      job.cover = await readCandidate(job.coverUrls, COVER_LIMIT, 30_000, job.abort.signal, normalizeCover);
    }
    return job.cover;
  }

  function releaseJob(jobId) {
    const job = jobs.get(jobId);
    if (!job) return;
    jobs.delete(jobId);
    clearTimeout(job.timer);
    job.abort.abort(new Error("已取消下载"));
    for (const url of job.urls) URL.revokeObjectURL(url);
  }

  function createUrl(job, blob) {
    const url = URL.createObjectURL(blob);
    job.urls.push(url);
    return url;
  }

  async function prepareFile(job, original) {
    if (job.result) return job.result;
    const embedded = job.embedMeta && !original;
    let audio;
    if (embedded) {
      try {
        audio = BiliMetadata.embed(job.audio, {
          title: job.songName,
          artist: job.artist,
          cover: await loadCover(job),
        });
      } catch (error) {
        job.abort.signal.throwIfAborted();
        return {
          expiresAt: job.expiresAt,
          needsChoice: true,
          error: `无法嵌入歌曲信息或封面：${error.message}。可重试或保存原始音频。`,
        };
      }
    } else {
      audio = new Blob([job.audio], { type: "audio/mp4" });
    }

    let coverUrl = "";
    let coverExt = "";
    let coverError = "";
    if (job.includeCover) {
      try {
        const cover = await loadCover(job);
        coverExt = BiliMetadata.imageType(cover) === 14 ? "png" : "jpg";
        const mime = coverExt === "png" ? "image/png" : "image/jpeg";
        coverUrl = createUrl(job, new Blob([cover], { type: mime }));
      } catch (error) {
        job.abort.signal.throwIfAborted();
        coverError = error.message;
      }
    }
    job.abort.signal.throwIfAborted();
    job.result = {
      expiresAt: job.expiresAt,
      audioUrl: createUrl(job, audio),
      embedded,
      coverUrl,
      coverExt,
      coverError,
    };
    job.audio = null;
    job.cover = null;
    return job.result;
  }

  async function processJob(message) {
    if (busy) throw new Error("另一首歌曲正在处理，请稍后重试");
    busy = true;
    try {
      if (message.type === "RECOVER") {
        const job = jobs.get(message.jobId);
        if (!job) return { expired: true };
        return await prepareFile(job, message.original === true);
      }
      if (message.type !== "PREPARE") throw new Error("未知音频处理请求");
      if (jobs.size >= 3) throw new Error("有 3 个未释放的下载，请完成或取消后重试");
      const job = {
        ...message.job,
        abort: new AbortController(),
        urls: [],
        expiresAt: Date.now() + CACHE_DURATION,
      };
      job.timer = setTimeout(() => releaseJob(job.id), CACHE_DURATION);
      jobs.set(job.id, job);
      try {
        job.audio = await readCandidate(job.audioUrls, AUDIO_LIMIT, 120_000, job.abort.signal, validateAudio);
        return await prepareFile(job, false);
      } catch (error) {
        releaseJob(job.id);
        throw error;
      }
    } finally {
      busy = false;
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.target !== "audio-offscreen" || sender.id !== chrome.runtime.id) return;
    if (message.type === "RELEASE") {
      releaseJob(message.jobId);
      respond({ ok: true });
      return;
    }
    processJob(message).then(
      result => respond({ ok: true, ...result }),
      error => respond({ ok: false, error: error.message }),
    );
    return true;
  });
})();
