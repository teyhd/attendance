import { existsSync } from 'node:fs';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import { emptyStudentExportMessage, STUDENT_EXPORT_MODE_LABELS } from './student-attendance-export.mjs';

const margin = 36;
const ink = '#17243A';
const muted = '#4B5A70';
const accent = '#234B78';
const rule = '#D7DFE9';
const rowLine = 12;
const dateWidth = 73;
const timeWidth = 85;
const subjectWidth = 143;

function selectFont(fontPath) {
  const candidates = [
    fontPath || process.env.ATTENDANCE_PDF_FONT,
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    join(process.env.WINDIR || 'C:/Windows', 'Fonts', 'arial.ttf'),
  ];
  const found = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!found) throw new Error('Не найден шрифт для PDF с поддержкой кириллицы.');
  return found;
}

function displayDate(value) {
  const text = String(value ?? '');
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  return iso ? `${iso[3]}.${iso[2]}.${iso[1]}` : text;
}

function wrap(doc, value, width) {
  const lines = [];
  for (const paragraph of String(value ?? '').split(/\r?\n/)) {
    let line = '';
    for (const word of paragraph.trim().split(/\s+/)) {
      const combined = line ? `${line} ${word}` : word;
      if (doc.widthOfString(combined) <= width) {
        line = combined;
        continue;
      }
      if (line) lines.push(line);
      line = '';
      if (doc.widthOfString(word) <= width) {
        line = word;
        continue;
      }
      for (const glyph of word) {
        if (line && doc.widthOfString(line + glyph) > width) {
          lines.push(line);
          line = '';
        }
        line += glyph;
      }
    }
    lines.push(line);
  }
  return lines;
}

function rowDetails(row) {
  const metrics = [
    [row.confirmedMinutes, 'Пропуск'],
    [row.unknownMinutes, 'Нет данных'],
    [row.lateMinutes, 'Опоздание'],
  ].filter(([minutes]) => Number.isFinite(minutes) && minutes > 0)
    .map(([minutes, label]) => `${label} ${minutes} мин`);
  return [row.status || 'Нет данных', metrics.join(' · '), row.reason].filter(Boolean).join('\n');
}

function drawReport(doc, report) {
  let page = 0;
  let y;
  let width;
  let bottom;
  let columns;

  function writeLine(value, x, top, size, color = ink) {
    doc.fontSize(size).fillColor(color).text(value, x, top, { lineBreak: false });
  }

  function pageFooter() {
    const top = doc.page.height - margin - 11;
    doc.lineWidth(.5).strokeColor(rule).moveTo(margin, top - 5).lineTo(margin + width, top - 5).stroke();
    writeLine('Посещаемость · школьный отчёт', margin, top, 8, muted);
    const pageLabel = `Страница ${page}`;
    doc.fontSize(8);
    writeLine(pageLabel, margin + width - doc.widthOfString(pageLabel), top, 8, muted);
  }

  function newPage() {
    if (page) pageFooter();
    doc.addPage();
    page++;
    width = doc.page.width - 2 * margin;
    bottom = doc.page.height - margin - 26;
    columns = [dateWidth, timeWidth, subjectWidth, width - dateWidth - timeWidth - subjectWidth];
    y = margin;
    if (page > 1) {
      writeLine('Посещаемость по урокам', margin, y, 11, accent);
      y += 21;
    }
  }

  function paragraph(value, size, leading, color, spacing = 7) {
    doc.fontSize(size);
    for (const line of wrap(doc, value, width)) {
      if (y + leading > bottom) newPage();
      writeLine(line, margin, y, size, color);
      y += leading;
    }
    y += spacing;
  }

  function tableHeader() {
    if (y + 43 > bottom) newPage();
    doc.rect(margin, y, width, 23).fill(accent);
    let x = margin;
    ['Дата', 'Время', 'Предмет', 'Статус и детали'].forEach((label, i) => {
      writeLine(label, x + 8, y + 6, 9, '#FFFFFF');
      x += columns[i];
    });
    y += 23;
  }

  function tableRow(row, index) {
    const time = [row.start, row.end].filter(Boolean).join(' - ');
    doc.fontSize(9);
    const cells = [displayDate(row.date), time || '-', row.subject || '-', rowDetails(row)]
      .map((value, i) => wrap(doc, value, columns[i] - 16));
    const count = Math.max(...cells.map((lines) => lines.length));
    let offset = 0;
    while (offset < count) {
      let available = Math.floor((bottom - y - 12) / rowLine);
      if (available < 1 || (offset === 0 && available < Math.min(count, 3))) {
        newPage();
        tableHeader();
        available = Math.floor((bottom - y - 12) / rowLine);
      }
      const lines = Math.min(available, count - offset);
      const height = lines * rowLine + 12;
      if (index % 2 === 0) doc.rect(margin, y, width, height).fill('#F4F7FB');
      let x = margin;
      cells.forEach((cell, i) => {
        cell.slice(offset, offset + lines).forEach((line, j) => {
          writeLine(line, x + 8, y + 6 + j * rowLine, 9, i < 2 ? muted : ink);
        });
        x += columns[i];
      });
      y += height;
      doc.lineWidth(.4).strokeColor(rule).moveTo(margin, y).lineTo(margin + width, y).stroke();
      offset += lines;
    }
  }

  newPage();
  paragraph('Посещаемость по урокам', 23, 28, ink, 5);
  paragraph([report.student.name, report.student.className ? `Класс ${report.student.className}` : ''].filter(Boolean).join(' · '), 13, 17, ink);
  paragraph(`${displayDate(report.from)} - ${displayDate(report.to)} · ${STUDENT_EXPORT_MODE_LABELS[report.mode]}`, 10, 14, accent, 11);
  paragraph('Уроки без данных об участии не считаются подтверждёнными пропусками.', 9, 12, muted, 5);
  if (report.unconfirmedLessons > 0) paragraph(`Уроков без подтверждения или с расхождениями: ${report.unconfirmedLessons}.`, 9, 12, muted, 5);
  if (report.missingScheduleDates?.length) {
    paragraph(`Нет данных расписания: ${report.missingScheduleDates.map(displayDate).join(', ')}.`, 9, 12, muted, 5);
  }
  if (report.unplacedAbsenceDays?.length) {
    paragraph(`Отсутствие отмечено, но распределить его по урокам невозможно: ${report.unplacedAbsenceDays.map(displayDate).join(', ')}.`, 9, 12, muted, 5);
  }
  y += 5;
  if (report.rows.length) {
    tableHeader();
    report.rows.forEach(tableRow);
  } else {
    paragraph(emptyStudentExportMessage(report.mode), 11, 14, ink);
  }
  pageFooter();
}

export async function renderStudentAttendancePdf(report, { fontPath } = {}) {
  const font = selectFont(fontPath);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin,
      autoFirstPage: false,
      info: { Title: 'Посещаемость по урокам', Author: 'Посещаемость' },
    });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.once('error', reject);
    doc.once('end', () => resolve(Buffer.concat(chunks)));
    try {
      doc.font(font);
      drawReport(doc, report);
      doc.end();
    } catch (error) {
      doc.destroy();
      reject(error);
    }
  });
}
