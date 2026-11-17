const API_ORIGIN = "https://api.bilibili.com";
const PAGE_SIZE = 20;
const REQUEST_TIMEOUT_MS = 20_000;
const BVID_PATTERN = /^BV[0-9A-Za-z]{10}$/;

const AUDIO_QUALITIES = {
  30216: "AAC 低码率",
  30232: "AAC 标准",
  30280: "AAC 高音质",
  30250: "杜比全景声",
  30251: "FLAC 无损",
};

const AAC_NOMINAL_BITRATES = { 30216: 64, 30232: 132, 30280: 192 };

export class BiliApiError extends Error {
  constructor(code, message, { biliCode = null, httpStatus = null } = {}) {
    super(message);
    this.name = "BiliApiError";
    this.code = code;
    this.biliCode = biliCode;
    this.httpStatus = httpStatus;
  }
}

function platformError(operation, status, code, message) {
  const details = { biliCode: code, httpStatus: status };

  if (status === 401 || code === -101) {
    return new BiliApiError("auth", "B 站登录已失效，请重新登录。", details);
  }
  if (status === 429 || code === -429 || code === -799) {
    return new BiliApiError("rate-limit", "B 站请求过于频繁，请稍后重试。", details);
  }
  if (status === 412 || code === -412 || code === -352) {
    const reason = operation === "搜索视频"
      ? "B 站拦截了搜索，请先打开一次 B 站首页，再回来重试。"
      : "B 站拦截了请求，请打开 B 站页面后再试。";
    return new BiliApiError("blocked", reason, details);
  }
  if (status === 403 || status === 404 || code === -403 || code === -404 || code === 62002) {
    return new BiliApiError("unavailable", `${operation}失败，内容可能失效或当前账号无权访问。`, details);
  }
  if (code === -10403 || code === -10404 || code === 6002003) {
    return new BiliApiError("unavailable", `${operation}失败，当前账号或地区无法访问该内容。`, details);
  }

  const reason = typeof message === "string" && message.trim() && message.trim() !== "0"
    ? `（${message.trim()}）`
    : "";
  return new BiliApiError("api", `${operation}失败${reason}。`, details);
}

async function request(path, params, operation, signal, { allowLoggedOut = false } = {}) {
  const url = new URL(path, API_ORIGIN);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  let body;
  try {
    response = await fetch(url, {
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: requestSignal,
    });
    body = await response.json();
  } catch (error) {
    signal?.throwIfAborted();
    if (timeout.aborted) {
      throw new BiliApiError("timeout", `${operation}超时，请重试。`);
    }
    if (response && !response.ok) {
      throw platformError(operation, response.status, null, null);
    }
    if (response && error instanceof SyntaxError) {
      throw new BiliApiError("bad-response", `B 站返回了无法识别的响应，${operation}失败。`, {
        httpStatus: response.status,
      });
    }
    throw new BiliApiError("network", `${operation}失败，请检查网络后重试。`);
  }

  const code = body?.code;
  if (!response.ok || (code !== 0 && !(allowLoggedOut && code === -101))) {
    if (response.ok && !Number.isInteger(code)) {
      throw new BiliApiError("bad-response", `B 站返回了无法识别的响应，${operation}失败。`, {
        httpStatus: response.status,
      });
    }
    throw platformError(operation, response.status, Number.isInteger(code) ? code : null, body?.message);
  }

  return body.data;
}

function positiveId(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nonnegativeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function requireId(value, label) {
  const id = positiveId(Number(value));
  if (id === null) {
    throw new BiliApiError("invalid-input", `${label}无效。`);
  }
  return id;
}

function requireBvid(bvid) {
  if (typeof bvid !== "string" || !BVID_PATTERN.test(bvid)) {
    throw new BiliApiError("invalid-input", "B 站视频 BV 号无效。");
  }
  return bvid;
}

function durationSeconds(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  // Search returns durations such as 516:24; minutes can exceed 59.
  if (typeof value !== "string" || !/^\d+(?::\d{1,2}){0,2}$/.test(value)) {
    return null;
  }
  const seconds = value.split(":").reduce((total, unit) => total * 60 + Number(unit), 0);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

function plainSearchText(value) {
  if (typeof value !== "string") return "";
  const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return value.replace(/<\/?[a-z][^<>]*>/gi, "")
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, token) => {
      if (token[0] !== "#") return entities[token.toLowerCase()];
      const codePoint = /^#x/i.test(token) ? Number.parseInt(token.slice(2), 16) : Number(token.slice(1));
      return codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? String.fromCodePoint(codePoint)
        : match;
    }).trim();
}

