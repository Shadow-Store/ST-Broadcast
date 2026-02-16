const fs = require("fs");
const path = require("path");
const express = require("express");
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionsBitField,
  ChannelSelectMenuBuilder,
  ChannelType,
  StringSelectMenuBuilder,
} = require("discord.js");

const config = require("./config.json");

// =============================
// Safety: prevent process crash
// =============================
process.on("unhandledRejection", (reason) =>
  console.error("UnhandledRejection:", reason),
);
process.on("uncaughtException", (err) =>
  console.error("UncaughtException:", err),
);

// =============================
// Files
// =============================
const TEMPLATES_PATH = path.join(__dirname, "templates.json");
const JOBS_PATH = path.join(__dirname, "jobs.json");

function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

let templates = readJSON(TEMPLATES_PATH, {});
let jobs = readJSON(JOBS_PATH, {});

// =============================
// Discord Client
// =============================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    // لو بدك Online/Offline يشتغل صح:
    // 1) فعّل Presence Intent من البورتال
    // 2) فك تعليق السطر التالي:
    // GatewayIntentBits.GuildPresences,
  ],
});

client.on("error", (err) => console.error("Client error:", err));

// =============================
// Permissions (No cooldown here)
// =============================
function requireAllowed(interactionOrMessage) {
  const member = interactionOrMessage.member;
  const roleId = config.allowedRoleId;

  if (!member) return { ok: false, reason: "❌ لا يوجد member." };

  if (roleId && !member.roles?.cache?.has(roleId)) {
    return { ok: false, reason: "❗ ليس لديك صلاحية (Role) لاستخدام النظام." };
  }

  if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    return {
      ok: false,
      reason: "❗ ليس لديك صلاحية (Administrator) لاستخدام النظام.",
    };
  }

  return { ok: true };
}

// =============================
// Cooldown ONLY on sending
// =============================
const cooldownSeconds = Number(config.cooldownSeconds ?? 30);
const dailyLimit = Number(config.dailyLimit ?? 30);

const userCooldown = new Map(); // userId -> lastTs
const dailyCounters = new Map(); // userId -> {dateKey,count}

function nowDateKey() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function checkSendCooldown(userId) {
  const now = Date.now();

  const last = userCooldown.get(userId) || 0;
  if (now - last < cooldownSeconds * 1000) {
    const wait = Math.ceil((cooldownSeconds * 1000 - (now - last)) / 1000);
    return {
      ok: false,
      reason: `⏳ انتظر ${wait} ثانية قبل إرسال Broadcast جديد.`,
    };
  }

  const dateKey = nowDateKey();
  const entry = dailyCounters.get(userId) || { dateKey, count: 0 };
  if (entry.dateKey !== dateKey) {
    entry.dateKey = dateKey;
    entry.count = 0;
  }
  if (entry.count >= dailyLimit) {
    return { ok: false, reason: `🛡️ وصلت حد الإرسال اليومي (${dailyLimit}).` };
  }

  return { ok: true };
}

function bumpSendUsage(userId) {
  userCooldown.set(userId, Date.now());
  const dateKey = nowDateKey();
  const entry = dailyCounters.get(userId) || { dateKey, count: 0 };
  if (entry.dateKey !== dateKey) {
    entry.dateKey = dateKey;
    entry.count = 0;
  }
  entry.count++;
  dailyCounters.set(userId, entry);
}

// =============================
// Drafts + Controllers
// =============================
/**
 * drafts: userId -> {
 *   guildId,
 *   target: "channel" | "dm",
 *   channelId: string|null,
 *   dmMode: "all" | "online" | "offline",
 *   payload: { embedData, ctas: [{label,url}...] }
 * }
 */
const drafts = new Map();
const sendControllers = new Map(); // key -> { canceled: boolean }

// =============================
// Helpers
// =============================
function sanitizeHexColor(colorRaw) {
  const c = (colorRaw || "").trim();
  if (!c) return undefined;
  if (!/^#?[0-9a-f]{6}$/i.test(c)) return undefined;
  return c.startsWith("#") ? c : `#${c}`;
}

function isValidUrl(u) {
  return typeof u === "string" && /^https?:\/\//i.test(u.trim());
}

function buildEmbedFromData(embedData) {
  const e = new EmbedBuilder();
  if (embedData.color) e.setColor(embedData.color);
  if (embedData.title) e.setTitle(embedData.title);
  if (embedData.description) e.setDescription(embedData.description);
  if (embedData.imageUrl) e.setImage(embedData.imageUrl);
  if (embedData.footer) e.setFooter({ text: embedData.footer });
  e.setTimestamp(new Date());
  return e;
}

// ✅ CTA rows (شكل زي الصورة): Link buttons + تقسيم على صفوف 5
// Discord limits: 5 buttons per row, 5 rows per message => 25 buttons max
function buildCTAComponents(ctas) {
  const valid = (ctas || [])
    .filter((c) => c?.label && c?.url && isValidUrl(c.url))
    .slice(0, 25);

  if (!valid.length) return [];

  const rows = [];
  for (let i = 0; i < valid.length; i += 5) {
    const chunk = valid.slice(i, i + 5);
    const row = new ActionRowBuilder();
    for (const c of chunk) {
      row.addComponents(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link) // هذا اللي يعطي شكل الصورة + أيقونة خارجية
          .setLabel(String(c.label).slice(0, 80))
          .setURL(String(c.url).trim()),
      );
    }
    rows.push(row);
  }
  return rows;
}

