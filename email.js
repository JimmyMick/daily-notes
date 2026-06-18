'use strict';

// Email a note via Gmail's SMTP using an App Password. This avoids the OAuth
// flow: create an App Password at https://myaccount.google.com/apppasswords
// (requires 2-Step Verification) and set GMAIL_USER + GMAIL_APP_PASSWORD.
const nodemailer = require('nodemailer');

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

// Wrap the raw markdown in a whitespace-preserving <pre> so the note's
// formatting survives in HTML mail clients. We send the markdown source as-is
// (the plain-text part) rather than rendering it, which keeps deps minimal and
// is honest about what the note actually contains.
function mdToHtml(md) {
  const esc = String(md)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return (
    '<pre style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;' +
    'white-space:pre-wrap;word-wrap:break-word;font-size:14px;line-height:1.5">' +
    esc +
    '</pre>'
  );
}

// Send one note. `to` may be a comma-separated list (nodemailer accepts that).
async function sendNoteEmail({ to, subject, markdown }) {
  const t = getTransporter();
  const info = await t.sendMail({
    from: GMAIL_USER,
    to,
    subject,
    text: markdown,
    html: mdToHtml(markdown),
  });
  return info.messageId;
}

module.exports = { isConfigured, sendNoteEmail, from: GMAIL_USER };