function favoriteUnavailable(item, bvid) {
  if ((Number(item.attr) & 1) !== 0 || item.title === "已失效视频") {
    return "原视频已失效";
  }
  if (item.type === 21) return "这是合集，请选择单条视频播放";
  if (item.type === 12) return "暂不支持 B 站音频区条目";
  if (!bvid || (item.type != null && item.type !== 2)) return "该收藏条目无法播放";
  return "";
}

function trustedImageUrl(value) {
  if (typeof value !== "string") return "";
  const address = value.trim();
  try {
    const url = new URL(address.startsWith("//") ? `https:${address}` : address);
    const imageHost = /^i[0-2]\.hdslb\.com$/.test(url.hostname);
    const webProtocol = url.protocol === "https:" || url.protocol === "http:";
    if (!imageHost || !webProtocol || url.port || url.username || url.password) return "";
    url.protocol = "https:";
    return url.href;
  } catch {
    return "";
  }
}

export async function getSession({ signal } = {}) {
  const data = await request("/x/web-interface/nav", {}, "检查登录状态", signal, { allowLoggedOut: true });
  if (data?.isLogin === false) return { loggedIn: false, mid: null, name: "", avatar: "" };
  if (data?.isLogin !== true || !positiveId(data.mid)) {
    throw new BiliApiError("bad-response", "B 站返回了无法识别的登录状态。");
  }
  return { loggedIn: true, mid: data.mid, name: data.uname || "", avatar: trustedImageUrl(data.face) };
}

export async function getFavoriteFolders(mid, { signal } = {}) {
  const data = await request("/x/v3/fav/folder/created/list-all", {
    up_mid: requireId(mid, "用户编号"),
    type: 2,
    rid: 0,
  }, "读取收藏夹", signal);

  return (data?.list ?? []).filter(folder => positiveId(folder?.id)).map(folder => ({
    id: folder.id,
    title: folder.title || "未命名收藏夹",
    count: nonnegativeCount(folder.media_count),
  }));
}

export async function getFavoritePage(folderId, page = 1, { signal, keyword } = {}) {
  const pageNumber = requireId(page, "页码");
  const params = {
    media_id: requireId(folderId, "收藏夹编号"),
    pn: pageNumber,
    ps: PAGE_SIZE,
    order: "mtime",
    type: 0,
    tid: 0,
    platform: "web",
  };
  if (typeof keyword === "string" && keyword.trim()) params.keyword = keyword.trim();
  const data = await request("/x/v3/fav/resource/list", params, "读取收藏内容", signal);

  const items = (data?.medias ?? []).filter(Boolean).map(item => {
    const candidate = item.bvid || item.bv_id || "";
    const bvid = BVID_PATTERN.test(candidate) ? candidate : "";
    return {
      bvid,
      title: item.title || "未命名条目",
      author: item.upper?.name || "",
      cover: trustedImageUrl(item.cover),
      duration: durationSeconds(item.duration),
      partCount: item.type === 2 ? positiveId(item.page) : null,
      unavailable: favoriteUnavailable(item, bvid),
    };
  });
  const count = nonnegativeCount(data?.info?.media_count);
  // An out-of-range page can report zero even when earlier pages have results.
  const totalItems = count === 0 && pageNumber > 1 ? null : count;
  return { items, hasMore: data?.has_more === true, totalItems };
}

