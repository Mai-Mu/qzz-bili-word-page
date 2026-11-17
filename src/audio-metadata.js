/*
 * MP4/M4A metadata writer adapted from qzz-bili-music-downloader.
 * MIT License
 *
 * Copyright (c) 2026 Mai-Mu
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
/* Local MP4/M4A metadata writer. Keeps encoded media bytes unchanged. */
(function (global) {
  const text = new TextEncoder();
  const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'moof', 'traf', 'mfra']);
  function join(parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }
  function u32(n) {
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw Error('文件偏移超出支持范围');
    const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b;
  }
  function box(type, ...parts) {
    const body = join(parts);
    return join([u32(body.length + 8), Uint8Array.from(type, c => c.charCodeAt(0)), body]);
  }
  function boxes(bytes, start = 0, end = bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const result = [];
    for (let at = start; at < end;) {
      if (end - at < 8) throw Error('音频容器不完整，无法写入标签');
      let size = view.getUint32(at), header = 8;
      if (size === 1) {
        if (end - at < 16) throw Error('音频容器不完整');
        size = Number(view.getBigUint64(at + 8)); header = 16;
      } else if (size === 0) size = end - at;
      if (!Number.isSafeInteger(size) || size < header || at + size > end) throw Error('音频容器长度异常');
      const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
      result.push({ type, start: at, end: at + size, body: at + header });
      at += size;
    }
    return result;
  }
  const raw = (bytes, b) => bytes.subarray(b.start, b.end);
  function imageType(bytes) {
    if (bytes?.[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 13;
    if (bytes?.length >= 8 && [137,80,78,71,13,10,26,10].every((v,i) => bytes[i] === v)) return 14;
    throw Error('封面必须是 JPEG 或 PNG 图片');
  }
  function item(key, value, type = 1) {
    return box(key, box('data', u32(type), u32(0), value));
  }
  function makeMoov(bytes, moov, title, artist, cover) {
    const children = boxes(bytes, moov.body, moov.end);
    const udtas = children.filter(b => b.type === 'udta');
    if (udtas.length > 1) throw Error('暂不支持多个用户标签区');
    const udta = udtas[0];
    const user = udta ? boxes(bytes, udta.body, udta.end) : [];
    const metas = user.filter(b => b.type === 'meta');
    if (metas.length > 1) throw Error('暂不支持多个元数据区');
    const meta = metas[0];
    if (meta && meta.end - meta.body < 4) throw Error('元数据区不完整');
    const metaChildren = meta ? boxes(bytes, meta.body + 4, meta.end) : [];
    const lists = metaChildren.filter(b => b.type === 'ilst');
    if (lists.length > 1) throw Error('暂不支持多个歌曲标签列表');
    const list = lists[0];
    const existing = list ? boxes(bytes, list.body, list.end) : [];
    const replaced = new Set(['\xa9nam', '\xa9ART', 'aART', 'covr']);
    const ilst = box('ilst', ...existing.filter(b => !replaced.has(b.type)).map(b => raw(bytes, b)),
      item('\xa9nam', text.encode(title)), item('\xa9ART', text.encode(artist)),
      item('aART', text.encode(artist)), item('covr', cover, imageType(cover)));
    // Standard iTunes-style metadata handler recognized by M4A players.
    const hdlr = box('hdlr', new Uint8Array(8), text.encode('mdir'), text.encode('appl'), new Uint8Array(9));
    const newMeta = box('meta', new Uint8Array(4), hdlr,
      ...metaChildren.filter(b => !['ilst', 'hdlr'].includes(b.type)).map(b => raw(bytes, b)), ilst);
    const newUdta = box('udta', ...user.filter(b => b.type !== 'meta').map(b => raw(bytes, b)), newMeta);
    return box('moov', ...children.filter(b => b.type !== 'udta').map(b => raw(bytes, b)), newUdta);
  }
  // Relocate absolute file offsets when replacing moov changes its length.
  // Relative fragment offsets remain valid because moof and mdat move together.
  function patchOffsets(bytes, relocate) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    function need(at, size, end) { if (at + size > end) throw Error('音频索引不完整'); }
    function patch(at, wide, end) {
      need(at, wide ? 8 : 4, end);
      const old = wide ? Number(view.getBigUint64(at)) : view.getUint32(at);
      if (!Number.isSafeInteger(old)) throw Error('音频索引超出支持范围');
      const value = relocate(old);
      if (wide) view.setBigUint64(at, BigInt(value));
      else { u32(value); view.setUint32(at, value); }
    }
    function walk(start, end, depth = 0) {
      if (depth > 16) throw Error('音频容器嵌套过深');
      for (const b of boxes(bytes, start, end)) {
        if (['saio', 'senc', 'iloc'].includes(b.type)) throw Error('暂不支持此音频的加密或项目索引结构');
        if (b.type === 'stco' || b.type === 'co64') {
          need(b.body, 8, b.end);
          const count = view.getUint32(b.body + 4), size = b.type === 'co64' ? 8 : 4;
          need(b.body + 8, count * size, b.end);
          for (let i = 0; i < count; i++) patch(b.body + 8 + i * size, size === 8, b.end);
        } else if (b.type === 'tfhd') {
          need(b.body, 8, b.end);
          if (view.getUint32(b.body) & 1) patch(b.body + 8, true, b.end);
        } else if (b.type === 'tfra') {
          need(b.body, 16, b.end);
          const wide = bytes[b.body] === 1, size = wide ? 8 : 4;
          const lengths = view.getUint32(b.body + 8);
          const step = size * 2 + ((lengths >> 4 & 3) + 1) + ((lengths >> 2 & 3) + 1) + ((lengths & 3) + 1);
          const count = view.getUint32(b.body + 12);
          need(b.body + 16, count * step, b.end);
          for (let i = 0; i < count; i++) patch(b.body + 16 + i * step + size, wide, b.end);
        }
        if (containers.has(b.type)) walk(b.body, b.end, depth + 1);
      }
    }
    walk(0, bytes.length);
    return bytes;
  }
  function embed(input, { title, artist, cover }) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (!String(title || '').trim()) throw Error('请填写歌曲名');
    const top = boxes(bytes);
    if (!top.some(b => b.type === 'ftyp') || !top.some(b => b.type === 'mdat')) throw Error('仅支持 M4A / MP4 音频容器');
    const moovs = top.filter(b => b.type === 'moov');
    if (moovs.length !== 1) throw Error('音频缺少唯一的 moov 信息区');
    const moov = moovs[0];
    const updated = makeMoov(bytes, moov, title, artist || '', cover);
    const delta = updated.length - (moov.end - moov.start);
    const relocate = n => {
      if (n >= moov.end) return n + delta;
      if (n >= moov.start) throw Error('音频索引指向标签区，无法安全写入');
      return n;
    };
    patchOffsets(updated, relocate);
    const parts = top.map(b => {
      if (b === moov) return updated;
      if (b.type === 'sidx' && b.start < moov.start) throw Error('暂不支持标签区之前的分片索引');
      if (b.type === 'moof' || b.type === 'mfra') return patchOffsets(raw(bytes, b).slice(), relocate);
      return raw(bytes, b);
    });
    return new Blob(parts, { type: 'audio/mp4' });
  }
  global.BiliMetadata = { embed, imageType };
})(globalThis);
