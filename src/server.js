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
app.use(express.json({ limit: "2mb" }));

// ====== Estado em memória ======
let connState = "starting"; // starting | connecting | open | close
let lastError = null;

let latestQrText = null; // texto do QR (curto)
let latestQrDataUrl = null; // base64 data:image/png

let sock = null;

// ====== Helpers ======
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setError(err) {
  lastError = err ? String(err?.message || err) : null;
}

async function makeQrDataUrl(text) {
  try {
    return await QRCode.toDataURL(text, { margin: 1, scale: 8 });
  } catch (e) {
    setError(e);
    return null;
  }
}

// ====== Baileys / WhatsApp ======
async function startWhatsApp() {
  if (connState === "connecting" || connState === "open") return;

  connState = "connecting";
  setError(null);

  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    browser: Browsers.ubuntu("wa-gateway"),
    printQRInTerminal: false, // deprecado no baileys novo
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    defaultQueryTimeoutMs: 60_000,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQrText = qr;
      latestQrDataUrl = await makeQrDataUrl(qr);
    }

    if (connection) connState = connection;

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason =
        statusCode !== undefined
          ? DisconnectReason[statusCode] || statusCode
          : "unknown";

      setError(lastDisconnect?.error || `Connection closed: ${reason}`);

      // limpa QR quando desconectar
      latestQrText = null;
      latestQrDataUrl = null;

      // Reconecta (exceto quando realmente deslogou)
      if (statusCode === DisconnectReason.loggedOut) {
        // não reconecta automaticamente se deslogou
        connState = "close";
        return;
      }

      // backoff simples
      await sleep(2000);
      startWhatsApp().catch(setError);
    }

    if (connection === "open") {
      connState = "open";
      setError(null);
      // QR não precisa mais
      latestQrText = null;
      latestQrDataUrl = null;
    }
  });

  return sock;
}

// inicia ao subir
startWhatsApp().catch(setError);

// ====== Rotas ======
app.get("/", (req, res) => {
  res.status(200).send("WA Gateway Online");
});

app.get("/health", (req, res) => {
  res.json({
    ok: connState === "open",
    state: connState,
    hasQr: !!latestQrDataUrl,
    error: lastError,
  });
});

// Retorna o QR em PNG (recomendado)
app.get("/qr.png", async (req, res) => {
  if (!latestQrText) {
    return res.status(404).json({
      error: "QR indisponível",
      state: connState,
      detail: lastError,
    });
  }

  try {
    const buffer = await QRCode.toBuffer(latestQrText, { margin: 1, scale: 8 });
    res.setHeader("Content-Type", "image/png");
    return res.status(200).send(buffer);
  } catch (e) {
    setError(e);
    return res.status(500).json({ error: "Falha ao gerar QR", detail: lastError });
  }
});

// Retorna QR como HTML (pra abrir no navegador e escanear)
app.get("/qr", (req, res) => {
  if (!latestQrDataUrl) {
    return res.status(404).send(`
      <html><body style="font-family:Arial;padding:16px;">
        <h3>QR indisponível</h3>
        <p>Estado: <b>${connState}</b></p>
        <pre>${lastError || ""}</pre>
      </body></html>
    `);
  }

  return res.status(200).send(`
    <html>
      <body style="font-family: Arial; padding: 16px;">
        <h2>Escaneie o QR no WhatsApp</h2>
        <p>Atualize a página se expirar.</p>
        <img src="${latestQrDataUrl}" style="width:320px;height:320px;border:1px solid #ddd;" />
        <p>Estado: <b>${connState}</b></p>
      </body>
    </html>
  `);
});

// Enviar mensagem (pra usar no n8n)
app.post("/send", async (req, res) => {
  try {
    const { to, text } = req.body || {};
    if (!to || !text) {
      return res.status(400).json({ error: "Campos obrigatórios: to, text" });
    }

    if (!sock || connState !== "open") {
      return res.status(503).json({
        error: "WhatsApp não conectado",
        state: connState,
        detail: lastError,
      });
    }

    // normaliza número -> JID
    const digits = String(to).replace(/\D/g, "");
    const jid = digits.includes("@s.whatsapp.net")
      ? digits
      : `${digits}@s.whatsapp.net`;

    const resp = await sock.sendMessage(jid, { text: String(text) });

    return res.json({ ok: true, jid, messageId: resp?.key?.id || null });
  } catch (e) {
    setError(e);
    return res.status(500).json({ ok: false, error: "Falha ao enviar", detail: lastError });
  }
});

// ====== PORTA (Railway) ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
