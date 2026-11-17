import {
  getAudioTracks,
  getFavoriteFolders,
  getFavoritePage,
  getSession,
  getUploaderVideos,
  getVideoCover,
  getVideoParts,
  searchVideos,
} from "./bili-api.js";
import { createDownloadDialog } from "./download-dialog.js";
import { createMediaSession } from "./media-session.js";
import { createPlayer } from "./player.js";

const element = (id) => document.getElementById(id);
const ui = {
  searchForm: element("search-form"),
  searchInput: element("search-input"),
  accountAvatar: element("account-avatar"),
  accountName: element("account-name"),
  loginLink: element("login-link"),
  refreshSession: element("refresh-session"),
  favoritesMessage: element("favorites-message"),
  folderList: element("favorite-folders"),
  content: element("main-content"),
  listTitle: element("list-title"),
  listMeta: element("list-meta"),
  listMessage: element("list-message"),
  trackList: element("track-list"),
  trackRows: element("track-rows"),
  folderSearchForm: element("folder-search-form"),
  folderSearchInput: element("folder-search-input"),
  folderSearchClear: element("folder-search-clear"),
  listPagination: element("list-pagination"),
  pageControls: element("page-controls"),
  pagePrevious: element("page-previous"),
  pageNumbers: element("page-numbers"),
  pageNext: element("page-next"),
  pageJump: element("page-jump"),
  pageInput: element("page-input"),
  pageRetry: element("page-retry"),
  nowCover: element("now-cover"),
  openCurrentVideo: element("open-current-video"),
  nowTitle: element("now-title"),
  nowDetail: element("now-detail"),
  playerMessage: element("player-message"),
  positionText: element("position-text"),
  durationText: element("duration-text"),
  seek: element("seek"),
  previous: element("previous"),
  play: element("play"),
  next: element("next"),
  downloadAudio: element("download-audio"),
  playMode: element("play-mode"),
  volume: element("volume"),
};

const listBack = document.createElement("button");
listBack.type = "button";
listBack.className = "quiet-button list-back";
listBack.textContent = "返回列表";
listBack.hidden = true;
ui.listTitle.parentElement.before(listBack);

const issues = new Map();
const visibleRows = new Map();
const playModes = ["order", "shuffle", "repeat-part"];
const playModeLabels = { order: "顺序播放", shuffle: "随机播放", "repeat-part": "单曲循环" };
const nativePageSize = 20;
const listingPageSize = 100;
const batchesPerPage = listingPageSize / nativePageSize;

let accountId;
let accountName = "";
let accountAvatar = "";
let accountBusy = false;
let accountChanging = false;
let needsLogin = false;
let needsSiteVisit = false;
let favoritesMessage = "正在读取登录状态…";
let folders = [];
let listing = null;
let folderSearchTimer = null;
let highlightedRow = null;
let playerState = null;
let playerReady = false;
let seekPreview = null;
let coverBvid = "";
let coverRequest;

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function setControlLabel(button, label) {
  if (button.title === label && button.getAttribute("aria-label") === label) return;
  button.title = label;
  button.setAttribute("aria-label", label);
}

function nextPlayMode(mode) {
  return playModes[(playModes.indexOf(mode) + 1) % playModes.length];
}