export async function searchVideos(query, page = 1, { signal } = {}) {
  const keyword = typeof query === "string" ? query.trim() : "";
  if (!keyword) return { items: [], hasMore: false, totalItems: 0, totalPages: 0 };
  const pageNumber = requireId(page, "页码");
  const params = { search_type: "video", keyword, page: pageNumber };
  let data;
  try {
    data = await request("/x/web-interface/search/type", params, "搜索视频", signal);
  } catch (error) {
    if (error.httpStatus !== 404 && error.biliCode !== -404) throw error;
    data = await request("/x/web-interface/wbi/search/type", params, "搜索视频", signal);
  }

  const items = (data?.result ?? [])
    .filter(item => item && BVID_PATTERN.test(item.bvid))
    .map(item => ({
      bvid: item.bvid,
      title: plainSearchText(item.title) || "未命名视频",
      author: plainSearchText(item.author),
      cover: trustedImageUrl(item.pic),
      duration: durationSeconds(item.duration),
      partCount: null,
      unavailable: "",
    }));
  return {
    items,
    hasMore: pageNumber < Number(data?.numPages),
    totalItems: nonnegativeCount(data?.numResults),
    totalPages: nonnegativeCount(data?.numPages),
  };
}

export async function getVideoCover(bvid, { signal } = {}) {
  const data = await request("/x/web-interface/view", { bvid: requireBvid(bvid) }, "获取视频封面", signal);
  return trustedImageUrl(data?.pic);
}

export async function getVideoParts(bvid, { signal } = {}) {
  const data = await request("/x/player/pagelist", { bvid: requireBvid(bvid) }, "读取视频分 P", signal);
  const parts = (Array.isArray(data) ? data : [])
    .filter(part => positiveId(part?.cid) && positiveId(part.page))
    .map(part => ({
      cid: part.cid,
      page: part.page,
      title: part.part || `P${part.page}`,
      duration: durationSeconds(part.duration),
    }))
    .sort((left, right) => left.page - right.page);

  if (!parts.length) {
    throw new BiliApiError("unavailable", "B 站没有返回可播放的分 P。");
  }
  return parts;
}

function trustedAudioUrl(value) {
  try {
    const url = new URL(value);
    const isBiliCdn = ["bilivideo.com", "bilivideo.cn"].some(
      domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`),
    );
    if (url.protocol === "https:" && !url.username && !url.password && isBiliCdn) return url.href;
  } catch {
    // An absent or invalid backup URL does not affect the other candidates.
  }
  return null;
}

function normalizeAudioTrack(track) {
  if (!track) return null;
  const backups = [track.backupUrl, track.backup_url].filter(Array.isArray).flat();
  const urls = [...new Set([
    track.baseUrl,
    track.base_url,
    ...backups,
  ].map(trustedAudioUrl).filter(Boolean))];
  if (!urls.length) return null;

  const id = Number(track.id);
  const rawBitrate = Number(track.bandwidth);
  const averageKbps = Number.isFinite(rawBitrate) && rawBitrate > 0 ? Math.round(rawBitrate / 1000) : null;
  const bitrate = averageKbps ?? AAC_NOMINAL_BITRATES[id] ?? null;
  const codecs = track.codecs || "";
  const quality = AUDIO_QUALITIES[id] || codecs || "音频";
  const rank = id === 30251 ? 2 : id === 30250 ? 1 : 0;
  return {
    rank,
    sortBitrate: AAC_NOMINAL_BITRATES[id] ?? bitrate ?? 0,
    urls,
    mimeType: track.mimeType || track.mime_type || "audio/mp4",
    codecs,
    quality,
    bitrate,
  };
}

export async function getAudioTracks(bvid, cid, { signal } = {}) {
  const data = await request("/x/player/playurl", {
    bvid: requireBvid(bvid),
    cid: requireId(cid, "分 P 编号"),
    fnval: 4048,
    fourk: 1,
  }, "获取音频", signal);

  if (data?.is_preview === 1 || data?.is_preview === true) {
    throw new BiliApiError("unavailable", "当前账号只能试听片段，请到 B 站播放完整内容。");
  }
  const dash = data?.dash;
  const standard = Array.isArray(dash?.audio) ? dash.audio : [];
  const dolby = Array.isArray(dash?.dolby?.audio) ? dash.dolby.audio : [];
  const tracks = [...standard, ...dolby, dash?.flac?.audio].map(normalizeAudioTrack).filter(Boolean)
    .sort((left, right) => right.rank - left.rank || right.sortBitrate - left.sortBitrate);

  if (!tracks.length) {
    throw new BiliApiError("no-audio", "B 站没有为这个分 P 返回可播放的独立音频。");
  }
  return tracks.map(({ rank, sortBitrate, ...track }) => track);
}
