export function createDownloadDialog({ loadTracks, save, release }) {
  const element = (id) => document.getElementById(id);
  const dialog = element("download-dialog");
  const form = element("download-form");
  const fields = element("download-fields");
  const songTitle = element("download-song-title");
  const artist = element("download-artist");
  const quality = element("download-quality");
  const embed = element("download-embed");
  const cover = element("download-cover");
  const status = element("download-status");
  const progress = element("download-progress");
  const cancel = element("download-cancel");
  const retryTracks = element("download-retry-tracks");
  const original = element("download-original");
  const submit = element("download-submit");
  let current;

  function showStatus(message = "", isError = false) {
    if (status.textContent !== message) status.textContent = message;
    status.dataset.error = String(isError);
  }

  function render(session) {
    const saving = session.phase === "saving";
    const complete = session.phase === "complete";
    const loadFailed = session.phase === "load-error";
    const saveFailed = session.phase === "save-error";
    fields.disabled = saving || complete;
    quality.disabled = !session.tracks.length;
    cancel.disabled = saving;
    cancel.textContent = complete ? "关闭" : "取消";
    retryTracks.hidden = !loadFailed;
    original.hidden = !saveFailed || !session.canSaveOriginal;
    submit.hidden = loadFailed || complete;
    submit.disabled = !session.tracks.length || saving;
    submit.textContent = saveFailed ? "重试" : "下载";
    progress.hidden = !saving && session.phase !== "loading";
  }

  function releaseJob(session, jobId) {
    if (!jobId || !release) return;
    void Promise.resolve().then(() => release(session.snapshot, jobId)).catch(() => {
      // Retained jobs also have a backend cleanup deadline.
    });
  }

  function discardPendingJob(session) {
    releaseJob(session, session.pendingJobId);
    session.pendingJobId = undefined;
    session.canSaveOriginal = false;
  }

  function dispose() {
    const session = current;
    if (!session) return;
    current = undefined;
    session.controller?.abort();
    discardPendingJob(session);
  }

  function close() {
    if (current?.phase === "saving") return;
    dispose();
    dialog.close();
  }

  async function loadChoices(session) {
    const controller = new AbortController();
    session.controller = controller;
    session.phase = "loading";
    render(session);
    showStatus("正在读取可用音质…");

    try {
      const tracks = await loadTracks(session.snapshot, { signal: controller.signal });
      if (session !== current || controller.signal.aborted) return;
      if (!Array.isArray(tracks) || !tracks.length) {
        throw new Error("当前分 P 暂无可下载的独立音轨。");
      }

      session.tracks = tracks;
      quality.replaceChildren(...tracks.map((track, index) => {
        const label = track.label || track.quality || "音频";
        return new Option(index === 0 ? `${label}（最高）` : label, String(index));
      }));
      quality.selectedIndex = 0;
      session.phase = "ready";
      showStatus();
    } catch (error) {
      if (session !== current || controller.signal.aborted) return;
      session.phase = "load-error";
      showStatus(error?.message || "读取音质失败，请重试。", true);
    } finally {
      if (session === current) {
        session.controller = undefined;
        render(session);
      }
    }
  }

  async function saveAudio(saveOriginal = false) {
    const session = current;
    if (!session || (session.phase !== "ready" && session.phase !== "save-error")) return;

    const title = songTitle.value.trim();
    if (!title) {
      songTitle.setCustomValidity("请填写歌曲名。");
      songTitle.reportValidity();
      return;
    }
    if (!form.reportValidity()) return;
    const track = session.tracks[quality.selectedIndex];
    if (!track) return;

    const controller = new AbortController();
    const pendingJobId = session.pendingJobId;
    session.controller = controller;
    session.phase = "saving";
    render(session);
    showStatus("正在准备下载…");

    try {
      const result = await save(session.snapshot, {
        title,
        artist: artist.value.trim(),
        track,
        embedMetadata: !saveOriginal && embed.checked,
        saveCover: cover.checked,
        pendingJobId,
        saveOriginal,
        signal: controller.signal,
        onProgress({ message } = {}) {
          if (session === current && session.phase === "saving" && message) showStatus(message);
        },
      });
      if (session !== current) return;
      session.pendingJobId = undefined;
      session.canSaveOriginal = false;
      session.phase = "complete";
      showStatus(result?.message || "已提交浏览器下载。");
    } catch (error) {
      const jobId = error?.jobId;
      if (session !== current) {
        releaseJob(session, jobId);
        return;
      }

      if (pendingJobId !== jobId) releaseJob(session, pendingJobId);
      session.pendingJobId = jobId;
      session.canSaveOriginal = Boolean(error?.canSaveOriginal || error?.code === "embed-failed");
      session.phase = "save-error";
      showStatus(error?.message || "下载失败，请重试。", true);
    } finally {
      if (session === current) {
        session.controller = undefined;
        render(session);
        (session.phase === "complete" ? cancel : submit).focus({ preventScroll: true });
      }
    }
  }

  fields.addEventListener("input", (event) => {
    if (event.target === songTitle) songTitle.setCustomValidity("");
    if (current?.phase !== "save-error") return;
    discardPendingJob(current);
    current.phase = "ready";
    showStatus();
    render(current);
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveAudio();
  });
  retryTracks.addEventListener("click", () => {
    if (current?.phase === "load-error") void loadChoices(current);
  });
  original.addEventListener("click", () => {
    if (current?.canSaveOriginal) void saveAudio(true);
  });
  cancel.addEventListener("click", close);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("close", () => {
    if (!dialog.open) dispose();
  });

  return {
    open(snapshot) {
      if (!snapshot || dialog.open) return;
      dispose();
      current = { snapshot, tracks: [] };
      songTitle.value = snapshot.title || "";
      songTitle.setCustomValidity("");
      artist.value = snapshot.artist || "";
      quality.replaceChildren();
      embed.checked = true;
      cover.checked = false;
      dialog.showModal();
      void loadChoices(current);
    },
  };
}
