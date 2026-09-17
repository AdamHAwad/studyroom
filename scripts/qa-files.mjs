import fs from 'node:fs';
const { course } = JSON.parse(fs.readFileSync('data/qa/receipt.json'));
const results = [];
for (const name of ['geometry.pdf', 'geometry.docx', 'geometry.pptx', 'scanned.pdf']) {
  const begin = Date.now();
  const body = new FormData();
  body.append('file', new Blob([fs.readFileSync('tests/fixtures/' + name)]), name);
  const source = await (
    await fetch(`http://localhost:3211/api/courses/${course.id}/upload`, { method: 'POST', body })
  ).json();
  results.push(source);
  console.log(
    JSON.stringify({
      name,
      status: source.status,
      assets: source.assetIds?.length,
      warnings: source.warnings,
      error: source.error,
      elapsedSeconds: (Date.now() - begin) / 1000,
    }),
  );
}
fs.writeFileSync('data/qa/file-results.json', JSON.stringify(results, null, 2));