function makeJobId() {
  return `job_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function parseScheduleInput(input) {
  const s = (input || "").trim();

  // in 10m / in 2h / in 1d
  const m = /^in\s+(\d+)\s*([mhd])$/i.exec(s);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    let ms = 0;
    if (unit === "m") ms = n * 60 * 1000;
    if (unit === "h") ms = n * 60 * 60 * 1000;
    if (unit === "d") ms = n * 24 * 60 * 60 * 1000;
    return Date.now() + ms;
  }

  // 2026-02-08 21:30
  const isoLike = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/.exec(s);
  if (isoLike) {
    const [_, Y, M, D, hh, mm] = isoLike;
    const dt = new Date(
      Number(Y),
      Number(M) - 1,
      Number(D),
      Number(hh),
      Number(mm),
      0,
    );
    const ts = dt.getTime();
    if (!Number.isFinite(ts)) return null;
    return ts;
  }

  return null;
}

// =============================
// UI
// =============================
function panelEmbed() {
  return new EmbedBuilder()
    .setColor("#716360")
    .setTitle("📣 Broadcast System (Channel + DM)")
    .setThumbnail(config.image || null)
    .setDescription(
      [
        "> اختر العملية:",
        "• ➕ Broadcast جديد (Embed Builder + Preview)",
        "• 📦 Templates (حفظ/تحميل/حذف)",
        "• ⏰ Jobs (عرض/إلغاء)",
      ].join("\n"),
    );
}

function panelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("bc_new")
      .setLabel("➕ Broadcast جديد")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("bc_templates")
      .setLabel("📦 Templates")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("bc_jobs")
      .setLabel("⏰ Jobs")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("bc_help")
      .setLabel("ℹ️ Help")
      .setStyle(ButtonStyle.Secondary),
  );
}

function draftRows() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("draft_target")
      .setLabel("🎯 Target (Channel/DM)")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("draft_pick_channel")
      .setLabel("📌 اختيار قناة")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("draft_dm_mode")
      .setLabel("👤 DM Mode")
      .setStyle(ButtonStyle.Secondary),
    // ✅ add one CTA per submit (repeat to add many)
    new ButtonBuilder()
      .setCustomId("draft_add_cta")
      .setLabel("➕ Add CTA")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("draft_clear_cta")
      .setLabel("🧹 Clear CTA")
      .setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("draft_schedule")
      .setLabel("⏰ جدولة")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("draft_send_now")
      .setLabel("✅ إرسال الآن")
      .setStyle(ButtonStyle.Success),
  );

  return [row1, row2];
}

function cancelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("draft_cancel")
      .setLabel("🛑 Cancel Draft")
      .setStyle(ButtonStyle.Danger),
  );
}

function confirmRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("confirm_send")
      .setLabel("✅ Confirm إرسال")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("draft_cancel")
      .setLabel("🛑 Cancel Draft")
      .setStyle(ButtonStyle.Danger),
  );
}

function templatesRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("tpl_save")
      .setLabel("💾 حفظ Template من Draft")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("tpl_load")
      .setLabel("📥 تحميل Template")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("tpl_delete")
      .setLabel("🗑️ حذف Template")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("back_panel")
      .setLabel("⬅️ رجوع")
      .setStyle(ButtonStyle.Secondary),
  );
}

function jobsRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("jobs_list")
      .setLabel("📄 عرض Jobs")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("jobs_cancel")
      .setLabel("🛑 إلغاء Job")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("back_panel")
      .setLabel("⬅️ رجوع")
      .setStyle(ButtonStyle.Secondary),
  );
}

// =============================
// Send logic
// =============================
async function sendToChannel({ guildId, channelId, payload, controllerKey }) {
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) throw new Error("Guild not found");

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    throw new Error("Channel not found or not text-based");
  }

  const ctrl = sendControllers.get(controllerKey) || { canceled: false };
  sendControllers.set(controllerKey, ctrl);
  if (ctrl.canceled) throw new Error("Canceled");

  const embed = buildEmbedFromData(payload.embedData);
  const rows = buildCTAComponents(payload.ctas);

  await channel.send({ embeds: [embed], components: rows });
}

async function sendDMToMembers({ guildId, mode, payload, controllerKey }) {
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) throw new Error("Guild not found");

  await guild.members.fetch();

  const ctrl = sendControllers.get(controllerKey) || { canceled: false };
  sendControllers.set(controllerKey, ctrl);

  let members = guild.members.cache.filter((m) => !m.user.bot);

  if (mode === "online") {
    members = members.filter(
      (m) => m.presence?.status && m.presence.status !== "offline",
    );
  } else if (mode === "offline") {
    members = members.filter(
      (m) => !m.presence?.status || m.presence.status === "offline",
    );
  }

  const embed = buildEmbedFromData(payload.embedData);
  const rows = buildCTAComponents(payload.ctas);

  let sent = 0;
  let failed = 0;

  for (const member of members.values()) {
    if (ctrl.canceled) break;
    try {
      await member.send({ embeds: [embed], components: rows });
      sent++;
    } catch {
      failed++;
    }
  }

  return { sent, failed, total: members.size, canceled: ctrl.canceled };
}

// =============================
// Jobs Scheduler
// =============================
async function scheduleJob(jobId) {
  const job = jobs[jobId];
  if (!job || job.status !== "scheduled") return;

  const delay = Math.max(0, job.runAt - Date.now());

  setTimeout(async () => {
    jobs = readJSON(JOBS_PATH, {});
    const j = jobs[jobId];
    if (!j || j.status !== "scheduled") return;

    sendControllers.set(jobId, { canceled: false });

    try {
      if (j.type === "channel") {
        await sendToChannel({
          guildId: j.guildId,
          channelId: j.channelId,
          payload: j.payload,
          controllerKey: jobId,
        });
      } else if (j.type === "dm") {
        const r = await sendDMToMembers({
          guildId: j.guildId,
          mode: j.dmMode || "all",
          payload: j.payload,
          controllerKey: jobId,
        });
        j.result = r;
      }

      j.status = "sent";
      j.sentAt = Date.now();
      jobs[jobId] = j;
      writeJSON(JOBS_PATH, jobs);
    } catch (e) {
      j.status = "failed";
      j.error = String(e?.message || e);
      jobs[jobId] = j;
      writeJSON(JOBS_PATH, jobs);
    } finally {
      sendControllers.delete(jobId);
    }
  }, delay);
}

function bootScheduler() {
  for (const jobId of Object.keys(jobs)) {
    const job = jobs[jobId];
    if (job?.status === "scheduled" && job.runAt > Date.now() - 60_000) {
      scheduleJob(jobId);
    }
  }
}

// =============================
// Ready
// =============================
client.once("ready", () => {
  console.log(`✅ bot is ready: ${client.user.tag}`);
  console.log("https://discord.gg/HCskVYZPtB");
  jobs = readJSON(JOBS_PATH, {});
  bootScheduler();
});

// =============================
// Command: !b
// =============================
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;
  if (message.content.trim() !== "!b") return;

  const allowed = requireAllowed(message);
  if (!allowed.ok) return message.reply({ content: allowed.reason });

  return message.reply({
    embeds: [panelEmbed()],
    components: [panelRow()],
  });
});

// =============================
// Interactions
// =============================
client.on("interactionCreate", async (interaction) => {
  try {
    if (
      interaction.isButton() ||
      interaction.isModalSubmit() ||
      interaction.isStringSelectMenu() ||
      interaction.isChannelSelectMenu()
    ) {
      const allowed = requireAllowed(interaction);
      if (!allowed.ok)
        return interaction.reply({ content: allowed.reason, flags: 64 });
    }

    // Help
    if (interaction.isButton() && interaction.customId === "bc_help") {
      return interaction.reply({
        content: [
          "ℹ️ **Help**",
          "- `!b` فتح لوحة التحكم",
          "- Broadcast جديد: Build Embed → Preview → Target → CTA (Add multiple) → Confirm / Schedule",
          "",
          "**Schedule formats:**",
          "- `in 10m` / `in 2h` / `in 1d`",
          "- `2026-02-08 21:30`",
          "",
          "⚠️ Online/Offline يحتاج Presence Intent من البورتال + GuildPresences intent.",
          "✅ CTA limit: 25 buttons (5 صفوف × 5 أزرار)",
        ].join("\n"),
        flags: 64,
      });
    }

    if (interaction.isButton() && interaction.customId === "back_panel") {
      return interaction.reply({
        embeds: [panelEmbed()],
        components: [panelRow()],
        flags: 64,
      });
    }

    if (interaction.isButton() && interaction.customId === "bc_templates") {
      return interaction.reply({
        content: "📦 Templates",
        components: [templatesRow()],
        flags: 64,
      });
    }

    if (interaction.isButton() && interaction.customId === "bc_jobs") {
      return interaction.reply({
        content: "⏰ Jobs",
        components: [jobsRow()],
        flags: 64,
      });
    }

    // New broadcast -> Embed Builder modal
    if (interaction.isButton() && interaction.customId === "bc_new") {
      const modal = new ModalBuilder()
        .setCustomId("modal_embed_builder")
        .setTitle("🧩 Embed Builder");

      const title = new TextInputBuilder()
        .setCustomId("title")
        .setLabel("Title (اختياري)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

      const description = new TextInputBuilder()
        .setCustomId("description")
        .setLabel("Description")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);

      const color = new TextInputBuilder()
        .setCustomId("color")
        .setLabel("Color HEX (مثال: #716360) اختياري")
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

      const imageUrl = new TextInputBuilder()
        .setCustomId("imageUrl")
        .setLabel("Image URL (اختياري)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

      const footer = new TextInputBuilder()
        .setCustomId("footer")
        .setLabel("Footer (اختياري)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

      modal.addComponents(
        new ActionRowBuilder().addComponents(title),
        new ActionRowBuilder().addComponents(description),
        new ActionRowBuilder().addComponents(color),
        new ActionRowBuilder().addComponents(imageUrl),
        new ActionRowBuilder().addComponents(footer),
      );

      return interaction.showModal(modal);
    }

    // Embed Builder submit -> draft + preview
    if (
      interaction.isModalSubmit() &&
      interaction.customId === "modal_embed_builder"
    ) {
      const title = (
        interaction.fields.getTextInputValue("title") || ""
      ).trim();
      const description = (
        interaction.fields.getTextInputValue("description") || ""
      ).trim();
      const color = sanitizeHexColor(
        interaction.fields.getTextInputValue("color") || "",
      );
      const imageUrlRaw = (
        interaction.fields.getTextInputValue("imageUrl") || ""
      ).trim();
      const footer = (
        interaction.fields.getTextInputValue("footer") || ""
      ).trim();

      const imageUrl = isValidUrl(imageUrlRaw) ? imageUrlRaw : undefined;

      const payload = {
        embedData: {
          title: title.slice(0, 256),
          description: description.slice(0, 4000),
          color,
          imageUrl,
          footer: footer.slice(0, 2048),
        },
        ctas: [],
      };

      drafts.set(interaction.user.id, {
        guildId: interaction.guildId,
        target: "channel",
        channelId: null,
        dmMode: "all",
        payload,
      });

      const embed = buildEmbedFromData(payload.embedData);

      return interaction.reply({
        content:
          "✅ **Preview جاهز** — اختر Target، وإذا Channel اختار قناة. \n🔗 لإضافة CTA اضغط **Add CTA** أكثر من مرة.",
        embeds: [embed],
        components: [...draftRows(), cancelRow()],
        flags: 64,
      });
    }

    // Draft: Target
    if (interaction.isButton() && interaction.customId === "draft_target") {
      const draft = drafts.get(interaction.user.id);
      if (!draft)
        return interaction.reply({ content: "❌ لا يوجد Draft.", flags: 64 });

      const menu = new StringSelectMenuBuilder()
        .setCustomId("select_target")
        .setPlaceholder("اختر Target")
        .addOptions(
          { label: "Channel", value: "channel", description: "إرسال إلى قناة" },
          { label: "DM", value: "dm", description: "إرسال خاص للأعضاء" },
        );

      return interaction.reply({
        content: "🎯 اختر Target:",
        components: [new ActionRowBuilder().addComponents(menu)],
        flags: 64,
      });
    }

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId === "select_target"
    ) {
      const draft = drafts.get(interaction.user.id);
      if (!draft)
        return interaction.reply({ content: "❌ لا يوجد Draft.", flags: 64 });

      draft.target = interaction.values[0] === "dm" ? "dm" : "channel";
      drafts.set(interaction.user.id, draft);

      return interaction.reply({
        content: `✅ Target صار: **${draft.target.toUpperCase()}**`,
        flags: 64,
      });
    }

    // Draft: Pick Channel
    if (
      interaction.isButton() &&
      interaction.customId === "draft_pick_channel"
    ) {
      const draft = drafts.get(interaction.user.id);
      if (!draft)
        return interaction.reply({ content: "❌ لا يوجد Draft.", flags: 64 });

      const menu = new ChannelSelectMenuBuilder()
        .setCustomId("select_channel_for_draft")
        .setPlaceholder("اختر قناة للإرسال")
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

      return interaction.reply({
        content: "📌 اختر القناة:",
        components: [new ActionRowBuilder().addComponents(menu)],
        flags: 64,
      });
    }

    if (
      interaction.isChannelSelectMenu() &&
      interaction.customId === "select_channel_for_draft"
    ) {
      const draft = drafts.get(interaction.user.id);
      if (!draft)
        return interaction.reply({ content: "❌ لا يوجد Draft.", flags: 64 });

      draft.channelId = interaction.values?.[0] || null;
      drafts.set(interaction.user.id, draft);

      return interaction.reply({
        content: `✅ تم تحديد القناة: <#${draft.channelId}>`,
        flags: 64,
      });
    }

    // Draft: DM Mode
    if (interaction.isButton() && interaction.customId === "draft_dm_mode") {
      const draft = drafts.get(interaction.user.id);
      if (!draft)
        return interaction.reply({ content: "❌ لا يوجد Draft.", flags: 64 });

      const menu = new StringSelectMenuBuilder()
        .setCustomId("select_dm_mode")
        .setPlaceholder("اختر DM Mode")
        .addOptions(
          { label: "All", value: "all", description: "يرسل لكل الأعضاء" },
          {
            label: "Online",
            value: "online",
            description: "يرسل للمتصلين فقط",
          },
          {
            label: "Offline",
            value: "offline",
            description: "يرسل لغير المتصلين",
          },
        );

      return interaction.reply({
        content: "👤 اختر وضع الـ DM:",
        components: [new ActionRowBuilder().addComponents(menu)],
        flags: 64,
      });
    }

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId === "select_dm_mode"
    ) {
      const draft = drafts.get(interaction.user.id);
      if (!draft)
        return interaction.reply({ content: "❌ لا يوجد Draft.", flags: 64 });

      draft.dmMode = interaction.values[0];
      drafts.set(interaction.user.id, draft);

      return interaction.reply({
        content: `✅ DM Mode صار: **${draft.dmMode.toUpperCase()}**`,
        flags: 64,
      });
    }

    // Draft: Add CTA (one at a time, repeat to add many)
    if (interaction.isButton() && interaction.customId === "draft_add_cta") {
      const draft = drafts.get(interaction.user.id);
      if (!draft)
        return interaction.reply({ content: "❌ لا يوجد Draft.", flags: 64 });

      if ((draft.payload.ctas?.length || 0) >= 25) {
        return interaction.reply({
          content: "❌ وصلت الحد الأقصى للـ CTA (25 زر).",
          flags: 64,
        });
      }

      const modal = new ModalBuilder()
        .setCustomId("modal_cta_add_one")
        .setTitle("➕ Add CTA");

      const label = new TextInputBuilder()
        .setCustomId("label")
        .setLabel("Button Text (مثال: GitHub)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const url = new TextInputBuilder()
        .setCustomId("url")
        .setLabel("URL (لازم يبدأ https://)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      modal.addComponents(
        new ActionRowBuilder().addComponents(label),
        new ActionRowBuilder().addComponents(url),
      );

      return interaction.showModal(modal);
    }

    if (
      interaction.isModalSubmit() &&
      interaction.customId === "modal_cta_add_one"
    ) {
      const draft = drafts.get(interaction.user.id);
      if (!draft)
        return interaction.reply({ content: "❌ لا يوجد Draft.", flags: 64 });

      const label = (
        interaction.fields.getTextInputValue("label") || ""
      ).trim();
      const url = (interaction.fields.getTextInputValue("url") || "").trim();

      if (!label || !isValidUrl(url)) {
        return interaction.reply({
          content: "❌ CTA غير صالح. تأكد إن الرابط يبدأ بـ https://",
          flags: 64,
        });
      }

      const ctas = Array.isArray(draft.payload.ctas) ? draft.payload.ctas : [];
      if (ctas.length >= 25) {
        return interaction.reply({
          content: "❌ وصلت الحد الأقصى للـ CTA (25 زر).",
          flags: 64,
        });
      }

      ctas.push({ label: label.slice(0, 80), url });
      draft.payload.ctas = ctas;
      drafts.set(interaction.user.id, draft);

      const embed = buildEmbedFromData(draft.payload.embedData);
      const rows = buildCTAComponents(draft.payload.ctas);

      return interaction.reply({
        content: `✅ تمت إضافة CTA. العدد الآن: **${draft.payload.ctas.length}**`,
        embeds: [embed],
        components: [...rows, ...draftRows(), cancelRow()],
        flags: 64,
      });
    }

    // Draft: Clear CTA
    if (interaction.isButton() && interaction.customId === "draft_clear_cta") {
      const draft = drafts.get(interaction.user.id);
      if (!draft)
        return interaction.reply({ content: "❌ لا يوجد Draft.", flags: 64 });

      draft.payload.ctas = [];
      drafts.set(interaction.user.id, draft);

      const embed = buildEmbedFromData(draft.payload.embedData);

      return interaction.reply({
        content: "✅ تم مسح جميع CTA.",
        embeds: [embed],
        components: [...draftRows(), cancelRow()],
        flags: 64,
      });
    }

    // Draft: Schedule (Cooldown هنا لأنه إرسال فعلي/جدولة)
    if (interaction.isButton() && interaction.customId === "draft_schedule") {
      const draft = drafts.get(interaction.user.id);
      if (!draft)
        return interaction.reply({ content: "❌ لا يوجد Draft.", flags: 64 });

      const modal = new ModalBuilder()
        .setCustomId("modal_schedule")
        .setTitle("⏰ Schedule");

      const when = new TextInputBuilder()
        .setCustomId("when")
        .setLabel("مثال: in 10m أو 2026-02-08 21:30")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(when));
      return interaction.showModal(modal);
    }

    if (
      interaction.isModalSubmit() &&
      interaction.customId === "modal_schedule"
    ) {
      const cd = checkSendCooldown(interaction.user.id);
      if (!cd.ok) return interaction.reply({ content: cd.reason, flags: 64 });
      bumpSendUsage(interaction.user.id);

      const draft = drafts.get(interaction.user.id);
      if (!draft)
        return interaction.reply({ content: "❌ لا يوجد Draft.", flags: 64 });

      const when = interaction.fields.getTextInputValue("when");
      const ts = parseScheduleInput(when);
      if (!ts || ts < Date.now() + 10_000) {
        return interaction.reply({
          content: "❌ وقت غير صالح (لازم بعد الآن بـ 10 ثواني+).",
          flags: 64,
        });
      }

      if (draft.target === "channel" && !draft.channelId) {
        return interaction.reply({
          content: "❌ لازم تختار قناة أولاً (Target=Channel).",
          flags: 64,
        });
      }

      const jobId = makeJobId();
      jobs[jobId] = {
        jobId,
        guildId: draft.guildId,
        type: draft.target,
        channelId: draft.target === "channel" ? draft.channelId : null,
        dmMode: draft.target === "dm" ? draft.dmMode : null,
        payload: draft.payload,
        runAt: ts,
        createdBy: interaction.user.id,
        status: "scheduled",
        createdAt: Date.now(),
      };

      writeJSON(JOBS_PATH, jobs);
      scheduleJob(jobId);
      drafts.delete(interaction.user.id);

      const targetInfo =
        jobs[jobId].type === "channel"
          ? `قناة: <#${jobs[jobId].channelId}>`
          : `DM Mode: **${jobs[jobId].dmMode.toUpperCase()}**`;

      return interaction.reply({
        content: `✅ تم جدولة الإرسال.\n🆔 Job: \`${jobId}\`\n🕒 وقت التنفيذ: <t:${Math.floor(
          ts / 1000,
        )}:F>\n${targetInfo}`,
        flags: 64,
      });
    }

    // Draft: Send now (Preview فقط)
    if (interaction.isButton() && interaction.customId === "draft_send_now") {
      const draft = drafts.get(interaction.user.id);
      if (!draft)
        return interaction.reply({ content: "❌ لا يوجد Draft.", flags: 64 });

      if (draft.target === "channel" && !draft.channelId) {
        return interaction.reply({
          content: "❌ لازم تختار قناة أولاً (Target=Channel).",
          flags: 64,
        });
      }

      const embed = buildEmbedFromData(draft.payload.embedData);
      const rows = buildCTAComponents(draft.payload.ctas);

      const where =
        draft.target === "channel"
          ? `⚠️ تأكيد الإرسال إلى: <#${draft.channelId}>`
          : `⚠️ تأكيد إرسال DM إلى: **${draft.dmMode.toUpperCase()}**`;

      return interaction.reply({
        content: where,
        embeds: [embed],
        components: [...rows, confirmRow()],
        flags: 64,
      });
    }

    // Confirm send (Cooldown هنا فقط + deferReply لتفادي Unknown interaction)
    if (interaction.isButton() && interaction.customId === "confirm_send") {
      const cd = checkSendCooldown(interaction.user.id);
      if (!cd.ok) return interaction.reply({ content: cd.reason, flags: 64 });
      bumpSendUsage(interaction.user.id);

      const draft = drafts.get(interaction.user.id);
      if (!draft)
        return interaction.reply({ content: "❌ لا يوجد Draft.", flags: 64 });

      const controllerKey = `send_${interaction.user.id}_${Date.now()}`;
      sendControllers.set(controllerKey, { canceled: false });

      await interaction.deferReply({ flags: 64 });

      try {
        if (draft.target === "channel") {
          await sendToChannel({
            guildId: draft.guildId,
            channelId: draft.channelId,
            payload: draft.payload,
            controllerKey,
          });

          drafts.delete(interaction.user.id);

          return interaction.editReply({
            content: `✅ تم الإرسال إلى <#${draft.channelId}>`,
          });
        } else {
          const r = await sendDMToMembers({
            guildId: draft.guildId,
            mode: draft.dmMode || "all",
            payload: draft.payload,
            controllerKey,
          });

          drafts.delete(interaction.user.id);

          return interaction.editReply({
            content:
              `✅ DM Broadcast انتهى.\n` +
              `📤 Sent: **${r.sent}** / ${r.total}\n` +
              `❌ Failed: **${r.failed}**\n` +
              `🛑 Canceled: **${r.canceled ? "Yes" : "No"}**`,
          });
        }
      } catch (e) {
        return interaction.editReply({
          content: `❌ فشل الإرسال: ${String(e?.message || e)}`,
        });
      } finally {
        sendControllers.delete(controllerKey);
      }
    }

    // Cancel Draft
    if (interaction.isButton() && interaction.customId === "draft_cancel") {
      drafts.delete(interaction.user.id);
      return interaction.reply({
        content: "🛑 تم إلغاء العملية وحذف الـ Draft.",
        flags: 64,
      });
    }

    // Templates
    if (interaction.isButton() && interaction.customId === "tpl_save") {
      const draft = drafts.get(interaction.user.id);
      if (!draft)
        return interaction.reply({
          content: "❌ لا يوجد Draft لحفظه كـ Template.",
          flags: 64,
        });

      const modal = new ModalBuilder()
        .setCustomId("modal_tpl_save")
        .setTitle("💾 Save Template");

      const name = new TextInputBuilder()
        .setCustomId("name")
        .setLabel("Template Name")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(name));
      return interaction.showModal(modal);
    }

    if (
      interaction.isModalSubmit() &&
      interaction.customId === "modal_tpl_save"
    ) {
      const draft = drafts.get(interaction.user.id);
      if (!draft)
        return interaction.reply({ content: "❌ لا يوجد Draft.", flags: 64 });

      const name = interaction.fields.getTextInputValue("name").trim();
      templates[name] = draft.payload;
      writeJSON(TEMPLATES_PATH, templates);

      return interaction.reply({
        content: `✅ تم حفظ Template باسم: **${name}**`,
        flags: 64,
      });
    }

    if (interaction.isButton() && interaction.customId === "tpl_load") {
      const keys = Object.keys(templates);
      if (!keys.length)
        return interaction.reply({
          content: "❌ لا يوجد Templates محفوظة.",
          flags: 64,
        });

      const menu = new StringSelectMenuBuilder()
        .setCustomId("select_tpl_load")
        .setPlaceholder("اختر Template")
        .addOptions(keys.slice(0, 25).map((k) => ({ label: k, value: k })));

      return interaction.reply({
        content: "📥 اختر Template للتحميل:",
        components: [new ActionRowBuilder().addComponents(menu)],
        flags: 64,
      });
    }

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId === "select_tpl_load"
    ) {
      const name = interaction.values[0];
      const tpl = templates[name];
      if (!tpl)
        return interaction.reply({
          content: "❌ Template غير موجود.",
          flags: 64,
        });

      drafts.set(interaction.user.id, {
        guildId: interaction.guildId,
        target: "channel",
        channelId: null,
        dmMode: "all",
        payload: tpl,
      });

      const embed = buildEmbedFromData(tpl.embedData);
      const rows = buildCTAComponents(tpl.ctas);

      return interaction.reply({
        content: `✅ تم تحميل Template: **${name}** (اختَر Target ثم قناة/DM Mode ثم Send/Schedule)`,
        embeds: [embed],
        components: [...rows, ...draftRows(), cancelRow()],
        flags: 64,
      });
    }

    if (interaction.isButton() && interaction.customId === "tpl_delete") {
      const keys = Object.keys(templates);
      if (!keys.length)
        return interaction.reply({
          content: "❌ لا يوجد Templates.",
          flags: 64,
        });

      const menu = new StringSelectMenuBuilder()
        .setCustomId("select_tpl_delete")
        .setPlaceholder("اختر Template للحذف")
        .addOptions(keys.slice(0, 25).map((k) => ({ label: k, value: k })));

      return interaction.reply({
        content: "🗑️ اختر Template للحذف:",
        components: [new ActionRowBuilder().addComponents(menu)],
        flags: 64,
      });
    }

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId === "select_tpl_delete"
    ) {
      const name = interaction.values[0];
      if (!templates[name])
        return interaction.reply({
          content: "❌ Template غير موجود.",
          flags: 64,
        });

      delete templates[name];
      writeJSON(TEMPLATES_PATH, templates);

      return interaction.reply({
        content: `✅ تم حذف Template: **${name}**`,
        flags: 64,
      });
    }

    // Jobs
    if (interaction.isButton() && interaction.customId === "jobs_list") {
      jobs = readJSON(JOBS_PATH, {});
      const entries = Object.values(jobs)
        .sort((a, b) => (b.runAt || 0) - (a.runAt || 0))
        .slice(0, 10);

      if (!entries.length)
        return interaction.reply({ content: "❌ لا يوجد Jobs.", flags: 64 });

      const lines = entries.map((j) => {
        const t = j.runAt ? `<t:${Math.floor(j.runAt / 1000)}:F>` : "N/A";
        const target =
          j.type === "channel"
            ? `<#${j.channelId}>`
            : `DM:${(j.dmMode || "all").toUpperCase()}`;
        return `• \`${j.jobId}\` | ${j.status} | ${target} | ${t}`;
      });

      return interaction.reply({
        content: `📄 آخر 10 Jobs:\n${lines.join("\n")}`,
        flags: 64,
      });
    }

    if (interaction.isButton() && interaction.customId === "jobs_cancel") {
      jobs = readJSON(JOBS_PATH, {});
      const keys = Object.keys(jobs).filter(
        (k) => jobs[k]?.status === "scheduled",
      );
      if (!keys.length)
        return interaction.reply({
          content: "❌ لا يوجد Jobs مجدولة للإلغاء.",
          flags: 64,
        });

      const menu = new StringSelectMenuBuilder()
        .setCustomId("select_job_cancel")
        .setPlaceholder("اختر Job لإلغائه")
        .addOptions(keys.slice(0, 25).map((k) => ({ label: k, value: k })));

      return interaction.reply({
        content: "🛑 اختر Job لإلغائه:",
        components: [new ActionRowBuilder().addComponents(menu)],
        flags: 64,
      });
    }

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId === "select_job_cancel"
    ) {
      const jobId = interaction.values[0];
      jobs = readJSON(JOBS_PATH, {});
      const job = jobs[jobId];
      if (!job)
        return interaction.reply({ content: "❌ Job غير موجود.", flags: 64 });

      job.status = "canceled";
      job.canceledAt = Date.now();
      jobs[jobId] = job;
      writeJSON(JOBS_PATH, jobs);

      const ctrl = sendControllers.get(jobId);
      if (ctrl) ctrl.canceled = true;

      return interaction.reply({
        content: `✅ تم إلغاء Job: \`${jobId}\``,
        flags: 64,
      });
    }
  } catch (err) {
    console.error("interaction error:", err);
    if (interaction.isRepliable()) {
      try {
        await interaction.reply({
          content: "❌ صار خطأ غير متوقع.",
          flags: 64,
        });
      } catch {}
    }
  }
});

