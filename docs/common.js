// Shared helpers for the Professor Skieth replay site.
window.PS = {
  async gunzipFetch(url) {
    const res = await fetch(url, {cache: 'no-cache'});
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
      const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
      return await new Response(stream).text();
    }
    return new TextDecoder().decode(buf); // server already decompressed it
  },
  async json(url) { const r = await fetch(url, {cache: 'no-cache'}); return r.json(); },
  el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'style') e.setAttribute('style', v); else if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return e;
  },
  typeVar(t) { return `var(--${String(t).replace(/[^A-Za-z]/g, '')})`; },
  pad(n) { return String(n).padStart(4, '0'); },
  STAGES: ['Gym 1', 'Gym 2', 'Gym 3', 'Gym 4', 'Gym 5', 'Gym 6', 'Gym 7', 'Gym 8', 'Champion'],
};
