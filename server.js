// Monturas La Gitanilla — servidor de pedidos y pagos
// Sin dependencias externas: Node 22+ (http, crypto, node:sqlite, fetch).
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8080;
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(ROOT, "data");
const PERSISTENT = Boolean(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const MP_TOKEN = process.env.MP_ACCESS_TOKEN || "";
const SECRET = process.env.SESSION_SECRET || crypto.createHash("sha256").update("lg:" + ADMIN_PASSWORD + ":" + MP_TOKEN).digest("hex");
const BANK = { banco: process.env.BANK_NAME || "", titular: process.env.BANK_HOLDER || "", clabe: (process.env.BANK_CLABE || "").replace(/\D/g, "") };
const WA = process.env.WHATSAPP || "524792210090";

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "gitanilla.db"));
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS pedidos(
  code TEXT PRIMARY KEY, folio TEXT, creado TEXT, actualizado TEXT,
  modelo TEXT, specs TEXT, precio REAL, envio REAL, anticipo REAL, entrega TEXT, nota TEXT,
  foto TEXT, estado TEXT, pagado REAL DEFAULT 0, cobrar_restante INTEGER DEFAULT 0,
  nombre TEXT, apellido TEXT, telefono TEXT, email TEXT, calle TEXT, colonia TEXT, cp TEXT,
  ciudad TEXT, estado_dir TEXT, pais TEXT, referencias TEXT, datos_en TEXT);
CREATE TABLE IF NOT EXISTS gastos(
  id TEXT PRIMARY KEY, fecha TEXT, concepto TEXT, categoria TEXT, monto REAL, metodo TEXT, code TEXT, nota TEXT, creado TEXT);
CREATE TABLE IF NOT EXISTS otros_ingresos(
  id TEXT PRIMARY KEY, fecha TEXT, concepto TEXT, categoria TEXT, monto REAL, metodo TEXT, creado TEXT);
CREATE TABLE IF NOT EXISTS pagos(
  id TEXT PRIMARY KEY, code TEXT, monto REAL, metodo TEXT, estado TEXT, fecha TEXT);`);

const now = () => new Date().toISOString();
const money = (n) => Math.round(Number(n || 0) * 100) / 100;
const ALPH = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newCode = () => { const b = crypto.randomBytes(7); let s = ""; for (const x of b) s += ALPH[x % ALPH.length]; return s; };
const getOrder = (code) => db.prepare("SELECT * FROM pedidos WHERE code=?").get(code);
const totals = (o) => {
  const total = money(o.precio + o.envio);
  const anticipo = o.anticipo > 0 && o.anticipo < 100 ? money(total * o.anticipo / 100) : total;
  const pagado = money(o.pagado);
  const restante = money(Math.max(0, total - pagado));
  let due = 0;
  if (o.estado !== "cancelado") {
    if (pagado < 0.01) due = anticipo;
    else if (restante > 0.009 && o.cobrar_restante) due = restante;
  }
  return { total, anticipo, pagado, restante, due };
};

// ---------- helpers HTTP ----------
const SEC_HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "X-Frame-Options": "SAMEORIGIN" };
function send(res, status, body, type = "application/json; charset=utf-8", extra = {}) {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...SEC_HEADERS, ...extra });
  res.end(data);
}
function readBody(req, limit = 1_500_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error("too large"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(Object.assign(new Error("bad json"), { status: 400 })); } });
    req.on("error", reject);
  });
}
const baseUrl = (req) => (process.env.PUBLIC_URL || `${req.headers["x-forwarded-proto"] || "http"}://${req.headers.host}`).replace(/\/+$/, "");
const str = (v, max = 200) => String(v ?? "").trim().slice(0, max);