// =============================
// API (optional) - Replit-ready
// =============================
if (config.api?.enabled) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // POST /broadcast
  // headers: x-api-key
  // body: { type:"channel"|"dm", guildId, channelId?, dmMode?, embedData, ctas?[] }
  app.post("/broadcast", async (req, res) => {
    try {
      const key = req.headers["x-api-key"];
      if (!key || key !== config.api.token) {
        return res.status(401).json({ ok: false, error: "unauthorized" });
      }

      const { type, guildId, channelId, dmMode, embedData, ctas } =
        req.body || {};

      if (!guildId || !embedData?.description) {
        return res.status(400).json({
          ok: false,
          error: "guildId + embedData.description required",
        });
      }

      const payload = {
        embedData: {
          title: String(embedData.title || "").slice(0, 256),
          description: String(embedData.description || "").slice(0, 4000),
          color: sanitizeHexColor(embedData.color || ""),
          imageUrl: isValidUrl(embedData.imageUrl || "")
            ? embedData.imageUrl
            : undefined,
          footer: String(embedData.footer || "").slice(0, 2048),
        },
        ctas: Array.isArray(ctas)
          ? ctas
              .filter((c) => c?.label && c?.url && isValidUrl(c.url))
              .slice(0, 25)
              .map((c) => ({
                label: String(c.label).slice(0, 80),
                url: String(c.url).trim(),
              }))
          : [],
      };

      const controllerKey = `api_${Date.now()}`;
      sendControllers.set(controllerKey, { canceled: false });

      if (type === "dm") {
        const r = await sendDMToMembers({
          guildId,
          mode: dmMode || "all",
          payload,
          controllerKey,
        });
        return res.json({ ok: true, result: r });
      }

      if (!channelId) {
        return res.status(400).json({
          ok: false,
          error: "channelId required for channel type",
        });
      }

      await sendToChannel({ guildId, channelId, payload, controllerKey });
      return res.json({ ok: true });
    } catch (e) {
      return res
        .status(500)
        .json({ ok: false, error: String(e?.message || e) });
    }
  });

  const PORT = process.env.PORT || config.api.port || 3000;
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🌐 API running on port ${PORT}`);
  });
}

// =============================
// Login
// =============================
client.login(config.TOKEN);
