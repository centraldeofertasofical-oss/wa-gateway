// src/server.js
import express from "express";
import QRCode from "qrcode";

import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  Browsers,
} from "@whiskeysockets/baileys";

const app = express();
app.disable("x-powered-by");

// ====== Estado em memória ======
let connState = "starting"; // starting | connecting | open | close
let lastError = null;

let latestQrText = null; // string do QR (curta)
let latestQrDataUrl = null; // base64 data:image/png

let sock = null;

// ====== Helpers ======
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setQr(qrText) {
  latestQrText = qrText || null;
  latestQrDataUrl = qrText
    ? await QRCode.toDataURL(qrText, { margin: 2, scale: 8 })
    : null;
}

async function startWhatsApp() {
  try {
    connState = "connecting";
    lastError = null;

    const { state, saveCreds } = await useMultiFileAuthState("./auth");
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false, // deprecated -> a gente serve via /qr
      browser: Browsers.macOS("Chrome"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      defaultQueryTimeoutMs: 60_000,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        await setQr(qr);
      }

      if (connection) {
        connState = connection; // 'open' | 'close' | 'connecting'
        if (connection === "open") {
          // quando conecta, não precisa mais do QR
          await setQr(null);
        }
      }

      if (connection === "close") {
        const statusCode =
          lastDisconnect?.error?.output?.statusCode ||
          lastDisconnect?.error?.output?.payload?.statusCode;

        const reason =
          lastDisconnect?.error?.output?.payload?.message ||
          lastDisconnect?.error?.message ||
          "Connection closed";

        lastError = { statusCode, reason };

        const shouldReconnect =
          statusCode !== DisconnectReason.loggedOut &&
          statusCode !== 401; // logged out

        if (shouldReconnect) {
          // evita loop agressivo
          await sleep(2500);
          startWhatsApp();
        } else {
          // logged out => precisa apagar auth e gerar novo QR
          await setQr(null);
          connState = "close";
        }
      }
    });

    return sock;
  } catch (err) {
    lastError = { reason: String(err?.message || err) };
    connState = "close";
    // tenta novamente
    await sleep(3000);
    startWhatsApp();
  }
}

// ====== Rotas ======
app.get("/", (req, res) => {
  res.type("html").send(`
    <html>
      <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
      <body style="font-family: Arial, sans-serif; padding: 16px;">
        <h2>wa-gateway</h2>
        <p>Status: <b>${connState}</b></p>
        <ul>
          <li><a href="/qr">/qr</a> (abrir QR para parear)</li>
          <li><a href="/health">/health</a></li>
        </ul>
      </body>
    </html>
  `);
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    state: connState,
    hasQr: Boolean(latestQrDataUrl),
    error: lastError,
  });
});

// API para o front buscar o QR
app.get("/qr-data", (req, res) => {
  res.json({
    state: connState,
    qrDataUrl: latestQrDataUrl, // data:image/png;base64,...
    error: lastError,
  });
});

// Página bonitinha do QR (funciona no celular)
app.get("/qr", (req, res) => {
  res.type("html").send(`
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>QR - wa-gateway</title>
      <style>
        body { font-family: Arial, sans-serif; background:#0b0f19; color:#e8eefc; margin:0; padding:24px; }
        .card { max-width:520px; margin:0 auto; background:#121a2a; border:1px solid rgba(255,255,255,.08); border-radius:16px; padding:18px; }
        .row { display:flex; align-items:center; justify-content:space-between; gap:12px; }
        .pill { padding:6px 10px; border-radius:999px; background:rgba(255,255,255,.08); font-size:12px; }
        .imgwrap { margin-top:14px; display:flex; justify-content:center; }
        img { width:360px; max-width:100%; background:#fff; border-radius:12px; padding:10px; display:none; }
        .msg { margin-top:12px; opacity:.9; }
        .err { margin-top:12px; color:#ffb4b4; font-size:13px; white-space:pre-wrap; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="row">
          <h2 style="margin:0;">Parear WhatsApp</h2>
          <div class="pill" id="st">...</div>
        </div>

        <div class="msg" id="msg">Carregando QR...</div>
        <div class="imgwrap">
          <img id="qrimg" alt="QR Code" />
        </div>
        <div class="err" id="err"></div>

        <p style="margin-top:14px; font-size:13px; opacity:.85">
          Abra o WhatsApp no celular → <b>Aparelhos conectados</b> → <b>Conectar um aparelho</b> → aponte a câmera para o QR.
        </p>
      </div>

      <script>
        const st = document.getElementById('st');
        const img = document.getElementById('qrimg');
        const msg = document.getElementById('msg');
        const err = document.getElementById('err');

        async function tick(){
          try{
            const r = await fetch('/qr-data', { cache: 'no-store' });
            const j = await r.json();

            st.textContent = j.state || '...';

            if (j.error) {
              err.textContent = "Erro: " + (j.error.reason || JSON.stringify(j.error));
            } else {
              err.textContent = "";
            }

            if (j.state === 'open') {
              msg.textContent = "✅ Conectado! Você já pode fechar esta página.";
              img.style.display = 'none';
              img.removeAttribute('src');
              return;
            }

            if (j.qrDataUrl) {
              msg.textContent = "Escaneie o QR abaixo:";
              img.src = j.qrDataUrl;
              img.style.display = 'block';
            } else {
              msg.textContent = "QR ainda não gerado. Aguarde...";
              img.style.display = 'none';
              img.removeAttribute('src');
            }
          } catch(e){
            err.textContent = "Erro ao buscar QR: " + (e?.message || e);
          }
        }

        tick();
        setInterval(tick, 1500);
      </script>
    </body>
  </html>
  `);
});

// ====== Start ======
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log("Servidor HTTP rodando na porta:", PORT);
  startWhatsApp();
});