// ---------- sesión admin ----------
const sign = (v) => crypto.createHmac("sha256", SECRET).update(v).digest("hex");
function isAdmin(req) {
  const m = /(?:^|;\s*)lg_admin=([^;]+)/.exec(req.headers.cookie || "");
  if (!m) return false;
  const [exp, sig] = decodeURIComponent(m[1]).split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = sign(exp);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
const loginTries = new Map();

// ---------- Mercado Pago ----------
async function mpCreatePreference(o, req, amount) {
  const base = baseUrl(req);
  const body = {
    items: [{ id: o.code, title: `${o.modelo} · Folio ${o.folio}`.slice(0, 250), quantity: 1, currency_id: "MXN", unit_price: amount }],
    payer: { name: o.nombre || undefined, surname: o.apellido || undefined, email: o.email || undefined },
    external_reference: o.code,
    back_urls: { success: `${base}/p/${o.code}`, pending: `${base}/p/${o.code}`, failure: `${base}/p/${o.code}` },
    auto_return: "approved",
    notification_url: `${base}/api/mp/webhook`,
    statement_descriptor: "LA GITANILLA",
    payment_methods: { installments: 12 },
  };
  const r = await fetch("https://api.mercadopago.com/checkout/preferences", {
    method: "POST", headers: { Authorization: `Bearer ${MP_TOKEN}`, "Content-Type": "application/json", "X-Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("Mercado Pago respondió " + r.status);
  const j = await r.json();
  return j.init_point;
}
// Nunca se confía en lo que llega del navegador o del aviso: se consulta el pago directamente a Mercado Pago.
async function mpVerify(paymentId) {
  if (!MP_TOKEN || !/^\d{1,20}$/.test(String(paymentId))) return null;
  const r = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, { headers: { Authorization: `Bearer ${MP_TOKEN}` } });
  if (!r.ok) return null;
  const p = await r.json();
  const o = getOrder(String(p.external_reference || ""));
  if (!o) return null;
  recordPayment(o.code, String(p.id), Number(p.transaction_amount), "mercadopago:" + (p.payment_type_id || ""), p.status);
  return p.status;
}
function recordPayment(code, id, monto, metodo, estado) {
  const prev = db.prepare("SELECT estado FROM pagos WHERE id=?").get(id);
  db.prepare("INSERT INTO pagos(id,code,monto,metodo,estado,fecha) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET estado=excluded.estado, fecha=excluded.fecha").run(id, code, money(monto), metodo, estado, now());
  if (estado === "approved" && (!prev || prev.estado !== "approved")) {
    const o = getOrder(code);
    const pagado = money(o.pagado + monto);
    const t = totals({ ...o, pagado });
    const estadoPedido = t.restante < 0.01 ? "pagado" : "anticipo";
    db.prepare("UPDATE pedidos SET pagado=?, estado=?, cobrar_restante=0, actualizado=? WHERE code=?").run(pagado, estadoPedido, now(), code);
  }
}

// ---------- vista pública del pedido ----------
function publicOrder(o) {
  const t = totals(o);
  return {
    code: o.code, folio: o.folio, modelo: o.modelo, specs: JSON.parse(o.specs || "[]"), entrega: o.entrega, nota: o.nota,
    foto: Boolean(o.foto), estado: o.estado, precio: o.precio, envio: o.envio, ...t, anticipoPct: o.anticipo,
    cliente: o.datos_en ? { nombre: o.nombre, apellido: o.apellido, telefono: o.telefono, email: o.email, calle: o.calle, colonia: o.colonia, cp: o.cp, ciudad: o.ciudad, estado: o.estado_dir, pais: o.pais, referencias: o.referencias } : null,
    pagoTarjeta: Boolean(MP_TOKEN), banco: BANK.clabe.length === 18 ? BANK : null, whatsapp: WA,
  };
}
const LABEL = { nombre: "nombre", apellido: "apellidos", telefono: "teléfono", calle: "calle y número", colonia: "colonia", cp: "código postal", ciudad: "ciudad", estado: "estado", pais: "país", referencias: "referencias" };
const REQ = { nombre: 60, apellido: 80, telefono: 20, calle: 150, colonia: 100, cp: 10, ciudad: 80, estado: 60, pais: 40, referencias: 300 };

// ---------- archivos estáticos ----------
const STATIC = { "/": "index.html", "/index.html": "index.html", "/pago.html": "pago.html", "/compartir.jpg": "compartir.jpg", "/favicon.png": "favicon.png", "/favicon.ico": "favicon.png", "/admin": "admin.html", "/admin.html": "admin.html" };
const TYPES = { ".html": "text/html; charset=utf-8", ".jpg": "image/jpeg", ".png": "image/png", ".mp4": "video/mp4", ".webp": "image/webp" };
function serveFile(req, res, file, cache = "public, max-age=300") {
  const fp = path.join(ROOT, file);
  fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, "No encontrado", "text/plain; charset=utf-8");
    const type = TYPES[path.extname(fp)] || "application/octet-stream";
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (range && type === "video/mp4") {
      let start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
      let end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      if (!(start >= 0 && start <= end)) { res.writeHead(416, { "Content-Range": `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { "Content-Type": type, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${st.size}`, "Accept-Ranges": "bytes", "Cache-Control": "public, max-age=86400", ...SEC_HEADERS });
      return fs.createReadStream(fp, { start, end }).pipe(res);
    }
    res.writeHead(200, { "Content-Type": type, "Content-Length": st.size, "Accept-Ranges": "bytes", "Cache-Control": cache, ...SEC_HEADERS });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(fp).pipe(res);
  });
}

// ---------- rutas ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    const M = req.method;

    if ((M === "GET" || M === "HEAD") && STATIC[p]) return serveFile(req, res, STATIC[p], p.startsWith("/admin") ? "no-store" : "public, max-age=300");
    if ((M === "GET" || M === "HEAD") && /^\/v\d\.mp4$/.test(p)) return serveFile(req, res, p.slice(1));
    let m;
    if (M === "GET" && (m = /^\/p\/([A-Z0-9]{6,12})\/?$/.exec(p))) return serveFile(req, res, "pedido.html", "no-store");
    if (M === "GET" && p === "/salud") return send(res, 200, { ok: true });

    // --- cliente ---
    if ((m = /^\/api\/pedido\/([A-Z0-9]{6,12})(\/foto|\/pagar)?$/.exec(p))) {
      const o = getOrder(m[1]);
      if (!o) return send(res, 404, { error: "Este pedido no existe. Revisa tu link o escríbenos por WhatsApp." });
      if (M === "GET" && m[2] === "/foto") {
        if (!o.foto) return send(res, 404, "");
        const mm = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(o.foto);
        if (!mm) return send(res, 404, "");
        return send(res, 200, Buffer.from(mm[2], "base64"), mm[1], { "Cache-Control": "private, max-age=600" });
      }
      if (M === "GET" && !m[2]) {
        const pid = url.searchParams.get("payment_id") || url.searchParams.get("collection_id");
        if (pid) { try { await mpVerify(pid); } catch {} }
        return send(res, 200, publicOrder(getOrder(o.code)));
      }
      if (M === "POST" && m[2] === "/pagar") {
        if (o.estado === "cancelado") return send(res, 409, { error: "Este pedido fue cancelado." });
        const b = await readBody(req, 20_000);
        const c = {};
        for (const [k, max] of Object.entries(REQ)) { c[k] = str(b[k], max); if (!c[k]) return send(res, 400, { error: "Falta llenar: " + LABEL[k], campo: k }); }
        c.email = str(b.email, 120);
        c.telefono = c.telefono.replace(/[^\d+]/g, "");
        if (c.telefono.replace(/\D/g, "").length < 10) return send(res, 400, { error: "El teléfono debe tener 10 dígitos.", campo: "telefono" });
        if (!/^\d{5}$/.test(c.cp)) return send(res, 400, { error: "El código postal debe tener 5 dígitos.", campo: "cp" });
        if (c.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) return send(res, 400, { error: "Revisa tu correo.", campo: "email" });
        db.prepare(`UPDATE pedidos SET nombre=?,apellido=?,telefono=?,email=?,calle=?,colonia=?,cp=?,ciudad=?,estado_dir=?,pais=?,referencias=?,datos_en=?,actualizado=?,
          estado=CASE WHEN estado='nuevo' THEN 'datos' ELSE estado END WHERE code=?`)
          .run(c.nombre, c.apellido, c.telefono, c.email, c.calle, c.colonia, c.cp, c.ciudad, c.estado, c.pais, c.referencias, now(), now(), o.code);
        const o2 = getOrder(o.code), t = totals(o2);
        if (t.due < 0.01) return send(res, 200, { ok: true, guardado: true });
        if (b.metodo === "transferencia" || !MP_TOKEN) return send(res, 200, { ok: true, transferencia: true });
        try { return send(res, 200, { ok: true, redirect: await mpCreatePreference(o2, req, t.due) }); }
        catch (e) { console.error(e); return send(res, 502, { error: "No pudimos abrir el pago en este momento. Tus datos ya quedaron guardados; intenta de nuevo o escríbenos por WhatsApp." }); }
      }
      return send(res, 405, { error: "Método no permitido" });
    }

    // --- aviso de Mercado Pago ---
    if (M === "POST" && p === "/api/mp/webhook") {
      let b = {}; try { b = await readBody(req, 50_000); } catch {}
      const id = (b.data && b.data.id) || url.searchParams.get("data.id") || url.searchParams.get("id");
      const type = b.type || url.searchParams.get("type") || url.searchParams.get("topic");
      if (id && (!type || type === "payment")) { try { await mpVerify(id); } catch (e) { console.error(e); } }
      return send(res, 200, { ok: true });
    }

    // --- admin ---
    if (p === "/api/admin/login" && M === "POST") {
      const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0];
      const t = loginTries.get(ip) || { n: 0, at: 0 };
      if (t.n >= 8 && Date.now() - t.at < 15 * 60_000) return send(res, 429, { error: "Demasiados intentos. Espera 15 minutos." });
      const b = await readBody(req, 5_000);
      if (!ADMIN_PASSWORD) return send(res, 503, { error: "Falta configurar ADMIN_PASSWORD en Railway." });
      const a = crypto.createHash("sha256").update(String(b.password || "")).digest(), g = crypto.createHash("sha256").update(ADMIN_PASSWORD).digest();
      if (!crypto.timingSafeEqual(a, g)) { loginTries.set(ip, { n: t.n + 1, at: Date.now() }); return send(res, 401, { error: "Contraseña incorrecta." }); }
      loginTries.delete(ip);
      const exp = String(Date.now() + 12 * 3600_000);
      const secure = (req.headers["x-forwarded-proto"] || "") === "https" ? "; Secure" : "";
      return send(res, 200, { ok: true }, undefined, { "Set-Cookie": `lg_admin=${encodeURIComponent(exp + "." + sign(exp))}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure}` });
    }
    if (p.startsWith("/api/admin/")) {
      if (!isAdmin(req)) return send(res, 401, { error: "Inicia sesión." });
      if (M === "POST" && p === "/api/admin/logout") return send(res, 200, { ok: true }, undefined, { "Set-Cookie": "lg_admin=; Path=/; Max-Age=0" });
      if (M === "GET" && p === "/api/admin/estado") return send(res, 200, { persistente: PERSISTENT, mercadopago: Boolean(MP_TOKEN), banco: BANK.clabe.length === 18 });
      if (M === "GET" && p === "/api/admin/pedidos") {
        const rows = db.prepare("SELECT * FROM pedidos ORDER BY creado DESC").all();
        return send(res, 200, rows.map((o) => ({ ...o, foto: Boolean(o.foto), specs: JSON.parse(o.specs || "[]"), ...totals(o), anticipoPct: o.anticipo, costos: money((db.prepare("SELECT SUM(monto) s FROM gastos WHERE code=?").get(o.code) || {}).s || 0), pagos: db.prepare("SELECT * FROM pagos WHERE code=? ORDER BY fecha").all(o.code) })));
      }
      if (M === "POST" && p === "/api/admin/pedidos") {
        const b = await readBody(req, 1_500_000);
        const precio = money(b.precio), envio = money(b.envio), anticipo = Math.min(100, Math.max(0, Number(b.anticipo) || 0));
        if (!(precio > 0)) return send(res, 400, { error: "Pon el precio de la montura." });
        const foto = typeof b.foto === "string" && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(b.foto) && b.foto.length < 1_400_000 ? b.foto : null;
        const specs = Array.isArray(b.specs) ? b.specs.slice(0, 20).map((x) => [str(x[0], 40), str(x[1], 160)]).filter((x) => x[0] && x[1]) : [];
        let code; do { code = newCode(); } while (getOrder(code));
        const d = new Date(); const pad = (n) => String(n).padStart(2, "0");
        const folio = str(b.folio, 30) || `LG-${String(d.getFullYear()).slice(2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${code.slice(0, 4)}`;
        db.prepare(`INSERT INTO pedidos(code,folio,creado,actualizado,modelo,specs,precio,envio,anticipo,entrega,nota,foto,estado,nombre,telefono)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'nuevo',?,?)`).run(code, folio, now(), now(), str(b.modelo, 120) || "Montura personalizada", JSON.stringify(specs), precio, envio, anticipo, str(b.entrega, 80), str(b.nota, 300), foto, str(b.nombre, 60), str(b.telefono, 20).replace(/[^\d+]/g, ""));
        return send(res, 201, { ok: true, code, folio, link: `${baseUrl(req)}/p/${code}` });
      }
      // ---- contabilidad ----
      if (M === "GET" && p === "/api/admin/conta") {
        return send(res, 200, {
          pagos: db.prepare("SELECT p.id,p.code,p.monto,p.metodo,p.estado,p.fecha,o.folio,o.modelo,o.nombre,o.apellido FROM pagos p LEFT JOIN pedidos o ON o.code=p.code WHERE p.estado='approved' ORDER BY p.fecha DESC").all(),
          otros: db.prepare("SELECT * FROM otros_ingresos ORDER BY fecha DESC").all(),
          gastos: db.prepare("SELECT g.*, o.folio FROM gastos g LEFT JOIN pedidos o ON o.code=g.code ORDER BY g.fecha DESC").all(),
          porCobrar: db.prepare("SELECT code,folio,modelo,nombre,apellido,precio,envio,pagado,estado FROM pedidos WHERE estado NOT IN ('cancelado')").all().map((o) => ({ ...o, restante: money(o.precio + o.envio - o.pagado) })).filter((o) => o.restante > 0.009),
        });
      }
      const fechaOk = (f) => (/^\d{4}-\d{2}-\d{2}$/.test(String(f)) ? String(f) : now().slice(0, 10));
      if (M === "POST" && p === "/api/admin/gastos") {
        const b = await readBody(req, 10_000);
        const monto = money(b.monto); if (!(monto > 0)) return send(res, 400, { error: "Pon el monto del gasto." });
        const concepto = str(b.concepto, 120); if (!concepto) return send(res, 400, { error: "Pon el concepto del gasto." });
        const code = b.code && getOrder(String(b.code)) ? String(b.code) : null;
        db.prepare("INSERT INTO gastos(id,fecha,concepto,categoria,monto,metodo,code,nota,creado) VALUES(?,?,?,?,?,?,?,?,?)").run(crypto.randomUUID(), fechaOk(b.fecha), concepto, str(b.categoria, 40) || "Otros", monto, str(b.metodo, 40), code, str(b.nota, 200), now());
        return send(res, 201, { ok: true });
      }
      if (M === "POST" && p === "/api/admin/otros-ingresos") {
        const b = await readBody(req, 10_000);
        const monto = money(b.monto); if (!(monto > 0)) return send(res, 400, { error: "Pon el monto del ingreso." });
        const concepto = str(b.concepto, 120); if (!concepto) return send(res, 400, { error: "Pon el concepto del ingreso." });
        db.prepare("INSERT INTO otros_ingresos(id,fecha,concepto,categoria,monto,metodo,creado) VALUES(?,?,?,?,?,?,?)").run(crypto.randomUUID(), fechaOk(b.fecha), concepto, str(b.categoria, 40) || "Otros ingresos", monto, str(b.metodo, 40), now());
        return send(res, 201, { ok: true });
      }
      if (M === "DELETE" && (m = /^\/api\/admin\/(gastos|otros-ingresos)\/([0-9a-f-]{36})$/.exec(p))) {
        db.prepare(`DELETE FROM ${m[1] === "gastos" ? "gastos" : "otros_ingresos"} WHERE id=?`).run(m[2]);
        return send(res, 200, { ok: true });
      }
      if (M === "DELETE" && (m = /^\/api\/admin\/pagos\/(manual-[0-9a-f-]{36})$/.exec(p))) {
        const pg = db.prepare("SELECT * FROM pagos WHERE id=?").get(m[1]); if (!pg) return send(res, 404, { error: "No existe" });
        db.prepare("DELETE FROM pagos WHERE id=?").run(pg.id);
        const o = getOrder(pg.code);
        if (o && pg.estado === "approved") {
          const pagado = money(Math.max(0, o.pagado - pg.monto));
          const t = totals({ ...o, pagado });
          const est = ["en_taller", "enviado", "entregado", "cancelado"].includes(o.estado) ? o.estado : pagado < 0.01 ? (o.datos_en ? "datos" : "nuevo") : t.restante < 0.01 ? "pagado" : "anticipo";
          db.prepare("UPDATE pedidos SET pagado=?, estado=?, actualizado=? WHERE code=?").run(pagado, est, now(), o.code);
        }
        return send(res, 200, { ok: true });
      }
      if (M === "GET" && p === "/api/admin/conta.csv") {
        const rows = [
          ...db.prepare("SELECT p.fecha,'Ingreso' tipo,'Pedido' categoria,('Pago folio '||IFNULL(o.folio,'')||' '||IFNULL(o.nombre,'')||' '||IFNULL(o.apellido,'')) concepto,p.monto,p.metodo,IFNULL(o.folio,'') folio FROM pagos p LEFT JOIN pedidos o ON o.code=p.code WHERE p.estado='approved'").all(),
          ...db.prepare("SELECT fecha,'Ingreso' tipo,categoria,concepto,monto,metodo,'' folio FROM otros_ingresos").all(),
          ...db.prepare("SELECT g.fecha,'Gasto' tipo,g.categoria,g.concepto,-g.monto monto,g.metodo,IFNULL(o.folio,'') folio FROM gastos g LEFT JOIN pedidos o ON o.code=g.code").all(),
        ].sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
        const cols = ["fecha", "tipo", "categoria", "concepto", "monto", "metodo", "folio"];
        const q = (v) => { let x = String(v ?? ""); if (/^[=+\-@]/.test(x) && isNaN(Number(x))) x = "'" + x; return '"' + x.replace(/"/g, '""') + '"'; };
        const csv = "﻿" + [cols.join(","), ...rows.map((r) => cols.map((c) => q(c === "fecha" ? String(r.fecha).slice(0, 10) : r[c])).join(","))].join("\r\n");
        return send(res, 200, csv, "text/csv; charset=utf-8", { "Content-Disposition": 'attachment; filename="contabilidad-la-gitanilla.csv"' });
      }
      if (M === "GET" && p === "/api/admin/export.csv") {
        const rows = db.prepare("SELECT * FROM pedidos ORDER BY creado DESC").all();
        const cols = ["folio", "creado", "estado", "modelo", "precio", "envio", "anticipo", "pagado", "nombre", "apellido", "telefono", "email", "calle", "colonia", "cp", "ciudad", "estado_dir", "pais", "referencias", "entrega"];
        const q = (v) => { let s = String(v ?? ""); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
        const csv = "﻿" + [cols.join(","), ...rows.map((r) => cols.map((c) => q(r[c])).join(","))].join("\r\n");
        return send(res, 200, csv, "text/csv; charset=utf-8", { "Content-Disposition": 'attachment; filename="pedidos-la-gitanilla.csv"' });
      }
      if ((m = /^\/api\/admin\/pedidos\/([A-Z0-9]{6,12})$/.exec(p)) && M === "PATCH") {
        const o = getOrder(m[1]); if (!o) return send(res, 404, { error: "No existe" });
        const b = await readBody(req, 10_000);
        if (b.accion === "cobrar_restante") db.prepare("UPDATE pedidos SET cobrar_restante=1, actualizado=? WHERE code=?").run(now(), o.code);
        else if (b.accion === "pago_manual") {
          const monto = money(b.monto); if (!(monto > 0)) return send(res, 400, { error: "Monto inválido" });
          recordPayment(o.code, "manual-" + crypto.randomUUID(), monto, str(b.metodo, 40) || "transferencia", "approved");
        } else if (["en_taller", "enviado", "entregado", "cancelado"].includes(b.accion)) db.prepare("UPDATE pedidos SET estado=?, actualizado=? WHERE code=?").run(b.accion, now(), o.code);
        else return send(res, 400, { error: "Acción desconocida" });
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: "No encontrado" });
    }
    return send(res, 404, "Página no encontrada", "text/plain; charset=utf-8");
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status === 413 ? "El archivo es demasiado grande." : "Ocurrió un error. Intenta de nuevo." });
  }
});
server.listen(PORT, () => console.log(`La Gitanilla escuchando en ${PORT} · datos en ${DATA_DIR}${PERSISTENT ? "" : " (SIN VOLUMEN: se borran al actualizar)"}`));