function errorMessage(error, fallback) {
  return error?.message || fallback;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";

  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const remainder = String(total % 60).padStart(2, "0");

  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${remainder}`;
  return `${minutes}:${remainder}`;
}

function sameSource(left, right) {
  return Boolean(left && right
    && left.type === right.type
    && left.id === right.id
    && (left.keyword || "") === (right.keyword || "")
    && left.accountId === right.accountId);
}

function storageKey() {
  return accountId === undefined ? null : `player:${accountId ?? "guest"}`;
}

function renderAccount() {
  let label = accountName || "已登录";
  if (accountBusy) label = "正在刷新…";
  else if (needsLogin || accountId === null) label = "未登录";
  else if (accountId === undefined) label = "登录状态未确认";

  setText(ui.accountName, label);
  ui.accountName.title = label;
  const avatar = accountId && !needsLogin ? accountAvatar : "";
  if (ui.accountAvatar.getAttribute("src") !== (avatar || null)) {
    ui.accountAvatar.hidden = true;
    if (avatar) ui.accountAvatar.src = avatar;
    else ui.accountAvatar.removeAttribute("src");
  }
  ui.loginLink.hidden = Boolean(accountId) && !needsLogin && !needsSiteVisit;
  setText(ui.loginLink, needsSiteVisit && !needsLogin ? "打开 B 站" : "去 B 站登录");
  ui.refreshSession.disabled = accountBusy;
  setText(ui.favoritesMessage, favoritesMessage);
  ui.favoritesMessage.hidden = !favoritesMessage;
}

function handleSiteAccess(error) {
  if (error?.code === "auth") {
    needsLogin = true;
    renderAccount();
  } else if (error?.code === "blocked") {
    needsSiteVisit = true;
    renderAccount();
  }
}

async function withSiteAccess(promise) {
  try {
    return await promise;
  } catch (error) {
    handleSiteAccess(error);
    throw error;
  }
}

function markSelectedFolder() {
  const id = listing?.source.type === "favorite" ? listing.source.id : null;
  for (const button of ui.folderList.querySelectorAll("button")) {
    if (button.dataset.folderId === id) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  }
}

function renderFolders() {
  const fragment = document.createDocumentFragment();
  for (const folder of folders) {
    const row = document.createElement("li");
    const label = document.createElement("span");
    const button = document.createElement("button");
    const id = String(folder.id);

    button.type = "button";
    button.className = "folder-button";
    button.dataset.folderId = id;
    button.title = folder.title;
    label.textContent = folder.title;
    button.append(label);

    if (Number.isFinite(folder.count)) {
      const count = document.createElement("span");
      count.className = "folder-count";
      count.textContent = String(folder.count);
      button.append(count);
    }

    button.addEventListener("click", () => {
      if (accountChanging) return;
      selectListing(favoriteSource(folder), { totalItems: folder.count ?? null });
    });
    row.append(button);
    fragment.append(row);
  }
  ui.folderList.replaceChildren(fragment);
  markSelectedFolder();
}

function favoriteSource(folder, keyword = "") {
  return {
    type: "favorite",
    id: String(folder.id),
    title: folder.title,
    accountId,
    keyword,
  };
}

function pageLimit(list) {
  if (list.lastPage !== null) return list.lastPage;
  const estimated = list.totalNativePages !== null
    ? Math.ceil(list.totalNativePages / batchesPerPage)
    : Math.ceil((list.totalItems ?? 0) / listingPageSize);
  return Math.max(list.availablePages, estimated);
}

function pageButton(page, current) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "quiet-button page-number";
  button.textContent = String(page);
  button.setAttribute("aria-label", `第 ${page} 页`);
  if (current) button.setAttribute("aria-current", "page");
  button.addEventListener("click", () => { void loadListingPage(listing, page); });
  return button;
}

function renderPagination(list) {
  const limit = list ? pageLimit(list) : 1;
  const canNavigate = limit > 1;
  ui.listPagination.hidden = !canNavigate && !list?.error;
  ui.pageControls.hidden = !canNavigate;
  ui.pageJump.hidden = !canNavigate;
  ui.pageRetry.hidden = !list?.error;
  if (!list || !canNavigate) return;

  const { page } = list;
  ui.pagePrevious.disabled = page <= 1;
  ui.pageNext.disabled = page >= limit;
  ui.pageInput.max = String(limit);
  if (document.activeElement !== ui.pageInput) ui.pageInput.value = String(page);

  const signature = `${page}/${limit}`;
  if (ui.pageNumbers.dataset.pages === signature) return;

  const candidates = limit <= 5
    ? Array.from({ length: limit }, (_, index) => index + 1)
    : [1, page - 1, page, page + 1, limit];
  const pages = [...new Set(candidates)].filter(number => number >= 1 && number <= limit);
  pages.sort((left, right) => left - right);
  const focusCurrent = ui.pageNumbers.contains(document.activeElement);
  const fragment = document.createDocumentFragment();
  let previous = 0;

  for (const number of pages) {
    if (number - previous === 2) fragment.append(pageButton(previous + 1, false));
    if (number - previous > 2) {
      const gap = document.createElement("span");
      gap.className = "page-gap";
      gap.textContent = "…";
      gap.setAttribute("aria-hidden", "true");
      fragment.append(gap);
    }
    fragment.append(pageButton(number, number === page));
    previous = number;
  }
  ui.pageNumbers.replaceChildren(fragment);
  ui.pageNumbers.dataset.pages = signature;
  if (focusCurrent) ui.pageNumbers.querySelector('[aria-current="page"]')?.focus();
}

function renderListing() {
  const source = listing?.source;
  let title = "搜索或选择收藏夹";
  let message = "";
  let meta = "";

  if (listing) {
    title = source.title;
    if (source.type === "search") title = `“${source.query}”的搜索结果`;
    if (source.type === "uploader") title = `${source.title}的投稿`;
    if (listing.loading) message = "正在加载…";
    else if (listing.error) message = listing.error;
    else if (!listing.items.length) {
      if (listing.nextPage !== null) message = "这一页没有视频。";
      else if (source.type === "search") message = "没有找到相关视频。";
      else if (source.type === "uploader") message = "该 UP 主暂无可见投稿。";
      else message = source.keyword ? "当前收藏夹没有匹配的视频。" : "这个收藏夹没有视频。";
    }
    if (listing.totalItems !== null) {
      meta = source.keyword ? `${listing.totalItems} 条匹配` : `${listing.totalItems} 条`;
    } else if (listing.items.length) {
      meta = `本页 ${listing.items.length} 条`;
    }
    if (source.type === "uploader") meta = [meta, "按播放量排序"].filter(Boolean).join(" · ");
  }

  setText(ui.listTitle, title);
  setText(ui.listMeta, meta);
  setText(ui.listMessage, message);
  listBack.hidden = !listing?.back;
  ui.listMeta.hidden = !meta;
  ui.trackList.hidden = !listing?.items.length;
  renderPagination(listing);
}

function renderRowIssue(row, reason) {
  setText(row.issue, reason);
  row.issue.hidden = !reason;
}

function authorCell(item, index) {
  const cell = document.createElement("td");
  cell.className = "track-author";
  cell.title = item.author || "";
  if (!item.author || !Number.isSafeInteger(item.authorId) || item.authorId < 1) {
    cell.textContent = item.author || "—";
    return cell;
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = "track-author-button";
  button.textContent = item.author;
  button.setAttribute("aria-label", `查看 ${item.author} 的投稿`);
  button.addEventListener("click", (event) => {
    if (accountChanging) return;
    const source = {
      type: "uploader",
      id: String(item.authorId),
      title: item.author,
      accountId: accountId ?? null,
    };
    if (sameSource(listing?.source, source)) return;

    const back = { list: listing, scrollTop: ui.content.scrollTop, index };
    selectListing(source, { back });
    if (event.detail === 0) listBack.focus({ preventScroll: true });
  });
  cell.append(button);
  return cell;
}

function renderRows(list) {
  const fragment = document.createDocumentFragment();
  const page = list.page;
  visibleRows.clear();
  highlightedRow = null;

  list.items.forEach((item, index) => {
    const row = document.createElement("tr");
    const titleCell = document.createElement("td");
    const button = document.createElement("button");
    const issue = document.createElement("span");
    const author = authorCell(item, index);
    const duration = document.createElement("td");

    button.type = "button";
    button.className = "track-title";
    button.textContent = item.title;
    button.title = item.title;
    button.disabled = Boolean(item.unavailable);
    button.addEventListener("click", () => {
      void playTrack(list, page, index);
    });

    issue.className = "track-issue";
    duration.className = "duration";
    duration.textContent = formatTime(item.duration);
    titleCell.append(button, issue);
    row.append(titleCell, author, duration);
    fragment.append(row);

    const rowReference = { row, button, issue };
    if (item.bvid) visibleRows.set(item.bvid, rowReference);
    renderRowIssue(rowReference, item.unavailable || issues.get(item.bvid) || "");
  });

  ui.trackRows.replaceChildren(fragment);
  highlightPlayingRow();
}

function highlightPlayingRow() {
  const row = sameSource(listing?.source, playerState?.source)
    ? visibleRows.get(playerState?.item?.bvid)
    : null;
  if (highlightedRow === row) return;

  highlightedRow?.row.classList.remove("is-active");
  highlightedRow?.button.removeAttribute("aria-current");
  row?.row.classList.add("is-active");
  row?.button.setAttribute("aria-current", "true");
  highlightedRow = row;
}

function showListing(list, { preserveFolderInput = false, scrollTop = 0 } = {}) {
  clearTimeout(folderSearchTimer);
  listing?.controller?.abort();
  listing = list;

  if (listing) renderRows(listing);
  else {
    visibleRows.clear();
    highlightedRow = null;
    ui.trackRows.replaceChildren();
  }
  markSelectedFolder();

  const source = listing?.source;
  ui.folderSearchForm.hidden = source?.type !== "favorite";
  if (!preserveFolderInput) ui.folderSearchInput.value = source?.keyword || "";
  ui.folderSearchClear.hidden = !ui.folderSearchInput.value;
  renderListing();
  ui.content.scrollTop = scrollTop;
}

function selectListing(source, { page = 1, totalItems = null, preserveFolderInput = false, back = null } = {}) {
  if (!Number.isSafeInteger(page) || page < 1) page = 1;
  if (totalItems !== null) {
    page = Math.min(page, Math.max(1, Math.ceil(totalItems / listingPageSize)));
  }
  const list = source ? {
    source, page, totalItems, items: [], pages: new Map(), nextPage: null,
    totalNativePages: null, availablePages: page, lastPage: null, back,
  } : null;
  showListing(list, { preserveFolderInput });
  if (list) void loadListingPage(list, page);
}

function fetchPage(source, page, options) {
  if (source.type === "favorite") {
    return getFavoritePage(source.id, page, { ...options, keyword: source.keyword });
  }
  if (source.type === "uploader") {
    return getUploaderVideos(source.id, page, { ...options, authorName: source.title });
  }
  return searchVideos(source.query, page, options);
}

async function collectNativePages(list, page, signal) {
  const start = (page - 1) * batchesPerPage + 1;
  const items = [];
  const known = new Set();
  let nextPage = null;

  for (let nativePage = start; nativePage < start + batchesPerPage; nativePage++) {
    let batch = list.pages.get(nativePage);
    if (!batch) {
      try {
        batch = await fetchPage(list.source, nativePage, { signal });
        signal.throwIfAborted();
        list.pages.set(nativePage, batch);
      } catch (error) {
        if (signal.aborted || list.source.type !== "uploader" || !items.length) throw error;
        return { items, nextPage: nativePage, error };
      }
    }

    if (Number.isSafeInteger(batch.totalItems) && batch.totalItems >= 0) {
      list.totalItems = batch.totalItems;
    }
    if (Number.isSafeInteger(batch.totalPages) && batch.totalPages >= 0) {
      list.totalNativePages = batch.totalPages;
    }

    for (const item of batch.items) {
      if (item.bvid && known.has(item.bvid)) continue;
      if (item.bvid) known.add(item.bvid);
      items.push(item);
    }

    nextPage = batch.hasMore ? nativePage + 1 : null;
    if (nextPage === null) break;
  }
  return { items, nextPage };
}

async function loadListingPage(list, targetPage) {
  if (!list || list !== listing || !Number.isSafeInteger(targetPage) || targetPage < 1) return;
  const page = Math.min(targetPage, pageLimit(list));
  if (page === list.page && (list.loading || (list.loaded && !list.error))) return;

  list.controller?.abort();
  const controller = new AbortController();
  list.controller = controller;
  list.page = page;
  list.loading = true;
  list.loaded = false;
  list.items = [];
  list.nextPage = null;
  list.error = "";
  renderRows(list);
  ui.content.scrollTop = 0;
  renderListing();

  try {
    const result = await collectNativePages(list, page, controller.signal);
    if (listing !== list || controller.signal.aborted) return;

    list.items = result.items;
    list.nextPage = result.nextPage;
    list.loaded = true;
    if (result.error) {
      handleSiteAccess(result.error);
      list.error = `本页已加载 ${list.items.length} 条。${errorMessage(result.error, "其余投稿加载失败，请重试。")}`;
    } else if (list.nextPage !== null) {
      list.availablePages = Math.max(list.availablePages, page + 1);
    } else if (list.items.length || page === 1) {
      list.lastPage = page;
    }
    renderRows(list);
  } catch (error) {
    if (listing !== list || controller.signal.aborted || error?.name === "AbortError") return;
    handleSiteAccess(error);
    list.error = errorMessage(error, "列表加载失败，请重试。");
  } finally {
    if (listing === list && list.controller === controller) {
      list.loading = false;
      renderListing();
    }
  }
}

function applyFolderSearch() {
  clearTimeout(folderSearchTimer);
  if (listing?.source.type !== "favorite" || accountChanging) return;

  const keyword = ui.folderSearchInput.value.trim();
  if (keyword === listing.source.keyword) return;
  const folder = folders.find((entry) => String(entry.id) === listing.source.id);
  selectListing({ ...listing.source, keyword }, {
    totalItems: keyword ? null : folder?.count ?? null,
    preserveFolderInput: true,
  });
}

function scheduleFolderSearch(event) {
  ui.folderSearchClear.hidden = !ui.folderSearchInput.value;
  clearTimeout(folderSearchTimer);
  if (!event.isComposing) folderSearchTimer = setTimeout(applyFolderSearch, 300);
}

function describeQuality(track) {
  if (!track) return "";
  const label = String(track.quality || "");
  const bitrate = Number.isFinite(track.bitrate) && track.bitrate > 0
    ? String(Math.round(track.bitrate))
    : "";
  if (!bitrate || label.includes(bitrate)) return label;
  return [label, `约 ${bitrate} kbps`].filter(Boolean).join(" · ");
}

async function callDownloadWorker(type, options) {
  const result = await chrome.runtime.sendMessage({ target: "download-jobs", type, ...options });
  if (!result?.ok || result.status === "needs-recovery") {
    const error = new Error(result?.error || "音频下载失败，请重试。");
    error.jobId = result?.jobId;
    error.canSaveOriginal = result?.canSaveOriginal === true;
    throw error;
  }
  return result;
}

const downloadDialog = createDownloadDialog({
  async loadTracks({ bvid, cid }, { signal }) {
    const tracks = await withSiteAccess(getAudioTracks(bvid, cid, { signal }));
    return tracks.map(track => ({ id: track.id, codecs: track.codecs, label: describeQuality(track) }));
  },
  async save(snapshot, { title, artist, track, embedMetadata, saveCover, signal, onProgress, pendingJobId, saveOriginal }) {
    let result;
    if (pendingJobId) {
      onProgress({ message: "正在处理缓存的音频…" });
      result = await callDownloadWorker("RECOVER_AUDIO_DOWNLOAD", { jobId: pendingJobId, original: saveOriginal });
    } else {
      onProgress({ message: "正在获取音频地址…" });
      // Signed CDN addresses may expire while the download options are open.
      const tracks = await withSiteAccess(getAudioTracks(snapshot.bvid, snapshot.cid, { signal }));
      const selected = tracks.find(candidate => candidate.id === track.id && candidate.codecs === track.codecs);
      if (!selected) throw new Error("所选音质已不可用，请重新打开下载面板。");

      const coverUrl = (embedMetadata || saveCover)
        ? snapshot.cover || await getVideoCover(snapshot.bvid, { signal }).catch(() => "")
        : "";
      signal?.throwIfAborted();
      onProgress({ message: "正在读取音频并准备保存…" });
      result = await callDownloadWorker("START_AUDIO_DOWNLOAD", {
        audioUrls: selected.urls,
        coverUrl,
        songName: title,
        artist,
        embedMeta: embedMetadata,
        includeCover: saveCover,
      });
    }

    const status = result.status === "complete" ? "已保存" : "已提交到浏览器下载";
    const coverNote = result.coverStatus === "failed"
      ? `\n封面另存失败${result.coverError ? `（${result.coverError}）` : ""}。`
      : "";
    return { message: `${status} ${result.filename}${coverNote}` };
  },
  release(_snapshot, jobId) {
    return callDownloadWorker("RELEASE_AUDIO_DOWNLOAD", { jobId }).catch(() => {});
  },
});

function renderCover({ item, status }) {
  const bvid = item?.bvid || "";
  if (bvid !== coverBvid) {
    coverRequest?.abort();
    coverRequest = undefined;
    coverBvid = bvid;
    ui.openCurrentVideo.hidden = true;
    ui.nowCover.removeAttribute("src");
  }
  if (status !== "playing" || !bvid || coverRequest) return;

  coverRequest = new AbortController();
  const { signal } = coverRequest;
  if (item.cover) {
    ui.nowCover.src = item.cover;
    return;
  }
  void getVideoCover(bvid, { signal }).then((url) => {
    if (url && !signal.aborted) ui.nowCover.src = url;
  }).catch(() => {
    // Cover artwork is optional and never holds up audio playback.
  });
}

function renderPlayer(state) {
  if (playerState?.item?.bvid !== state.item?.bvid || playerState?.part?.cid !== state.part?.cid) {
    seekPreview = null;
  }
  playerState = state;
  renderCover(state);
  updateMediaSession(state, ui.openCurrentVideo.hidden ? "" : ui.nowCover.currentSrc);

  const partPage = state.part?.page;
  const multipleParts = state.parts?.length > 1 || state.item?.partCount > 1;
  const partName = state.part?.title;
  const quality = describeQuality(state.track);
  const details = [];

  if (state.item && multipleParts && partPage) {
    details.push(`P${partPage}${partName && partName !== state.item.title ? ` ${partName}` : ""}`);
  }
  if (quality) details.push(quality);

  setText(ui.nowTitle, state.item?.title || "未开始播放");
  ui.nowTitle.title = state.item?.title || "";
  setText(ui.nowDetail, details.join(" · "));
  ui.nowDetail.title = ui.nowDetail.textContent;
  const message = state.error || (state.status === "loading" ? "正在加载音频…" : "");
  setText(ui.playerMessage, message);
  ui.playerMessage.hidden = !message;
  ui.playerMessage.dataset.error = String(Boolean(state.error));

  const position = seekPreview ?? state.position;
  setText(ui.positionText, formatTime(Number.isFinite(position) ? position : 0));
  setText(ui.durationText, state.duration > 0 ? formatTime(state.duration) : "—");
  ui.seek.disabled = !Number.isFinite(state.duration) || state.duration <= 0;
  ui.seek.max = ui.seek.disabled ? "1" : String(state.duration);
  ui.seek.value = Number.isFinite(position) ? String(position) : "0";
  ui.seek.setAttribute("aria-valuetext", formatTime(position));

  const canPause = state.status === "playing" || state.status === "loading";
  ui.play.dataset.icon = canPause ? "pause" : "play";
  setControlLabel(ui.play, canPause ? "暂停" : "播放");
  ui.play.disabled = !state.item;
  ui.previous.disabled = !state.canPrevious;
  ui.next.disabled = !state.canNext;
  ui.downloadAudio.disabled = !state.item?.bvid || !state.part?.cid;
  ui.playMode.dataset.icon = state.mode;
  ui.playMode.dataset.active = String(state.mode !== "order");
  setControlLabel(ui.playMode, `${playModeLabels[state.mode]} · 切换到${playModeLabels[nextPlayMode(state.mode)]}`);

  if (Number.isFinite(state.volume)) ui.volume.value = String(state.volume);
  highlightPlayingRow();
}

async function loadNextQueuePage(source, page, options) {
  if (source.accountId !== (accountId ?? null)) {
    const error = new Error("B 站登录账号已更换，请刷新收藏夹后重新点播。");
    error.code = "auth";
    throw error;
  }

  options?.signal?.throwIfAborted();
  const cached = sameSource(listing?.source, source) ? listing.pages.get(page) : null;
  return cached ?? withSiteAccess(fetchPage(source, page, options));
}

function recordIssue(item, reason) {
  if (!item?.bvid) return;
  issues.set(item.bvid, reason);
  const row = visibleRows.get(item.bvid);
  if (row) renderRowIssue(row, reason);
}

const player = createPlayer({
  audio: element("audio"),
  loadParts: (bvid, options) => withSiteAccess(getVideoParts(bvid, options)),
  loadTracks: (bvid, cid, options) => withSiteAccess(getAudioTracks(bvid, cid, options)),
  loadMore: loadNextQueuePage,
  storage: {
    async load() {
      const key = storageKey();
      if (!key) return null;
      const data = await chrome.storage.local.get(key);
      return data[key] ?? null;
    },
    async save(snapshot) {
      const key = storageKey();
      if (key) await chrome.storage.local.set({ [key]: snapshot });
    },
  },
  onState: renderPlayer,
  onIssue: recordIssue,
});
const updateMediaSession = createMediaSession(player, () => playerReady && !accountChanging);

async function initializePlayer() {
  await player.initialize();
  playerReady = true;
}

function restorePublicListing() {
  if (listing) return;
  const saved = playerState?.source;
  if (saved?.type !== "search" && saved?.type !== "uploader") return;

  if (saved.type === "search") ui.searchInput.value = saved.query;
  selectListing(saved, { page: saved.startPage });
}

function syncFolderListing() {
  if (listing && listing.source.type !== "favorite") return;

  const previous = listing?.source ?? playerState?.source;
  const preferredId = previous?.type === "favorite" ? String(previous.id) : null;
  const preferred = folders.find((folder) => String(folder.id) === preferredId);
  const folder = preferred ?? folders[0];
  const keyword = preferred ? previous.keyword || "" : "";
  const page = preferred ? (listing?.page ?? previous.startPage) : 1;
  selectListing(folder ? favoriteSource(folder, keyword) : null, {
    page,
    totalItems: keyword ? null : folder?.count ?? null,
  });
}

async function refreshSession() {
  if (accountBusy) return;
  accountBusy = true;
  renderAccount();

  try {
    const session = await getSession();
    if (session.loggedIn && !session.mid) {
      throw new Error("B 站登录状态未确认，请刷新后重试。");
    }

    const owner = session.loggedIn ? String(session.mid) : null;
    const changed = owner !== accountId;

    if (playerReady && changed) {
      accountChanging = true;
      await player.reset();
      issues.clear();
      if (listing?.source.type === "favorite") selectListing(null);
      folders = [];
      renderFolders();
    }

    accountId = owner;
    accountName = session.name || "";
    accountAvatar = session.avatar || "";
    needsLogin = false;
    needsSiteVisit = false;
    if (listing && listing.source.type !== "favorite" && listing.source.accountId !== owner) {
      selectListing({ ...listing.source, accountId: owner }, { page: listing.page });
    }
    if (!playerReady || changed) await initializePlayer();
    accountChanging = false;
    restorePublicListing();

    favoritesMessage = owner ? "正在加载收藏夹…" : "登录 B 站网页后，点「刷新收藏夹」。";
    renderAccount();

    if (owner) {
      folders = await getFavoriteFolders(owner);
      favoritesMessage = folders.length ? "" : "还没有收藏夹。";
    }
    syncFolderListing();
    renderFolders();
  } catch (error) {
    if (!playerReady) await initializePlayer();
    handleSiteAccess(error);
    favoritesMessage = errorMessage(error, "暂时无法读取 B 站登录状态或收藏夹。");
  } finally {
    accountBusy = false;
    accountChanging = false;
    renderAccount();
  }
}

async function playTrack(list, page, index) {
  if (!playerReady) await startup;
  if (list !== listing || list.page !== page || !list.loaded || accountChanging) return;

  const item = list.items[index];
  issues.delete(item.bvid);
  const row = visibleRows.get(item.bvid);
  if (row) renderRowIssue(row, "");

  await player.start([...list.items], index, {
    ...list.source,
    accountId: accountId ?? null,
    startPage: page,
    nextPage: list.nextPage,
  });
}

ui.searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const query = ui.searchInput.value.trim();
  if (!query) return;

  selectListing({
    type: "search",
    id: crypto.randomUUID(),
    query,
    title: query,
    accountId: accountId ?? null,
  });
});

listBack.addEventListener("click", () => {
  const back = listing?.back;
  if (accountChanging || !back?.list) return;
  showListing(back.list, { scrollTop: back.scrollTop });
  ui.trackRows.rows[back.index]?.querySelector(".track-author-button")?.focus({ preventScroll: true });
});

ui.accountAvatar.addEventListener("load", () => {
  ui.accountAvatar.hidden = !ui.accountAvatar.naturalWidth;
});
ui.accountAvatar.addEventListener("error", () => { ui.accountAvatar.hidden = true; });
ui.nowCover.addEventListener("load", () => {
  ui.openCurrentVideo.hidden = !ui.nowCover.naturalWidth;
  if (playerState) updateMediaSession(playerState, ui.openCurrentVideo.hidden ? "" : ui.nowCover.currentSrc);
});
ui.nowCover.addEventListener("error", () => {
  ui.openCurrentVideo.hidden = true;
  if (playerState) updateMediaSession(playerState);
});
ui.openCurrentVideo.addEventListener("click", () => {
  const { item, part } = playerState ?? {};
  if (!item?.bvid || !window.confirm("在新标签页打开当前视频的 B 站播放页面？")) return;

  const url = new URL(`https://www.bilibili.com/video/${encodeURIComponent(item.bvid)}/`);
  if (part?.page > 1) url.searchParams.set("p", part.page);
  void chrome.tabs.create({ url: url.href });
});
ui.refreshSession.addEventListener("click", () => { void refreshSession(); });
ui.folderSearchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  applyFolderSearch();
});
ui.folderSearchInput.addEventListener("input", scheduleFolderSearch);
ui.folderSearchInput.addEventListener("compositionend", scheduleFolderSearch);
ui.folderSearchClear.addEventListener("click", () => {
  ui.folderSearchInput.value = "";
  ui.folderSearchInput.focus();
  ui.folderSearchClear.hidden = true;
  applyFolderSearch();
});
ui.pagePrevious.addEventListener("click", () => {
  if (listing) void loadListingPage(listing, listing.page - 1);
});
ui.pageNext.addEventListener("click", () => {
  if (listing) void loadListingPage(listing, listing.page + 1);
});
ui.pageJump.addEventListener("submit", (event) => {
  event.preventDefault();
  void loadListingPage(listing, ui.pageInput.valueAsNumber);
});
ui.pageRetry.addEventListener("click", () => {
  if (listing) void loadListingPage(listing, listing.page);
});
ui.play.addEventListener("click", () => {
  if (!accountChanging) void player.toggle();
});
ui.previous.addEventListener("click", () => {
  if (!accountChanging) void player.previous();
});
ui.next.addEventListener("click", () => {
  if (!accountChanging) void player.next();
});
ui.downloadAudio.addEventListener("click", () => {
  const { item, part, parts } = playerState ?? {};
  if (accountChanging || !item?.bvid || !part?.cid) return;

  const multiPart = parts.length > 1 || item.partCount > 1 || part.page > 1;
  downloadDialog.open({
    bvid: item.bvid,
    cid: part.cid,
    title: (multiPart && part.title) || item.title,
    artist: item.author,
    cover: item.cover,
  });
});
ui.playMode.addEventListener("click", () => {
  if (playerReady && !accountChanging) player.setMode(nextPlayMode(playerState.mode));
});
ui.volume.addEventListener("input", () => {
  if (playerReady && !accountChanging) player.setVolume(ui.volume.valueAsNumber);
});
ui.seek.addEventListener("input", () => {
  seekPreview = ui.seek.valueAsNumber;
  setText(ui.positionText, formatTime(seekPreview));
  ui.seek.setAttribute("aria-valuetext", formatTime(seekPreview));
});
ui.seek.addEventListener("change", () => {
  const position = ui.seek.valueAsNumber;
  seekPreview = null;
  if (!accountChanging) player.seek(position);
});
ui.seek.addEventListener("blur", () => {
  seekPreview = null;
  if (playerState) renderPlayer(playerState);
});

const startup = refreshSession();
