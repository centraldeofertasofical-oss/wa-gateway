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
app.use(express.json({ limit: "10mb" }));

// Railway usa process.env.PORT.
// Fallback local:
const PORT = Number(process.env.PORT || 8080);

// ====== Estado em memória ======
let connState = "starting"; // starting | connecting | open | close
let lastError = null;

let latestQrText = null;
let latestQrDataUrl = null;

let sock = null;
let isStarting = false;

// ====== Helpers ======
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  if (!valor) return "";

  // grupo
  if (valor.endsWith("@g.us")) return valor;

  // contato já normalizado
  if (valor.endsWith("@s.whatsapp.net")) return valor;

  // contato numérico
  const digits = valor.replace(/\D/g, "");
  return `${digits}@s.whatsapp.net`;
}

function limparQr() {
  latestQrText = null;
  latestQrDataUrl = null;
}

// ====== WhatsApp / Baileys ======
async function startWhatsApp() {
  if (isStarting || connState === "open" || connState === "connecting") return;

  isStarting = true;
  connState = "connecting";
  setError(null);

  try {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info");
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      browser: Browsers.ubuntu("wa-gateway"),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: true,
      defaultQueryTimeoutMs: 60_000,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        latestQrText = qr;
        latestQrDataUrl = await makeQrDataUrl(qr);
      }

      if (connection) {
        connState = connection;
      }

      if (connection === "open") {
        connState = "open";
        setError(null);
        limparQr();
        console.log("[WA] conectado");
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason =
          statusCode !== undefined
            ? DisconnectReason[statusCode] || statusCode
            : "unknown";

        setError(lastDisconnect?.error || `Connection closed: ${reason}`);
        limparQr();

        if (statusCode === DisconnectReason.loggedOut) {
          connState = "close";
          console.log("[WA] sessão desconectada. Será necessário escanear QR novamente.");
          return;
        }

        connState = "close";
        console.log("[WA] conexão fechada. Reconectando...");
        await sleep(2000);
        startWhatsApp().catch(setError);
      }
    });
  } catch (e) {
    setError(e);
    connState = "close";
    console.error("[WA] erro ao iniciar:", e);
    await sleep(3000);
    startWhatsApp().catch(setError);
  } finally {
    isStarting = false;
  }
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
      ok: false,
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
      ok: false,
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
      error: "Falha ao enviar texto",
      detail: lastError,
    });
  }
});

// ====== ENVIAR TEXTO PARA GRUPO ======
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

// ====== ENVIAR IMAGEM (CONTATO OU GRUPO) ======
app.post("/send-image", async (req, res) => {
  try {
    const { to, imageUrl, caption } = req.body || {};

    if (!to || !imageUrl) {
      return res.status(400).json({
        ok: false,
        error: "Campos obrigatórios: to, imageUrl",
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

    const msg = await sock.sendMessage(jid, {
      image: { url: String(imageUrl) },
      caption: String(caption || ""),
    });

    return res.json({
      ok: true,
      to: jid,
      messageId: msg?.key?.id || null,
    });
  } catch (e) {
    setError(e);
    console.error(e);
    return res.status(500).json({
      ok: false,
      error: "Falha ao enviar imagem",
      detail: lastError,
    });
  }
});

// ====== ENVIAR IMAGEM ESPECÍFICA PARA GRUPO ======
app.post("/send-group-image", async (req, res) => {
  try {
    const { groupId, imageUrl, caption } = req.body || {};

    if (!groupId || !imageUrl) {
      return res.status(400).json({
        ok: false,
        error: "Campos obrigatórios: groupId, imageUrl",
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

    const msg = await sock.sendMessage(String(groupId), {
      image: { url: String(imageUrl) },
      caption: String(caption || ""),
    });

    return res.json({
      ok: true,
      groupId: String(groupId),
      messageId: msg?.key?.id || null,
    });
  } catch (e) {
    setError(e);
    console.error(e);
    return res.status(500).json({
      ok: false,
      error: "Falha ao enviar imagem para grupo",
      detail: lastError,
    });
  }
});

// ====== START HTTP ======
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
