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

// ====== PORTA CERTA (Railway) ======
const PORT = Number(process.env.PORT || 8080);

// ====== Estado em memória ======
let connState = "starting"; // starting | connecting | open | close
let lastError = null;

let latestQrText = null;
let latestQrDataUrl = null;

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

function normalizarDestino(to) {
  const valor = String(to || "").trim();

  // grupo
  if (valor.endsWith("@g.us")) return valor;

  // contato
  const digits = valor.replace(/\D/g, "");
  return digits.includes("@s.whatsapp.net")
    ? digits
    : `${digits}@s.whatsapp.net`;
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
    printQRInTerminal: false,
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

      latestQrText = null;
      latestQrDataUrl = null;

      if (statusCode === DisconnectReason.loggedOut) {
        connState = "close";
        return;
      }

      await sleep(2000);
      startWhatsApp().catch(setError);
    }

    if (connection === "open") {
      connState = "open";
      setError(null);
      latestQrText = null;
      latestQrDataUrl = null;
      console.log("[WA] conectado");
    }
  });

  return sock;
}

// inicia ao subir
startWhatsApp().catch(setError);

// ====== Rotas básicas ======
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

// ====== QR ======
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
    return res.status(500).json({
      error: "Falha ao gerar QR",
      detail: lastError,
    });
  }
});

app.get("/qr", (req, res) => {
  if (!latestQrDataUrl) {
    return res.status(404).send(`
      <html>
        <body style="font-family:Arial;padding:16px;">
          <h3>QR indisponível</h3>
          <p>Estado: <b>${connState}</b></p>
          <pre>${lastError || ""}</pre>
        </body>
      </html>
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

// ====== LISTAR GRUPOS ======
app.get("/groups", async (req, res) => {
  try {
    if (!sock || connState !== "open") {
      return res.status(503).json({
        ok: false,
        error: "WhatsApp não conectado",
        state: connState,
        detail: lastError,
      });
    }

    const groups = await sock.groupFetchAllParticipating();

    const result = Object.values(groups)
      .map((g) => ({
        id: g.id,
        name: g.subject,
        participantsCount: Array.isArray(g.participants) ? g.participants.length : 0,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

    return res.json({
      ok: true,
      total: result.length,
      groups: result,
    });
  } catch (e) {
    setError(e);
    return res.status(500).json({
      ok: false,
      error: "Falha ao listar grupos",
      detail: lastError,
    });
  }
});

// ====== ENVIAR TEXTO (CONTATO OU GRUPO) ======
app.post("/send", async (req, res) => {
  try {
    const { to, text } = req.body || {};

    if (!to || !text) {
      return res.status(400).json({
        ok: false,
        error: "Campos obrigatórios: to, text",
      });
    }

    if (!sock || connState !== "open") {
      return res.status(503).json({
        ok: false,
        error: "WhatsApp não conectado",
        state: connState,
        detail: lastError,
      });
    }

    const jid = normalizarDestino(to);
    const resp = await sock.sendMessage(jid, { text: String(text) });

    return res.json({
      ok: true,
      to: jid,
      messageId: resp?.key?.id || null,
    });
  } catch (e) {
    setError(e);
    return res.status(500).json({
      ok: false,
      error: "Falha ao enviar",
      detail: lastError,
    });
  }
});

// ====== ENVIAR TEXTO ESPECÍFICO PARA GRUPO ======
app.post("/send-group", async (req, res) => {
  try {
    const { groupId, text } = req.body || {};

    if (!groupId || !text) {
      return res.status(400).json({
        ok: false,
        error: "Campos obrigatórios: groupId, text",
      });
    }

    if (!String(groupId).endsWith("@g.us")) {
      return res.status(400).json({
        ok: false,
        error: "groupId inválido. Use o formato 1203...@g.us",
      });
    }

    if (!sock || connState !== "open") {
      return res.status(503).json({
        ok: false,
        error: "WhatsApp não conectado",
        state: connState,
        detail: lastError,
      });
    }

    const resp = await sock.sendMessage(String(groupId), { text: String(text) });

    return res.json({
      ok: true,
      groupId: String(groupId),
      messageId: resp?.key?.id || null,
    });
  } catch (e) {
    setError(e);
    return res.status(500).json({
      ok: false,
      error: "Falha ao enviar para grupo",
      detail: lastError,
    });
  }
});

app.post("/send-image", async (req, res) => {
  try {

    const { to, imageUrl, caption } = req.body;

    if (!to || !imageUrl) {
      return res.status(400).json({
        ok: false,
        error: "Campos obrigatórios: to, imageUrl"
      });
    }

    if (!sock || connState !== "open") {
      return res.status(503).json({
        ok: false,
        error: "WhatsApp não conectado",
        state: connState
      });
    }

    const jid = to.includes("@")
      ? to
      : `${to.replace(/\D/g, "")}@s.whatsapp.net`;

    const msg = await sock.sendMessage(jid, {
      image: { url: imageUrl },
      caption: caption || ""
    });

    return res.json({
      ok: true,
      messageId: msg?.key?.id,
      to: jid
    });

  } catch (err) {

    console.error(err);

    return res.status(500).json({
      ok: false,
      error: "Falha ao enviar imagem"
    });

  }
});


// ====== START HTTP ======
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
