export const attachmentHtml = '<p>Lab schedule</p><img src="https://tracker.invalid/attachment">';
export const attachmentCsv = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x2c, 0x80]);

export function attachmentPdf() {
  const text = 'BT /F1 18 Tf 40 140 Td (Bridge attachment fixture) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
  ];
  let source = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = source.length;
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  return Buffer.from(`${source}xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${source.length}\n%%EOF\n`);
}

export function mailWithAttachments() {
  const parts = [
    ['schedule.html', 'text/html', Buffer.from(attachmentHtml)],
    ['report.csv', 'text/csv; charset=windows-1252', attachmentCsv],
    ['summary.pdf', 'application/pdf', attachmentPdf()],
    ['chart.png', 'image/png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+fmioAAAAASUVORK5CYII=', 'base64')],
    ['data.bin', 'application/octet-stream', Buffer.from([1, 2, 0, 255])],
    ['notes.txt', 'text/plain', Buffer.alloc(1024 * 1024 + 1, 97)],
  ];
  return Buffer.from([
    'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="fixture"', '',
    '--fixture', 'Content-Type: text/plain; charset=utf-8', '', 'Fixture mail with attachments.',
    ...parts.flatMap(([filename, mimeType, bytes]) => [
      '--fixture', `Content-Type: ${mimeType}`, `Content-Disposition: attachment; filename="${filename}"`,
      'Content-Transfer-Encoding: base64', '', ...(bytes.toString('base64').match(/.{1,76}/gu) ?? []),
    ]),
    '--fixture--', '',
  ].join('\r\n'));
}
