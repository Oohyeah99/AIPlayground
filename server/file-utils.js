/**
 * file-utils.js — Preprocess message attachments (images, PDFs, docs)
 * Extracts text from documents and normalizes image data for providers.
 */
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

function isImage(mime) {
  return mime && mime.startsWith('image/');
}

async function extractText(attachment) {
  const buffer = Buffer.from(attachment.data, 'base64');

  if (attachment.mime === 'application/pdf') {
    const result = await pdfParse(buffer);
    return result.text;
  }

  if (
    attachment.mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    attachment.mime === 'application/msword'
  ) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (attachment.mime === 'text/plain' || attachment.mime === 'text/markdown') {
    return buffer.toString('utf-8');
  }

  return null;
}

/**
 * Takes messages array (with optional .attachments on each message) and returns
 * processed messages where:
 *  - Document text is extracted and prepended to .content
 *  - Images are collected into .images array: [{ data, mime }]
 */
async function preprocessMessages(messages) {
  const processed = [];

  for (const msg of messages) {
    const newMsg = { role: msg.role, content: msg.content || '' };

    if (msg.attachments && msg.attachments.length > 0) {
      const images = [];
      const textParts = [];

      for (const att of msg.attachments) {
        if (isImage(att.mime)) {
          images.push({ data: att.data, mime: att.mime });
        } else {
          try {
            const text = await extractText(att);
            if (text) {
              textParts.push(`[File: ${att.name}]\n${text}\n[End of file]`);
            }
          } catch (err) {
            textParts.push(`[File: ${att.name}]\n(Could not extract text: ${err.message})\n[End of file]`);
          }
        }
      }

      if (textParts.length > 0) {
        newMsg.content = textParts.join('\n\n') + '\n\n' + newMsg.content;
      }
      if (images.length > 0) {
        newMsg.images = images;
      }
    }

    processed.push(newMsg);
  }

  return processed;
}

module.exports = { preprocessMessages, isImage };
