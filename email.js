'use strict';

// Email a note via Gmail's SMTP using an App Password. This avoids the OAuth
// flow: create an App Password at https://myaccount.google.com/apppasswords
// (requires 2-Step Verification) and set GMAIL_USER + GMAIL_APP_PASSWORD.
const nodemailer = require('nodemailer');
const { marked } = require('marked');

// GFM (so markdown tables, ~~strikethrough~~, etc. render). No `breaks` — keep
// standard markdown paragraph behavior, matching the browser preview.
marked.setOptions({ gfm: true });

const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '465', 10) || 465;
const GMAIL_USER = process.env.GMAIL_USER || '';
// App Passwords are shown grouped in 4s ("abcd efgh ijkl mnop"); strip spaces.
const GMAIL_APP_PASSWORD = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');

// True once both the sending address and an App Password are present.
function isConfigured() {
  return Boolean(GMAIL_USER && GMAIL_APP_PASSWORD);
}

let transporter = null;
function getTransporter() {
  if (!isConfigured()) throw new Error('email not configured');
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465, // 465 = implicit TLS; 587 = STARTTLS
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });
  }
  return transporter;
}

// Render the note's markdown to a styled HTML email. We do two things for
// cross-client robustness: (1) a <style> block for general typography (Gmail,
// Apple Mail, etc. honor embedded styles), and (2) inline styles injected onto
// table/th/td, since tables are the formatting most likely to fall back to
// unstyled in stricter clients — this guarantees borders render everywhere.
// No text-align here — marked emits `align="…"` on aligned columns, and forcing
// text-align inline would override it. Default (left) renders fine without it.
const TABLE_STYLE = 'border-collapse:collapse;margin:1em 0;font-size:14px';
const CELL_STYLE = 'border:1px solid #d0d7de;padding:6px 12px';
const TH_STYLE = CELL_STYLE + ';background:#f6f8fa;font-weight:600';

// Render markdown to the styled email HTML. `images` maps an image id to
// { contentType, buffer }; any `<img src="/api/images/<id>">` whose id is in the
// map is rewritten to a `cid:` reference and returned as an inline attachment,
// so the picture renders in the recipient's inbox (the server URL wouldn't be
// reachable from there). Returns { html, attachments }.
function renderEmail(md, images) {
  let body = marked.parse(String(md || ''));
  // Inject inline styles. marked may emit `<th align="center">`, so match the
  // tag name followed by a space or `>` and insert the style attribute first.
  body = body
    .replace(/<table>/g, `<table style="${TABLE_STYLE}">`)
    .replace(/<th(\s|>)/g, `<th style="${TH_STYLE}"$1`)
    .replace(/<td(\s|>)/g, `<td style="${CELL_STYLE}"$1`);

  const attachments = [];
  body = body.replace(/src="\/api\/images\/([0-9a-fA-F]{24})"/g, (full, id) => {
    const img = images && images[id];
    if (!img) return full; // unknown/deleted image — leave the URL as-is
    const cid = `img-${id}`;
    if (!attachments.some((a) => a.cid === cid)) {
      attachments.push({
        filename: id,
        content: img.buffer,
        contentType: img.contentType || 'application/octet-stream',
        cid,
        contentDisposition: 'inline',
      });
    }
    return `src="cid:${cid}"`;
  });

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>
  .note-body { font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    color:#24292f; font-size:15px; line-height:1.6; max-width:680px; margin:0 auto; padding:8px 4px; }
  .note-body h1,.note-body h2,.note-body h3,.note-body h4 { line-height:1.25; margin:1.2em 0 .5em; }
  .note-body h1 { font-size:1.6em; border-bottom:1px solid #e1e4e8; padding-bottom:.2em; }
  .note-body h2 { font-size:1.3em; border-bottom:1px solid #eaecef; padding-bottom:.2em; }
  .note-body code { background:#f0f2f4; padding:.15em .35em; border-radius:4px;
    font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:.9em; }
  .note-body pre { background:#f6f8fa; padding:12px; border-radius:6px; overflow:auto; }
  .note-body pre code { background:none; padding:0; }
  .note-body blockquote { margin:0; padding:0 1em; color:#6a737d; border-left:3px solid #dfe2e5; }
  .note-body table { border-collapse:collapse; margin:1em 0; }
  .note-body th,.note-body td { border:1px solid #d0d7de; padding:6px 12px; }
  .note-body th { background:#f6f8fa; }
  .note-body img { max-width:100%; }
  .note-body a { color:#0969da; }
</style>
</head>
<body><div class="note-body">${body}</div></body>
</html>`;
  return { html, attachments };
}

// Send one note. `to` may be a comma-separated list (nodemailer accepts that).
// `images` (optional) maps image id -> { contentType, buffer } for inlining.
async function sendNoteEmail({ to, subject, markdown, images }) {
  const { html, attachments } = renderEmail(markdown, images || {});
  const info = await getTransporter().sendMail({
    from: GMAIL_USER,
    to,
    subject,
    text: markdown,
    html,
    attachments,
  });
  return info.messageId;
}

module.exports = { isConfigured, sendNoteEmail, from: GMAIL_USER };
